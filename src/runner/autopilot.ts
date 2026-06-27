import { promises as fs } from "node:fs";
import { bus, type AutopilotStatus } from "../core/events.js";
import { blockedTicketIds, getTicket, listTickets, updateTicket } from "../core/board.js";
import { loadProjectConfig } from "../core/project.js";
import { autopilotIntentPath } from "../core/paths.js";
import { checkUsageBudget } from "./budget.js";
import {
  DispatchQueue,
  executorFor,
  planAssignments,
  runningCompanionId,
  type Assignment,
  type WorkItem,
} from "./dispatch.js";
import { classifyFailure, decideRetry, retryPolicyFromEnv, type RetryPolicy } from "./retry.js";
import type { ProjectConfig, Ticket } from "../core/types.js";
import type { Run, RunManager } from "./manager.js";
import type { WorkerRegistry } from "../server/workers.js";

/** Label put on a ticket that's been dead-lettered, so it's visible on the board. */
const STUCK_LABEL = "stuck";

/** Read the persisted autopilot intent for a project (whether it was running). */
export async function loadAutopilotIntent(projectRoot: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(autopilotIntentPath(projectRoot), "utf8");
    return (JSON.parse(raw) as { running?: boolean }).running === true;
  } catch {
    return false;
  }
}

async function saveIntent(projectRoot: string, running: boolean): Promise<void> {
  try {
    await fs.writeFile(autopilotIntentPath(projectRoot), JSON.stringify({ running }) + "\n", "utf8");
  } catch {
    /* non-fatal — state is still correct in memory */
  }
}

function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// How long to wait between polls when idle / paused, and to breathe between tickets.
const IDLE_POLL_MS = () => envMs("MYSTERON_AUTOPILOT_IDLE_MS", 15_000);
const BUDGET_RECHECK_MS = () => envMs("MYSTERON_AUTOPILOT_BUDGET_MS", 30_000);
const BREATHER_MS = () => envMs("MYSTERON_AUTOPILOT_BREATHER_MS", 1_500);

const MAX_ACTIVITY = 50;

export interface AutopilotState {
  projectId: string;
  projectRoot: string;
  status: AutopilotStatus;
  message: string;
  currentTicketId?: string;
  currentRunId?: string;
  pausedUntil?: string;
  completed: number;
  startedAt: string;
  activity: { at: string; text: string }[];
  /** Live dispatch-queue snapshot, refreshed each tick (observability). */
  queue: { depth: number; inFlight: number; maxWaitMs: number };
  /** Tickets dead-lettered (parked for a human) this session — see the retry policy. */
  deadLettered: number;
}

/**
 * Drives a project's board autonomously: pulls the next ready ticket, runs an
 * agent on it, and moves on — pausing when the Claude usage budget is reached
 * and resuming after the window resets. This is the "yolo autopilot": set up a
 * board and leave it churning within your account limits.
 */
export class Autopilot {
  private states = new Map<string, AutopilotState>();
  private stopFlags = new Map<string, boolean>();

  constructor(
    private runs: RunManager,
    private workers: WorkerRegistry,
    private policy: RetryPolicy = retryPolicyFromEnv(),
  ) {}

  status(projectId: string): AutopilotState | undefined {
    return this.states.get(projectId);
  }

  isActive(projectId: string): boolean {
    const s = this.states.get(projectId);
    return Boolean(s && s.status !== "stopped");
  }

  start(projectId: string, projectRoot: string): AutopilotState {
    const existing = this.states.get(projectId);
    if (existing && existing.status !== "stopped") return existing;

    const state: AutopilotState = {
      projectId,
      projectRoot,
      status: "running",
      message: "Starting…",
      completed: 0,
      startedAt: new Date().toISOString(),
      activity: [],
      queue: { depth: 0, inFlight: 0, maxWaitMs: 0 },
      deadLettered: 0,
    };
    this.states.set(projectId, state);
    this.stopFlags.set(projectId, false);
    void saveIntent(projectRoot, true);
    void this.reconcileOrphans(projectId, projectRoot, state);
    this.set(state, "running", "Autopilot started.");
    void this.loop(state);
    return state;
  }

  stop(projectId: string): boolean {
    const state = this.states.get(projectId);
    if (!state || state.status === "stopped") return false;
    this.stopFlags.set(projectId, true);
    void saveIntent(state.projectRoot, false);
    this.set(state, "stopped", "Autopilot stopped.");
    return true;
  }

  /**
   * Move any `in-progress` ticket that has no live run back to `ready` so the
   * autopilot can pick it up again. Called on start so orphans left by a crash or
   * server restart are reconciled immediately rather than sitting stranded.
   */
  private async reconcileOrphans(projectId: string, projectRoot: string, state: AutopilotState): Promise<void> {
    try {
      const inProgress = await listTickets(projectRoot, { state: "in-progress" });
      for (const ticket of inProgress) {
        if (!this.runs.activeForTicket(projectId, ticket.id)) {
          await updateTicket(projectRoot, ticket.id, { state: "ready" });
          this.addActivity(state, `↺ requeued orphaned ticket: ${ticket.title}`);
        }
      }
    } catch {
      /* non-fatal — autopilot loop will pick up ready tickets anyway */
    }
  }

