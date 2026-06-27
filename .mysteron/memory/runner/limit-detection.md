---
name: runner/limit-detection
description: How a run's usage/limit, session-error and stream-stall flags are detected, and why finished runs must not be bounced to Ready
metadata:
  type: project
---

`RunManager` (`src/runner/manager.ts`) flags three agent-side errors by regex over log lines: `LIMIT_HIT_RE` → `run.limitHit`, `SESSION_ERROR_RE` → `run.sessionError`, `STREAM_STALL_RE` → `run.streamStalled`.

**Detection is scoped to the agent's OWN output.** In `append()` the regexes run only when `stream !== "system"` (i.e. stdout/stderr). `system` lines are tool-result echoes (which repeat the ticket body) and lines the manager injects itself — scanning them caused false positives. Concretely: an agent reading a ticket whose body mentions "usage limit reached" (ticket q18zz3xH was literally about this) would echo that text as a `← …` system line and trip `limitHit`.

**A finished run is never bounced.** In `finish()` the limit-retry *and* stream-stall branches are gated on `status !== "done"`. The point of moving a ticket back to `ready` is "the agent didn't finish — retry". A run that completed ("done") already landed its work (review), so bouncing it both loses the result and prints a second, contradictory final summary. These two guards fixed the "tickets bounce back to Ready + summary printed twice" bug.

**Stream stall (ticket UMjv6eWK).** `STREAM_STALL_RE` matches Claude Code's "Response stalled mid-stream / response … may be incomplete" — the streaming API dropped before the reply finished. Treated exactly like a limit hit: `finish()` bounces the ticket to `ready`, and `classifyFailure` (`src/runner/retry.ts`) counts `streamStalled` as **retryable** so the autopilot retries with backoff instead of dead-lettering. Reason string surfaced in `autopilot.ts` `onFinished` as "stream stalled".

The existing session-error retry path emits "invalid session id" on stderr, so it still works under the stream scoping. Related: [[runner/dispatch]], [[runner/session-continuity]], [[runner/retry]].
