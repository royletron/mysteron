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
}

export interface HeartbeatMsg {
  t: "heartbeat";
}

export type GuestMsg = RegisterMsg | HeartbeatMsg;

export interface RegisteredMsg {
  t: "registered";
  workerId: string;
  projectName: string;
  expiresAt: string;
}

export interface RejectedMsg {
  t: "rejected";
  reason: string;
}

export interface ExpiredMsg {
  t: "expired";
}

export type HostMsg = RegisteredMsg | RejectedMsg | ExpiredMsg;

/** Parse a human duration like "90s", "30m", "2h", "1d" into ms. */
export function parseDuration(s: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i.exec(s.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? "m").toLowerCase();
  const mult = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return n * mult;
}