  private async loop(state: AutopilotState): Promise<void> {
    // One queue per loop: the board's ready column is reconciled into it each
    // tick, and it owns in-flight dedup, depth and wait-time (no per-tick run scan).
    const queue = new DispatchQueue();
    while (!this.stopFlags.get(state.projectId)) {
      const config = await loadProjectConfig(state.projectRoot);
      if (!config) {
        this.set(state, "idle", "Project is not initialised.");
        await this.sleep(state, IDLE_POLL_MS());
        continue;
      }

      // When the host's Claude budget is maxed it can't run locally, so the
      // planner offloads only to guests until the window resets.
      const budget = await checkUsageBudget(state.projectRoot, config);
      const hostMaxed = !!(budget && !budget.safeToContinue);

      // Reconcile the queue with the board: ready, unblocked, not already in flight.
      const ready = await listTickets(state.projectRoot, { state: "ready" });
      const blocked = await blockedTicketIds(state.projectRoot);
      queue.sync(ready.filter((t) => !blocked.has(t.id)));

      // Plan one tick of work across idle guests + free local companions, then
      // start each through its executor — one uniform dispatch path.
      const idleWorkers = this.workers.idle().map((w) => ({ id: w.id, label: w.label }));
      const plan = planAssignments({
        queued: queue.eligible(),
        config,
        idleWorkers,
        hostMaxed,
        isCompanionBusy: (id) => queue.isCompanionBusy(id),
      });
      for (const assignment of plan) {
        if (this.stopFlags.get(state.projectId)) break;
        this.dispatch(state, config, queue, assignment);
      }

      state.queue = { depth: queue.depth(), inFlight: queue.inFlight(), maxWaitMs: queue.maxWaitMs() };

      if (hostMaxed && budget) {
        const resetWhen = budget.resetAt ? new Date(budget.resetAt).toLocaleTimeString() : "the end of the window";
        const offloaded = plan.some((a) => a.target.kind === "guest");
        this.set(
          state,
          "paused",
          `Usage budget reached (${budget.percentUsed}%).${offloaded ? " Offloading ready work to guests." : ""} Local companions wait for the window to reset around ${resetWhen}.`,
          { pausedUntil: budget.resetAt },
        );
        await this.sleep(state, BUDGET_RECHECK_MS());
        continue;
      }

      const working = queue.inFlight();
      if (working > 0) this.set(state, "running", `${working} companion(s) working.`);
      else this.set(state, "idle", "No ready tickets for a free companion — waiting for work.");

      // Tick quickly while there's work (so a freed companion picks up its next
      // ticket promptly); poll slowly when fully idle.
      await this.sleep(state, plan.length || working ? BREATHER_MS() : IDLE_POLL_MS());
    }
    if (state.status !== "stopped") this.set(state, "stopped", "Autopilot stopped.");
  }

  /**
   * Start one planned assignment through its executor and wire its lifecycle back
   * to the queue and the retry policy: a finished run that landed releases the
   * claim; a failure is classified (transient vs clean) and either requeued with a
   * backoff or, past the cap, dead-lettered. Doesn't block the tick — other
   * assignments dispatch concurrently.
   */
  private dispatch(state: AutopilotState, config: ProjectConfig, queue: DispatchQueue, assignment: Assignment): void {
    const { item, target } = assignment;
    const ticket = item.ticket;
    const who = target.kind === "guest" ? target.label : config.companions.find((c) => c.id === target.companionId)?.name ?? "companion";
    const icon = target.kind === "guest" ? "☁" : "▶";
    const ctx = { projectId: state.projectId, projectRoot: state.projectRoot, config };
    const executor = executorFor(target, this.runs, this.workers, ctx);
    queue.claim(ticket.id, runningCompanionId(config, ticket));

    executor
      .start(ticket)
      .then((run) => {
        if (!run) {
          // Couldn't even start (e.g. the guest vanished) — transient, retry it.
          void this.handleFailure(state, queue, item, who, "retryable", "could not start");
          return;
        }
        this.addActivity(state, `${icon} ${who} → ${ticket.title}`);
        void this.runs.waitFor(run.id).then((finished) => this.onFinished(state, queue, item, who, finished));
      })
      .catch((err) => {
        void this.handleFailure(state, queue, item, who, "retryable", (err as Error).message);
      });
  }

  /** Route a finished run: landed → release; stopped by a human → drop; failure → retry policy. */
  private onFinished(state: AutopilotState, queue: DispatchQueue, item: WorkItem, who: string, run: Run): void {
    const ticket = item.ticket;
    // "done" with the patch landed is the only success. A "done" run whose patch
    // wouldn't apply (landFailed) bounced the ticket back to ready — that's a failure.
    if (run.status === "done" && !run.landFailed) {
      state.completed++;
      queue.release(ticket.id);
      this.addActivity(state, `✓ ${who}: ${ticket.title} — done`);
      this.set(state, state.status, state.message);
      return;
    }
    if (run.status === "stopped") {
      // A human stopped this run — don't count it against the retry cap. The ticket
      // is left wherever stop put it; releasing the claim lets the board govern it.
      queue.release(ticket.id);
      this.addActivity(state, `■ ${who}: ${ticket.title} — stopped`);
      this.set(state, state.status, state.message);
      return;
    }
    const reason = run.limitHit
      ? "usage limit"
      : run.streamStalled
        ? "stream stalled"
        : run.landFailed
          ? "patch did not apply"
          : "agent failed";
    void this.handleFailure(state, queue, item, who, classifyFailure(run), reason);
  }

