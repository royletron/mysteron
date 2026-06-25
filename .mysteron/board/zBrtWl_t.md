---
title: Connected Guests
state: done
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-25T16:45:57.792Z'
updated: '2026-06-25T17:54:23.812Z'
---

The popover appeared behind the add ticket and auto pilot buttons.

**Root cause:** the app `<header>` was `sticky top-0 z-10`, creating a stacking context at `z-10`. The board's sticky toolbar (Add ticket / autopilot buttons) is also `z-10` and sits later in the DOM, so it painted on top. The Connected Guests popover (`z-50`) was confined to the header's `z-10` context, so it could never rise above the toolbar.

**Fix:** bumped the header to `z-20` (web/src/App.tsx) so its stacking context — and the popover inside it — paints above the `z-10` toolbars. The board row dropdown (z-20 backdrop / z-30 menu) is unaffected.

**Verification:** `npm run typecheck` clean; `npm test` green (46/46). Layout-only change — no automated test covers z-index, verified by reasoning about the stacking contexts.
