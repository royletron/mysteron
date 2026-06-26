import { bus, type AutopilotStatus } from "../core/events.js";
import { blockedTicketIds, listTickets, nextTicketForCompanion } from "../core/board.js";
import { companionAllowsGuest, companionAllowsLocal, getCompanion } from "../core/companions.js";
import { loadProjectConfig } from "../core/project.js";
import { checkUsageBudget } from "./budget.js";
import type { ProjectConfig } from "../core/types.js";
import type { RunManager } from "./manager.js";
import type { WorkerRegistry } from "../server/workers.js";

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
    };
    this.states.set(projectId, state);
    this.stopFlags.set(projectId, false);
    this.set(state, "running", "Autopilot started.");
    void this.loop(state);
    return state;
  }

  stop(projectId: string): boolean {
    const state = this.states.get(projectId);
    if (!state || state.status === "stopped") return false;
    this.stopFlags.set(projectId, true);
    this.set(state, "stopped", "Autopilot stopped.");
    return true;
  }

  private async loop(state: AutopilotState): Promise<void> {
    while (!this.stopFlags.get(state.projectId)) {
      const config = await loadProjectConfig(state.projectRoot);
      if (!config) {
        this.set(state, "idle", "Project is not initialised.");
        await this.sleep(state, IDLE_POLL_MS());
        continue;
      }

      // 1) Check the host's usage budget up front: when it's maxed the host
      //    can't run locally, so guests absorb the work instead of it stalling.
      const budget = await checkUsageBudget(state.projectRoot, config);
      const hostMaxed = !!(budget && !budget.safeToContinue);

      // 2) Fan ready tickets out to connected guests. Guests run on their own
      //    machine + Claude account, so they work regardless of the host's
      //    budget. Normally they take only unassigned tickets; when the host is
      //    maxed they also pick up companion-assigned ones (see fanOutToGuests).
      const guestWork = await this.fanOutToGuests(state, config, hostMaxed);

      // 3) If the host is maxed, pause local companions until the window resets
      //    — the guests handled above keep the board moving in the meantime.
      if (hostMaxed && budget) {
        const resetWhen = budget.resetAt ? new Date(budget.resetAt).toLocaleTimeString() : "the end of the window";
        this.set(
          state,
          "paused",
          `Usage budget reached (${budget.percentUsed}%).${guestWork ? " Offloading ready work to guests." : ""} Local companions wait for the window to reset around ${resetWhen}.`,
          { pausedUntil: budget.resetAt },
        );
        await this.sleep(state, BUDGET_RECHECK_MS());
        continue;
      }

      // 4) Per companion: if it's free, dispatch its next ready ticket. Each
      //    companion does one task at a time; the soloist also takes unassigned ones.
      let anyWork = guestWork;
      for (const companion of config.companions) {
        if (this.stopFlags.get(state.projectId)) break;
        if (this.runs.activeForCompanion(state.projectId, companion.id)) {
          anyWork = true;
          continue;
        }
        // A companion pinned away from "local" runs on guests only — the guest
        // fan-out above picks up its tickets; don't start it on this machine.
        if (!companionAllowsLocal(companion)) continue;
        const ticket = await nextTicketForCompanion(state.projectRoot, companion.id, {
          includeUnassigned: companion.role === "soloist",
        });
        if (!ticket) continue;
        anyWork = true;
        try {
          const run = await this.runs.start({
            projectId: state.projectId,
            projectRoot: state.projectRoot,
            config,
            ticket,
          });
          this.addActivity(state, `▶ ${companion.name} → ${ticket.title}`);
          // Log completion without blocking the tick (so other companions dispatch).
          void this.runs.waitFor(run.id).then((finished) => {
            if (finished.status === "done") state.completed++;
            const icon = finished.status === "done" ? "✓" : finished.status === "stopped" ? "■" : "✖";
            this.addActivity(state, `${icon} ${companion.name}: ${ticket.title} — ${finished.status}`);
            this.set(state, state.status, state.message);
          });
        } catch (err) {
          this.addActivity(state, `✖ ${companion.name}: ${(err as Error).message}`);
        }
      }

      const busy = this.runs.busyCompanionIds(state.projectId).length;
      if (busy > 0) this.set(state, "running", `${busy} companion(s) working.`);
      else this.set(state, "idle", "No ready tickets for a free companion — waiting for work.");

      // Tick quickly while there's work (so a freed companion picks up its next
      // ticket promptly); poll slowly when fully idle.
      await this.sleep(state, anyWork ? BREATHER_MS() : IDLE_POLL_MS());
    }
    if (state.status !== "stopped") this.set(state, "stopped", "Autopilot stopped.");
  }

  /**
   * Hand ready tickets to idle guest workers (one each). Normally guests take
   * only unassigned tickets, so they never steal a local companion's assigned
   * work. When `hostMaxed` is true the host can't run locally anyway, so guests
   * also absorb companion-assigned tickets to keep the board moving. Either way
   * a ticket already running (locally or on a guest) is skipped via activeForTicket.
   */
  private async fanOutToGuests(state: AutopilotState, config: ProjectConfig, hostMaxed: boolean): Promise<boolean> {
    const idleWorkers = this.workers.idle();
    if (idleWorkers.length === 0) return false;
    const ready = await listTickets(state.projectRoot, { state: "ready" });
    const blocked = await blockedTicketIds(state.projectRoot);
    const companionFor = (t: { companionId?: string }) =>
      t.companionId ? getCompanion(config, t.companionId) : undefined;
    const free = ready.filter((t) => {
      if (blocked.has(t.id) || this.runs.activeForTicket(state.projectId, t.id)) return false;
      // Unassigned tickets fan out to guests as before. A companion-assigned ticket
      // goes to a guest when the host is maxed, or when its companion is pinned away
      // from local (so guests are the only place it can run).
      if (!t.companionId) return true;
      return hostMaxed || !companionAllowsLocal(companionFor(t));
    });
    let dispatched = false;
    for (const worker of idleWorkers) {
      if (this.stopFlags.get(state.projectId)) break;
      // Take the first free ticket this guest is allowed to run (respecting the
      // companion's "runs on" pin); skip the worker if none fit.
      const idx = free.findIndex((t) => companionAllowsGuest(companionFor(t), worker.label));
      if (idx < 0) continue;
      const [ticket] = free.splice(idx, 1);
      try {
        const run = await this.runs.startOnWorker(
          { projectId: state.projectId, projectRoot: state.projectRoot, config, ticket },
          this.workers,
          { id: worker.id, label: worker.label },
        );
        dispatched = true;
        this.addActivity(state, `☁ ${worker.label} → ${ticket.title}`);
        if (run) {
          void this.runs.waitFor(run.id).then((finished) => {
            if (finished.status === "done") state.completed++;
            const icon = finished.status === "done" ? "✓" : finished.status === "stopped" ? "■" : "✖";
            this.addActivity(state, `${icon} ${worker.label}: ${ticket.title} — ${finished.status}`);
            this.set(state, state.status, state.message);
          });
        }
      } catch (err) {
        this.addActivity(state, `✖ ${worker.label}: ${(err as Error).message}`);
      }
    }
    return dispatched;
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
