---
title: Big Problem
state: review
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-30T14:40:49.665Z'
updated: '2026-06-30T14:46:07.771Z'
order: 0
---

I just had a ticket run on a remote machine that was not allowed to run for that companion... Is this list being adhered too? It is bad if we run them where they're not alowed.

---

**Root cause found & fixed.** The `runsOn` host-pin list *was* being checked for assigned tickets, but **not** for unassigned ones. In `planAssignments` (`src/runner/dispatch.ts`), the companion was resolved with `getCompanion(config, ticket.companionId)`, which returns `undefined` when a ticket has no companion. `companionAllowsGuest(undefined, label)` is vacuously `true`, so unassigned work fanned out to *any* connected guest — even when the soloist it runs as is pinned to `local`. That's the "ran on a machine it wasn't allowed to" case.

**Fix:** `companionFor` now falls back to `defaultCompanion(config)` (the soloist), matching what `runningCompanionId`, `manager.startOnWorker`, and the manual-run path in `api.ts` already do. So an unassigned ticket honours the soloist's pin: pinned to `local` → runs locally; pinned to a named guest → only that guest; otherwise it waits rather than running somewhere forbidden.

Added regression tests in `test/dispatch.test.ts` covering unassigned work with a soloist pinned to local-only, to a specific guest, and away from the only available guest. Full suite green (150 tests), typecheck clean.
