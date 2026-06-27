---
name: runner/dispatch
description: How the autopilot dispatches tickets — one DispatchQueue + planner + Executor path (no more per-tick run scan)
metadata:
  type: project
---

Dispatch now goes through **one layer** in `src/runner/dispatch.ts` that separates *deciding what runs* from *how it runs* (ticket `nCDlPpY-`). The board's `ready` column is still the source of truth, but it is reconciled into an explicit, observable queue each tick rather than re-derived ad hoc.

**`DispatchQueue`** holds the waiting/claimed work-items for one project:
- `sync(readyUnblockedTickets)` rebuilds the waiting list each tick in board (priority) order, preserving `attempts`/`enqueuedAt`/`nextEligibleAt` for carried-over items and leaving in-flight (claimed) items running. Deterministic ordering — no "whoever the tick picked first".
- `claim(ticketId, companionId)` moves an item in flight and marks the companion busy (ref-counted, so two guest runs of the soloist's work both count); `release` (work landed) and `requeue(id, delayMs)` (failed/needs retry — bumps `attempts`, sets a backoff) free it.
- `has` / `isCompanionBusy` are **O(1)** — dedup is no longer an O(runs) scan per tick. `depth()`/`inFlight()`/`maxWaitMs()` are first-class (surfaced on `AutopilotState.queue`).
- `eligible()` returns the waiting items past their `nextEligibleAt` (retry backoff); the autopilot plans against this, not the raw `queued()`.

**`planAssignments(...)`** is the single, pure place the selection logic lives (blocked? already active? companion pinned local/guest? host maxed?). Guests are assigned first (one ticket each, respecting `runsOn` pins via `companionAllowsGuest`), then free local companions take their own work (one task at a time; a companion already busy — incl. by a guest run — is skipped locally). When `hostMaxed`, only guest assignments are produced.

**`Executor`** (`LocalExecutor` wrapping `runs.start`, `GuestExecutor` wrapping `runs.startOnWorker`, built by `executorFor`) gives both runners one `start(ticket)` signature, so `Autopilot.dispatch()` fires either uniformly and wires the run's completion back to the queue (landed → release, else → the retry policy in `handleFailure`). Mirrors how landing was already unified through `landGuestPatch()`.

`RunManager.activeForTicket`/`activeForCompanion`/`busyCompanionIds` still exist as idempotency backstops (and for the API status endpoint), but the autopilot no longer calls them per companion per tick.

**Reliability:** the retry cap/backoff/dead-letter gap is now closed (`qY17AAjx`) — see [[runner/retry]]. Still open: autopilot loop+queue are in-memory, not auto-resumed on restart (so `attempts` reset on restart) — `AsPmwens`; shared board writes still race — `__J9CotP`. See `docs/V2-REVIEW.md`. Related: [[runner/limit-detection]], [[runner/session-continuity]], [[core/git]].
