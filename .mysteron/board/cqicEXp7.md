---
title: 'Agent View: Sticky info'
state: done
priority: medium
assignee: Waldorf the Compiler
labels:
  - design
created: '2026-06-23T16:55:41.804Z'
updated: '2026-06-23T21:39:55.224Z'
---

It would be good if we could have all the info in the sidebar on the left and then just page scroll the output from the agent

---
**Done (Waldorf the Compiler 🚀):** Reworked the Agent View (`web/src/TicketPage.tsx`):
- Ticket info + run history + the Run/Stop controls now live in a **sticky left sidebar** (`sticky top-20 self-start`) that stays in view while you scroll.
- The live agent output no longer has its own inner scroll box — it flows down the page and is **scrolled by the page**. Autoscroll now follows the window when you're near the bottom.

Verified: web type-check clean, `vite build` succeeds, all 13 tests pass. Committed on branch `ticket/cqicEXp7-sticky-agent-info` (not yet merged to main, pending review).