  /**
   * Apply the retry policy to a failed attempt: requeue with a backoff while under
   * the cap, or dead-letter the ticket (park it on `backlog` with a `stuck` label +
   * a note) once the cap is reached, so the board never spins on one card forever.
   *
   * The claim is held across the board write and only released afterwards, so a
   * concurrent {@link DispatchQueue.sync} can't re-add or drop the item mid-flight.
   */
  private async handleFailure(
    state: AutopilotState,
    queue: DispatchQueue,
    item: WorkItem,
    who: string,
    kind: ReturnType<typeof classifyFailure>,
    reason: string,
  ): Promise<void> {
    const ticket = item.ticket;
    const attempts = item.attempts + 1; // this attempt is now spent
    const decision = decideRetry({ kind, attempts, policy: this.policy });
    if (decision.action === "dead-letter") {
      // Park it (still claimed, so it's protected from sync), then release.
      await this.deadLetter(state, ticket, attempts, kind, reason).catch(() => undefined);
      queue.release(ticket.id);
      state.deadLettered++;
      this.addActivity(state, `⚠ ${who}: ${ticket.title} — parked (stuck) · ${reason} · ${decision.reason}`);
    } else {
      // Promote the ticket back to ready so the retry is dispatchable (still claimed
      // while we write), then requeue with the backoff holding it out until due.
      // (Transient failures already bounced it to ready; this also rescues a clean
      // failure that was left parked in-progress.)
      await updateTicket(state.projectRoot, ticket.id, { state: "ready" }).catch(() => undefined);
      queue.requeue(ticket.id, decision.delayMs);
      const secs = Math.round(decision.delayMs / 1000);
      this.addActivity(state, `↻ ${who}: ${ticket.title} — ${reason}, retry ${attempts}/${this.cap(kind)} in ${secs}s`);
    }
    this.set(state, state.status, state.message);
  }

  /** The attempt cap for a failure kind (for activity messages). */
  private cap(kind: ReturnType<typeof classifyFailure>): number {
    return kind === "retryable" ? this.policy.maxAttempts : this.policy.maxNonRetryableAttempts;
  }

  /**
   * Park a ticket the policy has given up on: move it to `backlog`, add the `stuck`
   * label, and append a note recording why and how many attempts it took, so a human
   * can see it on the board and pick it up. Keeping it off `ready` stops the autopilot
   * re-dispatching it.
   */
  private async deadLetter(
    state: AutopilotState,
    ticket: Ticket,
    attempts: number,
    kind: ReturnType<typeof classifyFailure>,
    reason: string,
  ): Promise<void> {
    const current = (await getTicket(state.projectRoot, ticket.id)) ?? ticket;
    const labels = current.labels.includes(STUCK_LABEL) ? current.labels : [...current.labels, STUCK_LABEL];
    const note = [
      `> ⚠ **Stuck — parked by autopilot** (${new Date().toISOString()})`,
      `> Gave up after ${attempts} ${kind} attempt(s): ${reason}. A human should take a look.`,
    ].join("\n");
    const body = current.body.includes("Stuck — parked by autopilot")
      ? current.body
      : `${current.body.trim()}\n\n${note}`;
    await updateTicket(state.projectRoot, ticket.id, { state: "backlog", labels, body });
    bus.emitEvent({ type: "board-changed", projectId: state.projectId, detail: ticket.id });
  }

  /** Sleep in small steps so stop() takes effect promptly. */
  private async sleep(state: AutopilotState, ms: number): Promise<void> {
    const step = 500;
    let waited = 0;
    while (waited < ms && !this.stopFlags.get(state.projectId)) {
      await new Promise((r) => setTimeout(r, step));
      waited += step;
    }
  }

  private set(
    state: AutopilotState,
    status: AutopilotStatus,
    message: string,
    extra?: { currentTicketId?: string; pausedUntil?: string },
  ): void {
    state.status = status;
    state.message = message;
    if (extra && "currentTicketId" in extra) state.currentTicketId = extra.currentTicketId;
    if (extra && "pausedUntil" in extra) state.pausedUntil = extra.pausedUntil;
    if (status !== "paused") state.pausedUntil = undefined;
    bus.emitAutopilot({
      projectId: state.projectId,
      status,
      message,
      currentTicketId: state.currentTicketId,
      currentRunId: state.currentRunId,
      completed: state.completed,
    });
  }

  private addActivity(state: AutopilotState, text: string): void {
    state.activity.unshift({ at: new Date().toISOString(), text });
    if (state.activity.length > MAX_ACTIVITY) state.activity.length = MAX_ACTIVITY;
  }
}
