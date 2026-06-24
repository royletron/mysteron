import { promises as fs } from "node:fs";
import path from "node:path";
import { mysteronHome } from "../../core/paths.js";

/**
 * The latest rate-limit reading captured from Anthropic's API response headers
 * by the capture proxy (see proxy.ts). Rate limits are per-account / per-machine
 * (not per-project), so a single snapshot lives under the central Mysteron home.
 */
export interface RateLimitSnapshot {
  /** When these headers were seen. */
  capturedAt: string;
  /** Every `anthropic-ratelimit-*` response header, verbatim — kept so we can
   *  refine parsing later without re-capturing. */
  raw: Record<string, string>;
  /** Parsed unified buckets (subscription accounts only). */
  unified?: UnifiedLimits;
}

export interface Bucket {
  /** 0–100, from the header's 0.0–1.0 utilization value. */
  utilizationPct?: number;
  /** "allowed" | "allowed_warning" | "rejected" | ... */
  status?: string;
  /** ISO timestamp when this window resets. */
  resetAt?: string;
}

export interface UnifiedLimits {
  /** Overall status across all buckets. */
  status?: string;
  /** 5-hour rolling session window. */
  session?: Bucket;
  /** 7-day (weekly) window. */
  weekly?: Bucket;
}

function snapshotPath(): string {
  return path.join(mysteronHome(), "ratelimit-snapshot.json");
}

function num(v: string | undefined): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * A unified reset header may be an epoch-seconds number or an ISO string. Return
 * an ISO string either way, or undefined if it isn't parseable.
 */
function toIso(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const asNum = Number(v);
  if (Number.isFinite(asNum)) {
    // Heuristic: seconds vs milliseconds since epoch.
    const ms = asNum < 1e12 ? asNum * 1000 : asNum;
    return new Date(ms).toISOString();
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

function bucket(headers: Record<string, string>, prefix: string): Bucket | undefined {
  const util = num(headers[`${prefix}-utilization`]);
  const status = headers[`${prefix}-status`];
  const reset = toIso(headers[`${prefix}-reset`]);
  if (util == null && status == null && reset == null) return undefined;
  return {
    // Headers express utilization as 0.0–1.0; surface a friendlier 0–100.
    utilizationPct: util != null ? Math.round(util * 1000) / 10 : undefined,
    status,
    resetAt: reset,
  };
}

/**
 * Parse the unified rate-limit headers Anthropic returns for subscription
 * accounts. Pure (no I/O) so it's directly unit-testable. Returns undefined when
 * no unified headers are present (e.g. API-key accounts).
 */
export function parseUnifiedLimits(headers: Record<string, string>): UnifiedLimits | undefined {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const session = bucket(lower, "anthropic-ratelimit-unified-5h");
  const weekly = bucket(lower, "anthropic-ratelimit-unified-7d");
  const status = lower["anthropic-ratelimit-unified-status"];
  if (!session && !weekly && !status) return undefined;
  return { status, session, weekly };
}

/** Pull just the `anthropic-ratelimit-*` headers out of a response, lowercased. */
export function extractRateLimitHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (!key.startsWith("anthropic-ratelimit-")) continue;
    out[key] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
  }
  return out;
}

export async function writeSnapshot(snap: RateLimitSnapshot): Promise<void> {
  try {
    const file = snapshotPath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(snap, null, 2), "utf8");
  } catch {
    /* a capture write must never disrupt the proxied request */
  }
}

export async function readSnapshot(): Promise<RateLimitSnapshot | undefined> {
  try {
    return JSON.parse(await fs.readFile(snapshotPath(), "utf8")) as RateLimitSnapshot;
  } catch {
    return undefined;
  }
}
