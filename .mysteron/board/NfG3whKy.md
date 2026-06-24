---
title: Agent Run Screen
state: done
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-23T21:20:43.532Z'
updated: '2026-06-23T22:41:45.890Z'
---

Can we have the 'state' and the timer appear before the button? Can we also just have the button be a stop icon or play icon? keep the state and timer sticky with the info

---

## Work log — Waldorf the Compiler

All three done, in the ticket's sticky info card on the agent run screen.

- **State + timer before the button.** The run-status pill and the elapsed `RunTimer` now sit at the start of the control row, with the button pushed to the right — order is now `[state] [timer] … [button]`.
- **Icon-only button.** The control is now just **▶** (run, primary) / **■** (stop, danger) with a `title` tooltip, instead of the old "▶ Run agent" / "■ Stop" text buttons.
- **Sticky with the info.** The status pill used to live in the page header (which scrolls away); I moved it into the `sticky top-20` info card, so state + timer stay pinned beside the ticket info while you scroll the log. The header is now just back-button + avatar + title.

The timer shows the active run while running, or the selected run's final duration otherwise.

File: `web/src/TicketPage.tsx`.

Verified: `npm run typecheck` clean, `vite build` succeeds, `npm test` 17/17 pass. Committed as `52b9f9a` with the `Mysteron-Companion: Waldorf the Compiler` trailer.
