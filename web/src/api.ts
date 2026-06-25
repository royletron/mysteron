// API client + shared types for the Mysteron web UI. Types mirror the server's
// JSON responses (see src/server/api.ts).

export type TicketState = "backlog" | "ready" | "in-progress" | "review" | "done" | "bin";
export type TicketPriority = "low" | "medium" | "high";

/** A resolved "blocked by" edge: the upstream ticket and whether it's landed in main. */
export interface DependencyLink {
  id: string;
  title: string;
  state: TicketState;
  satisfied: boolean;
  missing: boolean;
}

export interface TicketRef {
  id: string;
  title: string;
  state: TicketState;
}

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
  attachments?: string[];
  /** Ids of tickets this one depends on (must land in main first). */
  blockedBy?: string[];
  /** Resolved dependencies, present on board responses (see listTicketsEnriched). */
  dependencies?: DependencyLink[];
  /** Tickets that depend on this one (downstream waiters). */
  blocks?: TicketRef[];
  /** True while a dependency hasn't landed in main yet — paused in the queue. */
  blocked?: boolean;
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
  pluginOptions?: {
    "usage-monitor"?: { tokenLimit?: number; windowHours?: number };
  };
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
  /** Set when the run is executing on a guest machine (its label). */
  guestLabel?: string;
  /** For guest runs whose work landed on a dedicated branch (rather than the current one). */
  branch?: string;
  status: RunStatus;
  command: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  costUsd?: number;
  numTurns?: number;
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

export interface UsageBucket {
  utilizationPct?: number;
  status?: string;
  resetAt?: string;
}

export interface UsageBudget {
  enabled: boolean;
  /** Which account regime drives the numbers. */
  account?: { kind: "subscription" | "api-key" | "unknown"; subscriptionType?: string };
  /** "live" = real captured limits; "estimate" = transcript token tally. */
  source?: "live" | "estimate";
  mode?: "subscription-limits" | "api-budget" | "estimate";
  /** Real per-bucket utilization, present only in live mode. */
  live?: {
    capturedAt: string;
    ageSeconds: number;
    overallStatus?: string;
    session?: UsageBucket;
    weekly?: UsageBucket;
    /** A lockout reading held past the freshness TTL until its reset passes. */
    lockout?: boolean;
    /** The capture is older than the freshness TTL (held only because of a lockout). */
    stale?: boolean;
  } | null;
  windowHours?: number;
  resetAt?: string;
  limit?: number;
  limitSource?: "config" | "env" | "default";
  used?: number;
  remaining?: number;
  percentUsed?: number;
  safetyMarginPercent?: number;
  safeToContinue?: boolean;
  yolo?: boolean;
  breakdown?: { input: number; output: number; cacheCreation: number; cacheRead: number; messages: number };
  /** Token tally for the session window (supplementary in live mode). */
  tokensThisWindow?: number;
  weeklyUsed?: number;
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

export interface BranchInfo {
  name: string;
  shortHash: string;
  subject: string;
  date: string;
  companion?: string;
  companionRef?: Companion;
  ahead: number;
  behind: number;
  filesChanged: number;
  merged: boolean;
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
  // A 401 on a normal API call means our session expired or the password
  // changed — tell the app to show the login gate (but not for the auth
  // endpoints themselves, which handle their own errors).
  if (res.status === 401 && !path.startsWith("/api/auth/")) {
    dispatchEvent(new Event("mysteron:unauth"));
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `${res.status} ${res.statusText}`);
  }
  return (res.status === 204 ? null : await res.json()) as T;
}

export interface AuthStatus {
  /** Protection is on and gating requests. */
  enabled: boolean;
  /** This browser currently has a valid session. */
  authed: boolean;
  /** A password has been configured (may be on or off). */
  passwordSet: boolean;
}

export const getAuthStatus = () => api<AuthStatus>("/api/auth/status");
export const login = (password: string) =>
  api<{ ok: boolean }>("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) });
export const logout = () => api<{ ok: boolean }>("/api/auth/logout", { method: "POST" });

export interface GuestWorker {
  id: string;
  label: string;
  capacity: number;
  connectedAt: string;
  lastSeen: string;
  expiresAt: string;
  status: "idle" | "busy";
}

export const getWorkers = () => api<{ workers: GuestWorker[] }>("/api/workers");
export const getGuestToken = () => api<{ token: string | null }>("/api/settings/guest");
export const mintGuestToken = () => api<{ token: string }>("/api/settings/guest", { method: "POST" });
export const revokeGuestToken = () => api<{ ok: boolean }>("/api/settings/guest", { method: "DELETE" });

// This machine offering itself to a host as a guest.
export interface GuestOfferStatus {
  offering: boolean;
  state: "connecting" | "offered" | "rejected" | "stopped";
  hostUrl: string;
  label: string;
  hostLabel?: string;
  expiresAt?: string;
  message?: string;
  activeRuns: number;
}

export interface HostBoardProject {
  id: string;
  name: string;
  tickets: { id: string; title: string; state: TicketState; priority: string; assignee?: string }[];
}

export const getGuestOffer = () => api<{ guest: GuestOfferStatus | null }>("/api/guest");
export const startGuestOffer = (body: { hostUrl: string; token: string; forMs?: number; name?: string }) =>
  api<{ guest: GuestOfferStatus }>("/api/guest", { method: "POST", body: JSON.stringify(body) });
export const stopGuestOffer = () => api<{ ok: boolean }>("/api/guest", { method: "DELETE" });
export const getHostBoard = () => api<{ projects: HostBoardProject[] }>("/api/guest/board");

// ---- shared display constants -------------------------------------------
export const STATE_LABELS: Record<TicketState, string> = {
  backlog: "Backlog",
  ready: "Ready",
  "in-progress": "In progress",
  review: "Review",
  done: "Done",
  bin: "Bin",
};

type StatusInfo = { label: string; color: string; live?: boolean };

export const RUN_STATUS: Record<RunStatus, StatusInfo> = {
  running: { label: "running", color: "text-amber-400", live: true },
  done: { label: "✓ done", color: "text-emerald-400" },
  failed: { label: "✖ failed", color: "text-red-400" },
  stopped: { label: "■ stopped", color: "text-zinc-400" },
};

export const AP_STATUS: Record<AutopilotStatus, StatusInfo> = {
  running: { label: "running", color: "text-emerald-400", live: true },
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

/** A run's cost, e.g. "$0.12" (or "$0.0034" for sub-cent runs). "" when unknown. */
export function fmtCost(n: number | undefined): string {
  if (typeof n !== "number") return "";
  return n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
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

/** Human-readable elapsed time, e.g. "42s", "1m 12s", "2h 5m", "1d 3h". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Elapsed time of a run — live against `now` while running, final once it ends. */
export function runElapsed(r: { startedAt: string; endedAt?: string }, now: number): string {
  const end = r.endedAt ? new Date(r.endedAt).getTime() : now;
  return formatDuration(end - new Date(r.startedAt).getTime());
}
