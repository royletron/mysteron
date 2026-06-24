import { bus, type AutopilotStatus } from "../core/events.js";
import { nextTicketForCompanion } from "../core/board.js";
import { loadProjectConfig } from "../core/project.js";
import { usageMonitorPlugin } from "../plugins/usage-monitor/index.js";
import type { ProjectConfig } from "../core/types.js";
import type { RunManager } from "./manager.js";

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

interface BudgetResult {
  safeToContinue: boolean;
  percentUsed: number;
  resetAt?: string;
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

  constructor(private runs: RunManager) {}

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

      // 1) Respect the usage budget — pause all companions until the window resets.
      const budget = await this.checkBudget(state.projectRoot, config);
      if (budget && !budget.safeToContinue) {
        this.set(
          state,
          "paused",
          `Usage budget reached (${budget.percentUsed}%). Waiting for the window to reset around ${budget.resetAt ? new Date(budget.resetAt).toLocaleTimeString() : "the end of the window"}.`,
          { pausedUntil: budget.resetAt },
        );
        await this.sleep(state, BUDGET_RECHECK_MS());
        continue;
      }

      // 2) Per companion: if it's free, dispatch its next ready ticket. Each
      //    companion does one task at a time; the soloist also takes unassigned ones.
      let anyWork = false;
      for (const companion of config.companions) {
        if (this.stopFlags.get(state.projectId)) break;
        if (this.runs.activeForCompanion(state.projectId, companion.id)) {
          anyWork = true;
          continue;
        }
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

  private async checkBudget(
    projectRoot: string,
    config: ProjectConfig,
  ): Promise<BudgetResult | undefined> {
    if (!config.plugins.includes("usage-monitor")) return undefined;
    const tools = usageMonitorPlugin.tools?.({ projectRoot, config }) ?? [];
    const tool = tools.find((t) => t.name === "check_usage_budget");
    if (!tool) return undefined;
    try {
      return (await tool.handler({}, { projectRoot, config })) as BudgetResult;
    } catch {
      return undefined;
    }
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
