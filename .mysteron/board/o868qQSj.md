---
title: Project Board
state: done
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-23T21:23:00.502Z'
updated: '2026-06-23T21:40:05.708Z'
---

1. Collapse the AutoPilot if not running, move the button inline with the 'add ticket' button but to the right of the window.
2. Remove the left border from all of the cards
3. When we scroll down can the 'board | docs | memory etc' tabs stick at the top of the page? Maybe move the new ticket and autopilot buttons in line with this (as buttons not tabs)

---

## Work log — Waldorf the Compiler

All three done, as one coherent layout pass.

**3 (sticky tabs + inline actions).** The `Board | Docs | Memory | …` tab bar is now `sticky` and parks just under the app header when you scroll. I took up the "maybe move the buttons in line with this" suggestion: on the **board** tab, the right of that bar now holds **+ Add ticket** and the autopilot Start/Stop button (plain buttons, not tabs). To support this, ticket editing was lifted into `Project`, so the side panel opens from both the toolbar and from clicking a card.

**1 (collapse autopilot + button right).** When autopilot isn't running there's no card at all — just the compact **🤖 Start autopilot** button on the right of the toolbar, beside Add ticket. While it's running the button becomes **■ Stop autopilot** and the status/activity card appears in the board body.

**2 (flat cards).** Removed the `border-l-[3px]` priority accent from ticket cards; priority is still shown via its tag. Also deleted the now-unused `PRIORITY_BORDER` constant.

Files: `web/src/Project.tsx`, `web/src/Board.tsx`, `web/src/api.ts`.

Verified: `npm run typecheck` clean, `vite build` succeeds, `npm test` 17/17 pass. Committed as `480c2cb` with the `Mysteron-Companion: Waldorf the Compiler` trailer.

Note: the sticky bar is offset `top-[52px]` to sit just beneath the existing sticky app header — worth a quick visual check at review since that offset is tied to the header's current height.
