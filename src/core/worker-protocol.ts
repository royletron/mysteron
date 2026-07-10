/**
 * Wire protocol for the host <-> guest "worker" WebSocket (path /worker).
 *
 * A guest dials the host (the host is publicly reachable; the guest may not be),
 * registers a time-boxed offer of its machine + Claude account, and — in later
 * phases — receives ticket dispatches, runs Claude locally, and streams the
 * output + a result patch back. Phase 1 is presence only (register/heartbeat).
 */

export interface RegisterMsg {
  t: "register";
  /** Guest join token, minted by the host operator in Settings. */
  token: string;
  /** Friendly label for this guest (machine / account). */
  label: string;
  /** How many tickets this guest will take concurrently (>= 1). */
  capacity: number;
  /** Auto-expire the offer this many ms after connecting. */
  expiresInMs: number;
  /** Mysteron version this guest is running (from its package.json), so the host can spot stale guests. */
  version?: string;
  /** Short git sha of the guest's Mysteron checkout (absent for a packed install). */
  commitSha?: string;
}

export interface HeartbeatMsg {
  t: "heartbeat";
}

/**
 * A guest's current Claude allowance, captured with the *same* usage-monitor
 * machinery the host uses on itself (real subscription limits from the capture
 * proxy when available, else a transcript-token estimate). Lets the host see
 * whether a connected guest is also maxed out before handing it work.
 */
export interface GuestQuota {
  /** "live" = real captured subscription limits; "estimate" = transcript token tally. */
  source: "live" | "estimate";
  /** Percent of the governing window used (0–100). */
  percentUsed: number;
  /** Whether the guest is still safely under its allowance. */
  safeToContinue: boolean;
  /** When the governing window resets, if known. */
  resetAt?: string;
  /** When the guest captured this reading. */
  capturedAt: string;
}

/** A guest reports its current Claude allowance so the host can see if it's maxed out. */
export interface QuotaMsg {
  t: "quota";
  quota: GuestQuota;
}

/** A line of agent output the guest forwards to the host for the live view. */
export interface RunLineMsg {
  t: "run-line";
  runId: string;
  stream: "stdout" | "stderr" | "system";
  text: string;
}

/** The guest finished a dispatched ticket and returns the resulting diff. */
export interface RunDoneMsg {
  t: "run-done";
  runId: string;
  status: "done" | "failed" | "stopped";
  exitCode: number | null;
  /** Base64 of a `git diff --binary` from the snapshot to the agent's result. */
  patchBase64?: string;
  /**
   * The commit message(s) the agent itself wrote in the guest's throwaway repo
   * (full `%B` of every commit it made, in order). The host lands the squashed
   * diff under this message so the agent's own wording — conventional-commit
   * style, emoji, trailers from the companion role — survives. Absent when the
   * agent committed nothing (the host then falls back to the ticket title).
   */
  commitMessage?: string;
  costUsd?: number;
  numTurns?: number;
  /** True when the guest pushed its commits directly to the host via git-HTTP (no patchBase64 needed). */
  pushed?: boolean;
}

export type GuestMsg = RegisterMsg | HeartbeatMsg | QuotaMsg | RunLineMsg | RunDoneMsg;

export interface RegisteredMsg {
  t: "registered";
  workerId: string;
  /**
   * Identifies the host the guest joined. A guest serves the whole host (every
   * project's autopilot pulls from one shared pool), so this is a host label —
   * not a single project the guest is pinned to.
   */
  hostLabel: string;
  expiresAt: string;
}

export interface RejectedMsg {
  t: "rejected";
  reason: string;
}

export interface ExpiredMsg {
  t: "expired";
}

/** Host asks a guest to run a ticket end-to-end on its machine. */
export interface DispatchMsg {
  t: "dispatch";
  runId: string;
  ticketId: string;
  ticketTitle: string;
  /** Fully composed agent prompt (host builds it; guest needs no board access). */
  prompt: string;
  /** Host path to fetch the working-tree snapshot tar; guest prefixes its host URL. */
  snapshotPath: string;
  /** Host path of the live MCP (board/docs/memory) for this run; guest prefixes its host URL and points Claude at it over HTTP. */
  mcpPath?: string;
  /** Host git-HTTP path; guest prefixes its host URL to use as a push remote. Only set when the project uses per-ticket branch strategy. */
  gitPath?: string;
  /** The ticket branch name the guest should push commits onto (e.g. "mysteron/abc123"). */
  ticketBranch?: string;
  yolo: boolean;
  allowedTools: string[];
  disallowedTools: string[];
}

export type HostMsg = RegisteredMsg | RejectedMsg | ExpiredMsg | DispatchMsg;

/** Parse a human duration like "90s", "30m", "2h", "1d" into ms. */
export function parseDuration(s: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i.exec(s.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? "m").toLowerCase();
  const mult = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return n * mult;
}
