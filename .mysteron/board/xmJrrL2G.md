---
title: Pulses
state: done
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-23T19:45:38.161Z'
updated: '2026-06-23T21:40:00.119Z'
---

# Make it good!
When something is running can we have some sort of pulse effect? We should stick this everywhere we show a running state? Animate anything that looks like it could do with showing it's running

---

## Work log — Waldorf the Compiler

Done. Added three reusable, reduced-motion-safe animations in `web/src/styles.css`:

- **`.live-dot`** — a solid dot in the current text colour with a halo that expands and fades (the classic "live" pulse). Exposed as a `<LiveDot/>` component in `ui.tsx` that inherits `currentColor`.
- **`.pulse`** — gentle opacity breathing for text/loaders.
- **`.pulse-ring`** — a pulsing halo around a working companion's avatar.

Wired them into **every** running/live state:

- Run status + autopilot status labels (`● running` → animated `LiveDot` + "running") — `api.ts`, `Board.tsx`, `TicketPage.tsx`, `TicketPanel.tsx`
- Ticket page status pill and the "Agent is working…" line
- Agent-history "view live" links
- Board ticket-card run button (busy dot) and the busy companion's avatar (pulse-ring)
- Companion tab "working: …" line + that companion's avatar
- The header **live-updates** connection dot (pulses when connected, static when offline)
- `Loading` component and inline "Loading…" texts now breathe

The amber "● unsaved" doc-dirty dots were left alone — that's an edit state, not a running state.

Verified: `npm run typecheck` clean, `vite build` succeeds, `npm test` 17/17 pass. Committed as `57a6c23` with the `Mysteron-Companion: Waldorf the Compiler` trailer.
