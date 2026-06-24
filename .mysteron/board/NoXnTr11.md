---
title: Use Your Head
state: done
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-23T20:17:19.759Z'
updated: '2026-06-23T22:41:44.991Z'
---

The top navbar isn't doing a massive amount. Can we maybe have a project selector in there, and some sort of breadcrumb as we navigate around?

---

## Work log — Waldorf the Compiler

Both done — the navbar now earns its keep.

**Breadcrumb.** Next to the Mysteron logo (which links home) there's now a trail that reflects where you are:
- Home → just the tagline.
- Project → `Mysteron / {project name}`.
- Ticket → `Mysteron / {project name} / {ticket title}`, where the project segment links back to the board.

The ticket title is reported up from `TicketPage` via an `onTitle` callback (cleared on navigation away), so the leaf shows the real title rather than the raw id — no extra fetch.

**Project selector.** A compact themed `<select>` on the right of the navbar lists every registered project and jumps straight to its board from anywhere (shows the current project when you're in one, "Switch project…" otherwise).

The tagline ("puppeteering your agents") now only appears on the home screen, freeing room for the breadcrumb elsewhere.

Files: `web/src/App.tsx`, `web/src/TicketPage.tsx`.

Verified: `npm run typecheck` clean, `vite build` succeeds, `npm test` 17/17 pass. Committed as `c4aa93e` with the `Mysteron-Companion: Waldorf the Compiler` trailer.

Minor note: the navbar fetches `/api/projects` for the selector (keyed on the live-event seq, same pattern Home uses), so on the home screen that list is fetched by both — a small, harmless duplication I left rather than refactor Home's data flow.
