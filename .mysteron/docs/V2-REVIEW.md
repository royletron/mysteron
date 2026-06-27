# Mysteron — v2 architecture review

_Review for ticket `aX6J81M_` ("Review"), by Waldorf the Compiler, 2026-06-27._

A second pass after several rounds of change, focused on **spec drift** and
**architectural decisions worth revisiting and simplifying** — the brief
specifically called out "a sensible queue." The earlier gap review (`REVIEW.md`,
ticket `2-Mf_im8`) still stands; this one looks at the shape of the system rather
than its feature checklist.

Baseline: **95 tests pass** (was 80 at the last review). Security findings from
the prior audit are unchanged (none high/medium).

## Spec — still substantially delivered, and ahead in places

Nothing in the spec has been abandoned. Several roadmap items shipped since the
last review — per-companion autopilot, persistent Claude sessions, **guest
workers**, **worktree isolation**, **commit strategies**, and **ticket
dependencies** (`blockedBy`). The last two were undocumented; both READMEs have
been updated this round, along with the stale roadmap and board-state list in the
shared `docs/README.md`.

Still partial against the spec (each already ticketed):

| Spec promise | Status | Ticket |
| ------------ | ------ | ------ |
| Offload to real sub-agent teams (recipes) | Partial — recipes shape the lead's prompt + git only | `ah4-UFiD` (now `v2`) |
| Auto-derive tickets from doc/spec changes | Partial — watcher emits `docs-changed`; nothing consumes it | `RduSwHaY` |
| Extensible plugin system | Partial — clean interface, hardcoded registry | `KacZf6ue` (now `v2`) |

## The "sensible queue" — the headline architecture call

**There is no queue.** What looks like one is the board's `ready` column,
re-derived from disk on every autopilot tick:

- `Autopilot.loop()` (`src/runner/autopilot.ts`) wakes every ~1.5s (busy) / 15s
  (idle). Each tick it re-scans the board: `fanOutToGuests()` recomputes the free
  set for idle guests, then a per-companion loop calls `nextTicketForCompanion()`
  and dispatches locally.
- "Waiting" is implicit in ticket state; there is no work-item, no enqueue/claim,
  no attempt count, no observable depth.

Two structural smells fall out of this:

1. **Split dispatch paths for one concept.** "Run this ticket on an executor"
   is implemented twice — local via `runs.start()`, guest via
   `runs.startOnWorker()` — with the selection logic (blocked? already active?
   companion pinned local/guest? host maxed?) duplicated and interleaved across
   both. Landing is already unified through `landGuestPatch()`; **dispatch is
   not.** → ticket `nCDlPpY-` (v2): unify behind one queue + `Executor` interface.

2. **Scan-based dedup.** `activeForTicket` / `activeForCompanion` /
   `busyCompanionIds` each scan all runs, and the autopilot calls them per
   companion per tick. Correct, but O(runs) work to answer a question a queue
   would answer in O(1). Not a bottleneck at today's scale — a simplification, not
   a fix.

The current design is **correct** (the per-companion lock + per-ticket
idempotency genuinely hold). The case for a queue is simplification,
observability, and giving the two reliability items below a clean home.

## Reliability gaps that the queue work should carry

- **No retry policy.** A failing ticket is returned to `ready` and re-dispatched
  on the next tick — forever, with no attempt cap, no backoff, and no terminal
  "give up" state. In the headline yolo-for-days mode a poison ticket loops
  indefinitely and burns budget. → ticket `qY17AAjx` (v2, high).
- **Autopilot doesn't survive a restart.** Its state is in-memory; `hydrate()`
  recovers run *history* but the loop itself is gone and isn't auto-resumed. A
  server bounce silently stops the churn. → ticket `AsPmwens` (v2).
- **Shared writes still race.** Every board/docs/memory write is a bare
  read-modify-write `fs.writeFile` — last-writer-wins under the very concurrency
  that is Mysteron's premise. → ticket `__J9CotP` (now `v2`, high). Should land
  alongside the queue.

## The `v2` label

Tickets carrying `v2` are the structural reworks, grouped for a focused pass:

| Ticket | Title |
| ------ | ----- |
| `nCDlPpY-` | Unify dispatch behind one queue/scheduler abstraction |
| `qY17AAjx` | Retry policy — attempt cap, backoff, dead-letter state |
| `AsPmwens` | Persist & auto-resume autopilot across restarts |
| `__J9CotP` | Atomic, serialized writes for board/docs/memory |
| `ah4-UFiD` | Recipe teams: delegate to real sub-agents |
| `KacZf6ue` | Extensible plugin loading |

Suggested order: `__J9CotP` + `nCDlPpY-` first (they share substrate), then
`qY17AAjx` and `AsPmwens` on top of the queue, then the spec-completion items.

## Not a concern

The worktree-isolation work (ticket `iTunKOwa`, see `WORKER-ISOLATION.md`) landed
cleanly and unified local + guest landing — exactly the kind of simplification
this review is asking the queue work to repeat for dispatch. Run persistence,
session continuity, and the usage-monitor budget pause are all solid.
