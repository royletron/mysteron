---
title: Clicking Run
state: review
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-25T17:28:55.204Z'
updated: '2026-06-25T17:44:30.873Z'
blockedBy:
  - ovhBZnIa
order: 2
---

We tried to fix this a few commits back, but I still have this problem where clicking 'run' on a ticket when everything is busy - it doesn't give me any feedback?

---
**Fixed by Waldorf (37904a5).** Root cause: the previous fix added a "Couldn't start a run" banner on the ticket live-view page, but you never reached that page — the ▶ button on the board card was `disabled` whenever the assigned companion was busy, so a click was a dead no-op (only a hover tooltip, invisible on touch).

The board ▶ button now stays clickable:
- **busy companion** → a toast: "<name> is busy with another ticket — it'll pick this one up when free, or connect a guest with `mysteron join`."
- **already running** → opens the live view (instead of being a dead spinner).
- **free** → unchanged (opens the live view and starts the run).

Typecheck clean; full test suite green (56/56). Frontend-only change, no automated UI test harness exists so this is verified by typecheck + manual reasoning.

Note: this ticket is still `blockedBy: ovhBZnIa` (the sticky guest-popover CSS ticket) — that's a separate, unrelated concern, so the fix landed independently. Don't merge ahead of the dependency if queue ordering matters to you.
