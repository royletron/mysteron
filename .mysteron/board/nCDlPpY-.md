---
title: 'v2: Unify dispatch behind one queue/scheduler abstraction'
state: done
priority: medium
createdBy: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels:
  - v2
  - tech-debt
  - needs-decision
created: '2026-06-27T11:07:19.921Z'
updated: '2026-06-27T12:06:20.786Z'
order: 1
---

**Architecture rethink (raised by review `aX6J81M_`).** There is no real queue today — the "queue" is the board's `ready` column re-derived on every poll tick.

**How it works now.** `Autopilot.loop()` (`src/runner/autopilot.ts`) wakes every ~1.5s (busy) / 15s (idle) and, each tick, re-scans the board:
- `fanOutToGuests()` recomputes the free-ticket set and hands tickets to idle guests, and
- a per-companion loop calls `nextTicketForCompanion()` and dispatches locally.

Two consequences:
- **Two split dispatch paths** for one concept ("run this ticket on an executor"): local goes through `runs.start()`, guest through `runs.startOnWorker()`. Selection logic (blocked? already active? companion pinned local/guest? host maxed?) is duplicated and interleaved across both.
- **Dedup is by O(n) scan** of all runs every tick (`activeForTicket` / `activeForCompanion` in `manager.ts`), and "waiting" is implicit in ticket state rather than an explicit, observable queue.

**Proposal.** Introduce a single dispatch layer that separates *deciding what runs* from *how it runs*:
- one `enqueue`/`claim` model where a ready+unblocked ticket becomes a queued work-item with a target (`local` companion or guest worker) and an `attempts` count;
- one `Executor` interface implemented by both the local worktree runner and the guest worker, so the autopilot dispatches uniformly;
- queue depth / wait-time / attempts become first-class and observable (and testable — deterministic ordering instead of "whoever the tick picked first").

**Why v2, not now.** The current design is *correct* (per-companion lock + per-ticket idempotency hold); this is a simplification + observability win, and the right substrate for the retry-policy and autopilot-persistence v2 tickets. Pairs with atomic board writes (`__J9CotP`).

**Acceptance.** A documented dispatch/queue module; autopilot dispatches local+guest through one path; dedup no longer a full scan per tick; unit tests for ordering, claim/requeue, and target selection.
