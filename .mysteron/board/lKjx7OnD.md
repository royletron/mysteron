---
title: Tone down Pulsing
state: bin
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-23T21:19:38.702Z'
updated: '2026-06-25T16:45:25.726Z'
---

Two things.

1. Not sure the 'companion' needs to pulse when something is running
2. Only the running ticket should pulse, the other tickets that are blocked should just show a disabled run button

---

## Work log — Waldorf the Compiler

Both done.

**1. Companion no longer pulses.** Removed the `pulse-ring` halo from the companion avatar in all three places it appeared — the board ticket card, the companion row (Companions tab), and the ticket page header. Deleted the now-unused `.pulse-ring` class and `@keyframes pulse-ring` (and its `prefers-reduced-motion` entry). The small `LiveDot` status dots (next to "running"/"working") are kept — those mark the running state itself, not the companion.

**2. Only the running ticket pulses on the board.** The board now derives the set of actually-running tickets from `detail.activeRuns[].ticketId`:
- The ticket that is **running** shows the pulsing `LiveDot` on its run button (title "Agent is running on this ticket").
- Tickets merely **blocked** (their companion is busy on a different ticket) now show a plain **disabled `▶`** button — no pulse (title "… is busy with another ticket").
- Idle tickets show the normal enabled `▶`.

Verified: `npm run typecheck` clean, `vite build` succeeds, `npm test` 17/17 pass. Committed as `aefcd48` with the `Mysteron-Companion: Waldorf the Compiler` trailer.

Note: the working tree currently also has unrelated in-progress changes from another agent (a CodeEditor → Prism refactor touching `CodeEditor.tsx` and adding `.md-hl` rules to `styles.css`). I deliberately left those uncommitted and untouched — my commit contains only the four files for this ticket.
