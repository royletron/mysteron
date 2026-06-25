---
title: Bulk Bin
state: bin
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-25T13:49:21.412Z'
updated: '2026-06-25T16:45:25.755Z'
---

Can we have a bulk move for columns? Either to a column or to the bin? Probably want a confirmation

---
**Done** ✅ Each board column now has a "⋯" menu to bulk-move all its tickets to another column or the bin, with a confirm dialog showing the count and destination.

- `moveTicketsByState` core helper + `POST /api/projects/:id/tickets/bulk-move` endpoint (validates states, emits `board-changed`).
- `ColumnMenu` in the board UI; `confirm()` before moving.
- Added a core test for the bulk move.

All 45 tests pass; `npm run typecheck` clean. Two commits on the current branch.
