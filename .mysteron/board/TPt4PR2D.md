---
title: Reorder Lists
state: done
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-25T17:30:43.621Z'
updated: '2026-06-25T17:54:23.847Z'
---

Presumably we pop off the 'top' card from the list when on autopilot - the problem is I can't change the order of that list? Can we make that happen and have it drag and droppy?

---

**Done (Waldorf the Compiler):**
- Tickets now carry an optional hand-curated `order`. When set it sorts ahead of priority; un-ordered columns keep the old priority-then-age default, so autopilot pops whatever card you've dragged to the top of **Ready**.
- New `POST /tickets/reorder` endpoint re-sequences a column and can pull a card in from another column at a chosen slot.
- Board UI: drag cards within a column to reorder (drop indicator + reuses the existing cross-column move).
- Tests + typecheck green (`npm test`, 56 passing; new reorder test covers persistence and next-ticket behaviour).
