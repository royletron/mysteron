// API client + shared types for the Henson web UI. Types mirror the server's
// JSON responses (see src/server/api.ts).

export type TicketState = "backlog" | "ready" | "in-progress" | "review" | "done";
export type TicketPriority = "low" | "medium" | "high";

export interface Ticket {
  id: string;
  title: string;
  state: TicketState;
  priority: TicketPriority;
  companionId?: string;
  assignee?: string;
  labels: string[];
  created: string;
  updated: string;
  body: string;
}

export interface Companion {
  id: string;
  name: string;
  role: string;
  avatarSeed: string;
}

export interface ProjectConfig {
  id: string;
  name: string;
  recipe: string;
  companions: Companion[];
  plugins: string[];
  yolo: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  agent?: { command: string; args?: string[] };
  createdAt: string;
}

export type AutopilotStatus = "running" | "paused" | "idle" | "stopped";

export interface AutopilotState {
  status: AutopilotStatus;
  message?: string;
  currentTicketId?: string;
  currentRunId?: string;
  completed?: number;
  activity?: { at: string; text: string }[];
}

export interface ProjectListItem {
  id: string;
  name: string;
  path: string;
  recipe?: string;
  companions: Companion[];
  yolo: boolean;
  plugins: string[];
  counts: Record<TicketState, number>;
  pendingDocSync: boolean;
  autopilot: AutopilotStatus;
  valid: boolean;
}

export interface DocSummary {
  name: string;
  bytes: number;
  updated: string;
}

export interface MemorySummary {
  name: string;
  description?: string;
  type?: string;
}

export interface ProjectDetail {
  entry: { id: string; name: string; path: string };
  config: ProjectConfig;
  board: Record<TicketState, Ticket[]>;
  states: TicketState[];
  docs: DocSummary[];
  memories: MemorySummary[];
  pendingDocSync: boolean;
  autopilot: AutopilotState;
  /** Companion ids currently running a task. */
  busyCompanions: string[];
  /** Runs currently in flight (one per busy companion). */
  activeRuns: RunSummary[];
}

export interface RunLine {
  stream: "stdout" | "stderr" | "system";
  text: string;
  at: string;
}

export type RunStatus = "running" | "done" | "failed" | "stopped";

export interface RunSummary {
  id: string;
  ticketId: string;
  ticketTitle: string;
  companionId?: string;
  companion: string;
  hostname?: string;
  status: RunStatus;
  command: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  logAvailable?: boolean;
  lineCount: number;
}

export interface Run extends Omit<RunSummary, "lineCount"> {
  lines: RunLine[];
}

export interface DiscoveredDoc {
  relPath: string;
  importName: string;
  kind: "spec" | "readme" | "doc";
}

export interface UsageBudget {
  enabled: boolean;
  windowHours?: number;
  resetAt?: string;
  limit?: number;
  used?: number;
  remaining?: number;
  percentUsed?: number;
  safetyMarginPercent?: number;
  safeToContinue?: boolean;
  yolo?: boolean;
  breakdown?: { input: number; output: number; cacheCreation: number; cacheRead: number; messages: number };
  recommendation?: string;
}

export interface RecipeGit {
  strategy: "current-branch" | "new-branch";
  branchPrefix?: string;
}

export interface Commit {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
  companion?: string;
  companionRef?: Companion;
}

export interface Recipe {
  id: string;
  name: string;
  description: string;
  git: RecipeGit;
  roles: { role: string; description: string }[];
}

export async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `${res.status} ${res.statusText}`);
  }
  return (res.status === 204 ? null : await res.json()) as T;
}

// ---- shared display constants -------------------------------------------
export const STATE_LABELS: Record<TicketState, string> = {
  backlog: "Backlog",
  ready: "Ready",
  "in-progress": "In progress",
  review: "Review",
  done: "Done",
};

export const PRIORITY_BORDER: Record<TicketPriority, string> = {
  high: "border-l-red-400",
  medium: "border-l-amber-400",
  low: "border-l-zinc-500",
};

export const RUN_STATUS: Record<RunStatus, { label: string; color: string }> = {
  running: { label: "● running", color: "text-amber-400" },
  done: { label: "✓ done", color: "text-emerald-400" },
  failed: { label: "✖ failed", color: "text-red-400" },
  stopped: { label: "■ stopped", color: "text-zinc-400" },
};

export const AP_STATUS: Record<AutopilotStatus, { label: string; color: string }> = {
  running: { label: "● running", color: "text-emerald-400" },
  paused: { label: "❚❚ paused", color: "text-amber-400" },
  idle: { label: "○ idle", color: "text-cyan-400" },
  stopped: { label: "stopped", color: "text-zinc-400" },
};

export function fmtNum(n: number | undefined): string {
  return new Intl.NumberFormat().format(n ?? 0);
}
export function fmtBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

/** "14:32:10" for timestamps from today, otherwise "23 Jun, 14:32". */
export function fmtWhen(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString()
    : `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

/** Human-readable wall-clock duration of a finished run (e.g. "1m 12s"). */
export function runDuration(r: { startedAt: string; endedAt?: string }): string {
  if (!r.endedAt) return "";
  const ms = new Date(r.endedAt).getTime() - new Date(r.startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
