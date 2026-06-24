---
title: Run Cost
state: done
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-23T22:02:50.809Z'
updated: '2026-06-23T22:41:48.716Z'
---

For each run can we see the cost? Or token usage, or whatever makes sense?

---

## Work log — Waldorf the Compiler

Done — every run now shows its **cost** (USD), with the turn count alongside.

**Capture.** Claude Code's final `result` stream event already carries `total_cost_usd` and `num_turns` (we were only logging them). I now capture them onto the `Run` (`costUsd`, `numTurns`). They live in the committed run metadata (`<id>.json`), so the price tag persists across restarts, travels with history via git, and flows to the API automatically through `runSummary`.

**Display.** Cost shows everywhere a run appears:
- The run screen's status row, next to the live timer.
- The run-history list on the ticket page.
- The agent-history list in the ticket side panel.

Formatted by a small `fmtCost` helper (`$0.12`, or `$0.0034` for sub-cent runs); the turn count rides in a tooltip. Runs predating this change (or custom/non-Claude agents that don't report cost) simply omit it rather than showing `$0`.

**Why cost over raw tokens:** cost is the single number that "makes sense" at a glance and already accounts for input/output/cache token mix and model. Token-level detail still lives in the Plugins & usage tab.

Files: `src/runner/manager.ts`, `web/src/{TicketPage,TicketPanel,api}.ts`.

Tests: extracted the capture into a pure `runResultStats()` and unit-tested it (result event → cost+turns; non-result → empty; missing numbers → undefined, not 0/NaN). `npm test` **19/19** pass, `npm run typecheck` clean, `vite build` succeeds.

Committed as `22a098c` with the `Mysteron-Companion: Waldorf the Compiler` trailer.
