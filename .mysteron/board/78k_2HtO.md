---
title: Cleanup
state: done
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-23T22:00:17.426Z'
updated: '2026-06-23T22:41:47.707Z'
---

After 48 hours of being in 'done' we need tickets to be moved into a 'bin' - create the bin page and add it as a tab. Maybe have a restore button...? We should also put a 'delete' button on tickets in any state

ALSO, unrelated but important. When a card is in progress, can we make the whole card yellow? and pulse? Make sure you sort out any contrast issues with text

---

## Work log — Waldorf the Compiler

Shipped as two focused commits (the two asks are unrelated, as you noted).

### 🗑️ Bin / cleanup — `8ff6096`
- **New `bin` state.** Added to `TICKET_STATES`, plus a `BOARD_STATES` list (everything except `bin`) that drives the board columns — so the bin is *not* a column.
- **48h auto-sweep.** `binStaleDone()` moves any ticket that's been in `done` longer than 48h into the bin. The server runs it on boot and hourly (`setInterval`, unref'd, cleared on shutdown), emitting a board-changed event when it moves anything.
- **Bin tab + page.** New **Bin** tab listing binned tickets, each with **↩ Restore** (back to `done`) and **Delete** (permanent, with confirm). Empty state included.
- **Delete in any state.** The ticket panel already carries a Delete (hard delete) for a ticket in any state, so that's covered; the Bin tab adds delete there too. You can also manually bin via the panel's state dropdown (now includes "Bin").
- Restore/delete reuse the existing PATCH/DELETE ticket routes — no new endpoints.

### 💛 In-progress cards — `c60afdc`
A card in `in-progress` now gets a full **amber background** with a gentle **pulse**. For contrast I flipped the title + run icon to near-black (`text-zinc-900`) on the yellow; the dark tag pills already read fine. Uses the existing reduced-motion-safe `.pulse`.

Files: `src/core/{types,board}.ts`, `src/server/{api,index}.ts`, `web/src/{api,Board,Project,tabs}.tsx`, `test/core.test.ts`.

Tests: added a `binStaleDone` test (no-op under the 48h default; sweeps to bin with a zero threshold). `npm run typecheck` clean, `npm test` **20/20** pass, `vite build` succeeds. Trailers + fun/emoji/conventional messages applied.

Notes for review:
- "48h in done" is measured from the ticket's `updated` time (set when it entered done) — we don't store a separate done-at, and `updated` is the closest honest signal.
- Restore returns a ticket to **done** (the state it was auto-binned from), since we don't track its pre-bin origin.
