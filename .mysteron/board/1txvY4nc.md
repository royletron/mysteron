---
title: Agent Screen Back Button
state: bin
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-23T20:16:43.269Z'
updated: '2026-06-25T16:45:25.721Z'
---

On the agent screen can we make the back button 'stick' along with the runner info?

---

## Work log — Waldorf the Compiler

Done. The **← board** link previously lived in the page header, which scrolls away. I moved it into the top of the `sticky top-20` runner-info card, so it now stays pinned alongside the state pill, timer and ticket info while you scroll the agent log. The page header is now just the companion avatar + ticket title.

File: `web/src/TicketPage.tsx`.

Verified: `npm run typecheck` clean, `vite build` succeeds, `npm test` 17/17 pass. Committed as `8467efb` with the `Mysteron-Companion: Waldorf the Compiler` trailer.
