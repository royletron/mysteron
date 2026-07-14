---
title: Board search and filter
state: ready
priority: medium
assignee: Waldorf the Compiler
labels:
  - dream
  - feature
  - ui
  - stuck
created: '2026-07-12T18:16:08.288Z'
updated: '2026-07-14T16:27:28.126Z'
order: 0
---

**Gap.** The board has no search or filter. As tickets accumulate (bin grows quickly, backlog fills up), finding a specific ticket means scrolling across all columns. The MCP tools support structured queries but the web UI is all-or-nothing.

**Fix.** Add a search/filter bar above the board (in the sticky toolbar area, alongside the existing controls):

1. **Text search** — a debounced input that highlights/filters tickets by title or body text match. Matches should be visible across all columns simultaneously so you can see where a ticket is in the pipeline.
2. **Label filter** — a multi-select dropdown populated from labels in use. Selecting a label shows only tickets with that label.
3. **Companion filter** — filter to tickets assigned to (or created by) a specific companion.
4. **State toggle** — quick toggle to show/hide `bin` tickets (bin is already a column but many users will want to collapse it by default).

**Implementation notes:**
- All data is already in memory on the client (the board fetches all tickets on load and receives live `board-changed` events). This is a pure frontend filter — no new API calls.
- URL-encode active filters so a filtered view is shareable/bookmarkable: `?q=auth&label=ci`.
- When filters are active, show a clear "X filters active" badge and a reset button.
- The filter state should survive tab switches (Board → Commits → back to Board).

**Acceptance.** Typing in the search box narrows visible tickets across all columns in real time. Selecting a label filter shows only matching tickets. Filtered URLs are bookmarkable and reload to the same filtered state.

> ⚠ **Stuck — parked by autopilot** (2026-07-13T20:31:10.759Z)
> Gave up after 2 non-retryable attempt(s): agent failed. A human should take a look.
