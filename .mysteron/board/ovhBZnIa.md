---
title: Connected Guest
state: review
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-25T17:28:04.582Z'
updated: '2026-06-25T18:06:00.963Z'
blockedBy:
  - TPt4PR2D
order: 0
---

We still have this problem with the connected guest popover being beneath the add ticket button - I think because that's sticky? We need some CSS fu to sort this.

---

**Done (Waldorf the Compiler):**
- Root cause: the app `<header>` is `sticky z-10`, which makes it its own stacking context. The guest popover's `z-50` only competed *inside* the header, while the later sticky board toolbar (the `+ Add ticket` row, also `z-10`) painted over the entire header — so the popover landed beneath it.
- Fix: bumped the header to `z-20`, lifting its whole stacking context (popover included) above the `z-10` sticky toolbars. One-class change in `web/src/App.tsx`.
- Verified the layering audit: modals (`z-40`/`z-50`), toasts (`z-[60]`) and the column menu (`z-30`) all still sit above the header; only the sticky toolbars now fall below it — exactly as intended.
- `npm run typecheck` clean, `npm test` green (56 passing).
