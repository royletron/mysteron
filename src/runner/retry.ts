/**
 * The retry policy for the autopilot: how many times a failing ticket is retried,
 * how long to wait between attempts, and when to give up and park it for a human.
 *
 * It separates two kinds of failure (the autopilot decides which from a finished
 * {@link Run}):
 * - **retryable** — transient: a patch that wouldn't apply, a rejected session, a
 *   usage/limit hit, or a streaming response that stalled mid-reply. The ticket was
 *   bounced back to `ready`; an immediate retry would just burn budget, so we space
 *   them out with exponential backoff + jitter.
 * - **non-retryable** — a clean agent failure after a real try (it ran, exited
 *   non-zero, no transient signal). Retrying rarely helps, so the cap is lower.
 *
 * Past the cap the autopilot dead-letters the ticket (parks it with a `stuck`
 * label + a note) instead of looping forever.
 */

export type FailureKind = "retryable" | "non-retryable";

export interface RetryPolicy {
  /** Attempts allowed for a transient (retryable) failure before dead-lettering. */
  maxAttempts: number;
  /** Attempts allowed for a clean (non-retryable) agent failure before dead-lettering. */
  maxNonRetryableAttempts: number;
  /** First backoff step (ms); doubles each attempt up to maxDelayMs. */
  baseDelayMs: number;
  /** Cap on a single backoff step (ms), so waits don't grow without bound. */
  maxDelayMs: number;
  /** Extra wait added as a random fraction of the step (0..1) to de-sync retries. */
  jitter: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  maxNonRetryableAttempts: 2,
  baseDelayMs: 30_000,
  maxDelayMs: 30 * 60_000,
  jitter: 0.2,
};

function envNum(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** The retry policy, with each field overridable by a MYSTERON_RETRY_* env var. */
export function retryPolicyFromEnv(): RetryPolicy {
  return {
    maxAttempts: Math.max(1, envNum("MYSTERON_RETRY_MAX_ATTEMPTS", DEFAULT_RETRY_POLICY.maxAttempts)),
    maxNonRetryableAttempts: Math.max(
      1,
      envNum("MYSTERON_RETRY_MAX_NONRETRYABLE", DEFAULT_RETRY_POLICY.maxNonRetryableAttempts),
    ),
    baseDelayMs: envNum("MYSTERON_RETRY_BASE_MS", DEFAULT_RETRY_POLICY.baseDelayMs),
    maxDelayMs: envNum("MYSTERON_RETRY_MAX_MS", DEFAULT_RETRY_POLICY.maxDelayMs),
    jitter: envNum("MYSTERON_RETRY_JITTER", DEFAULT_RETRY_POLICY.jitter),
  };
}

/**
 * Classify a finished run's failure. The transient signals (`limitHit`,
 * `sessionError`, `landFailed`, `streamStalled`) are set by the {@link RunManager};
 * anything else is a clean agent failure we treat as non-retryable.
 */
export function classifyFailure(run: {
  limitHit?: boolean;
  sessionError?: boolean;
  landFailed?: boolean;
  streamStalled?: boolean;
}): FailureKind {
  return run.limitHit || run.sessionError || run.landFailed || run.streamStalled
    ? "retryable"
    : "non-retryable";
}

/**
 * The wait before the next attempt: `baseDelayMs` doubled for each attempt already
 * made (capped at `maxDelayMs`), plus up to `jitter`× of random extra so a board
 * full of failing tickets doesn't retry in lockstep.
 */
export function backoffMs(attempts: number, policy: RetryPolicy, rand: () => number = Math.random): number {
  const step = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempts - 1));
  return Math.round(step + step * policy.jitter * rand());
}

export type RetryDecision =
  | { action: "retry"; delayMs: number }
  | { action: "dead-letter"; reason: string };

/**
 * Decide what to do after a failed attempt. `attempts` is the number made so far
 * (including the one that just failed). Past the kind's cap we dead-letter;
 * otherwise we retry after a backoff.
 */
export function decideRetry(input: {
  kind: FailureKind;
  attempts: number;
  policy: RetryPolicy;
  rand?: () => number;
}): RetryDecision {
  const { kind, attempts, policy } = input;
  const cap = kind === "retryable" ? policy.maxAttempts : policy.maxNonRetryableAttempts;
  if (attempts >= cap) {
    return { action: "dead-letter", reason: `gave up after ${attempts} ${kind} attempt(s) (cap ${cap})` };
  }
  return { action: "retry", delayMs: backoffMs(attempts, policy, input.rand) };
}
