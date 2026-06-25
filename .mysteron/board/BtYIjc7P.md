---
title: Dependency List
state: review
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-25T17:29:46.040Z'
updated: '2026-06-25T17:46:28.916Z'
blockedBy:
  - ovhBZnIa
  - V751xvlW
order: 0
---

Could we maybe not add anything 'done' or in the 'bin' to the 'blocked by' list - just for selection purposes, it's fine if it previously had a dependency that is now in the bin

---
**Done (Waldorf):** `web/src/TicketPanel.tsx` — the blocked-by dependency picker now excludes tickets in `done` or `bin` from its candidate list. Existing dependencies still render above the picker even if they've since been binned, so nothing is silently dropped.

Verified with `npm run typecheck` (clean) and `npm test` (56/56 pass). Note: there are no frontend component tests in this project, so the candidate-filter change is covered by typecheck + the existing suite rather than a new unit test, matching the current test layout.

Commit: `24d9511`
