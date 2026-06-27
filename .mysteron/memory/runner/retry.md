---
name: runner/retry
description: The autopilot retry policy — attempt cap, exponential backoff+jitter, retryable/non-retryable split, and dead-lettering
metadata:
  type: project
---

The autopilot's retry policy lives in `src/runner/retry.ts` (pure, fully unit-tested) and is wired into `Autopilot.dispatch`/`onFinished`/`handleFailure` (ticket `qY17AAjx`). It stops a poison ticket looping forever.

**The split.** `classifyFailure(run)` reads flags the `RunManager` sets on a finished `Run`:
- **retryable** (transient): `limitHit`, `sessionError`, or `landFailed` (new — a patch that wouldn't apply; set in `landLocalRun`/`applyGuestResult`). The manager already bounced the ticket back to `ready`.
- **non-retryable**: a clean agent failure (ran, exited non-zero, no transient signal).

A run is only **landed** (success) when `status === "done" && !landFailed` — a "done" run whose patch didn't apply is a failure, not a completion. A human-`stopped` run is dropped, not counted against the cap.

**The policy.** `RetryPolicy` (env-overridable via `MYSTERON_RETRY_*`, defaults: retryable cap 5, non-retryable cap 2, base 30s, max 30m, jitter 0.2). `decideRetry({kind, attempts, policy})` → `retry` with `backoffMs` (exponential `base*2^(n-1)`, capped, + jitter) while under the kind's cap, else `dead-letter`. Autopilot takes a `RetryPolicy` as its 3rd constructor arg (tests inject a tiny deterministic one).

**Backoff is enforced by the queue.** `WorkItem.nextEligibleAt` + `DispatchQueue.eligible()` (vs `queued()`); `requeue(id, delayMs)` sets it. The autopilot plans against `queue.eligible()`, so a just-failed ticket sits in the queue but isn't re-dispatched until due. Backoff + attempts survive `sync()` because the ticket stays `ready` and the item is preserved from `prev`.

**Dead-letter = parked, not a new column.** No `needs-attention` board state was added (would touch types/UI). Instead the ticket is moved to `backlog`, given a `stuck` label, and a "Stuck — parked by autopilot" note (attempts + reason) is appended to its body — off the `ready` column so it isn't re-dispatched, visible on the board, surfaced on `AutopilotState.deadLettered` + the activity log. The claim is held across the board write, then released, so a concurrent `sync` can't re-add it.

**Still open:** attempts live on the in-memory work-item, so a server restart resets them — that's the autopilot-persistence ticket `AsPmwens`. Related: [[runner/dispatch]], [[runner/limit-detection]].
