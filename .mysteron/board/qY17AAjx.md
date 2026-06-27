---
title: 'v2: Retry policy — attempt cap, backoff, and a dead-letter state'
state: review
priority: high
createdBy: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels:
  - v2
  - reliability
  - tech-debt
created: '2026-06-27T11:07:36.685Z'
updated: '2026-06-27T12:16:26.495Z'
---

**Reliability gap (raised by review `aX6J81M_`).** A ticket that keeps failing is retried forever with no cap and no backoff — a real hazard for the headline "leave it churning for days in yolo" use case.

**Today.** When a run fails (`manager.ts`): non-session crash → `failed`; patch-apply failure → ticket back to `ready`; usage-limit hit → ticket back to `ready`. The autopilot then re-dispatches that `ready` ticket on the *next tick* (~1.5s while busy). The only de-facto throttles are `BREATHER_MS`/`IDLE_POLL_MS` and the budget pause. So:
- **No attempt cap** — a poison ticket (bad acceptance criteria, an agent that can't make the tests pass) loops indefinitely.
- **No backoff/jitter** — immediate retry burns Claude budget on something that just failed, repeatedly.
- **No terminal failure state** — nothing ever lands a ticket in a "give up, a human should look" column, so the board can silently spin on one card forever.

**Proposal.**
- Track `attempts` per ticket (frontmatter, or on the queue work-item from the queue ticket `nCDlPpY-`).
- Exponential backoff + jitter between attempts; distinguish *retryable* (transient: patch conflict, session error, limit hit) from *non-retryable* (clean agent failure after a real try) so the policy can differ.
- After `maxAttempts`, move the ticket to a dead-letter/`needs-attention` state (or back to `backlog` with a `stuck` label + a note on why) instead of `ready`, and surface it in the UI.

**Acceptance.** A failing ticket stops being retried after N attempts and is visibly parked with the failure reason; retries are spaced by backoff; unit tests cover cap + backoff + the retryable/non-retryable split.

---

## ✅ Done (commits `f2c68b2`, `17d155b`)

- **New `src/runner/retry.ts`** (pure, fully unit-tested): `classifyFailure` (retryable = limit/session/patch-conflict; non-retryable = clean agent failure), `backoffMs` (exponential `base·2^(n-1)`, capped, + jitter), `decideRetry` → retry-with-backoff while under the kind's cap, else dead-letter. `RetryPolicy` is env-overridable (`MYSTERON_RETRY_*`); defaults: retryable cap 5, non-retryable cap 2, base 30s, max 30m, jitter 0.2.
- **`DispatchQueue` backoff** (`dispatch.ts`): `WorkItem.nextEligibleAt` + `eligible()`; `requeue(id, delayMs)` holds a just-failed ticket out of dispatch until due. Attempts (tracked on the queue work-item, per `nCDlPpY-`) **and** backoff survive `sync()`.
- **`RunManager.landFailed`** (`manager.ts`): set when a patch won't apply, so the autopilot distinguishes a "done-but-didn't-land" run from a real completion (only `done && !landFailed` counts as landed).
- **Autopilot wiring**: failures route through the policy; a human-`stopped` run isn't counted against the cap. Past the cap the ticket is **dead-lettered → moved to `backlog`, labelled `stuck`, with a "parked by autopilot" note (attempts + reason) appended to its body**. Surfaced via `AutopilotState.deadLettered` + the activity log. The claim is held across the board write so a concurrent `sync` can't re-add it.

**Decision:** chose the proposal's "back to `backlog` + `stuck` label + note" rather than adding a new `needs-attention` board column (which would touch `TICKET_STATES`/`BOARD_STATES` + the web UI) — keeps the change focused and the parked ticket is still visible on the board.

**Tests** (122 pass, +11): cap + backoff + cap-per-kind in `retry.test.ts`; backoff eligibility + survives-sync in `dispatch.test.ts`; full retry→dead-letter integration in `autopilot.test.ts`. `npm run typecheck` clean.

**Note / follow-up:** attempts live on the in-memory work-item, so a server restart resets them — already tracked by the autopilot-persistence ticket `AsPmwens`, no new ticket raised.
