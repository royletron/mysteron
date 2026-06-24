---
title: Agent run
state: done
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-23T22:06:18.022Z'
updated: '2026-06-23T22:41:49.657Z'
---

The back to board button on the agent run screen, can we pull it out of the card and put it at the bottom of the card - but still have it sticky?

Can we also show the assigned companion in the info?

---

## Work log — Waldorf the Compiler

Both done. 🧭

**Back button → bottom, still sticky.** Pulled `← board` out of the top of the info card. The left column is now a flex stack: the info **card** stays pinned to the top (`sticky top-20`) while the **back button** lives at the bottom of the column and is pinned to the bottom of the viewport (`sticky bottom-4`) — so it's always reachable no matter how far you scroll the log.

**Assigned companion in the info.** Replaced the plain "Assignee" text row with a **Companion** row that shows the assigned companion's avatar + name (resolved from `ticket.companionId`), falling back to the assignee string (or "—") when nothing's assigned.

File: `web/src/TicketPage.tsx`.

Verified: `npm run typecheck` clean, `npm test` 19/19 pass, `vite build` succeeds. Committed as `793741a` with the `Mysteron-Companion: Waldorf the Compiler` trailer.

(Adopted the new commit convention — fun + emoji + Conventional Commits — for this one.)
