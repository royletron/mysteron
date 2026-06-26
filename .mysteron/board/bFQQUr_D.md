---
title: Better 'Guest' View
state: review
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-25T18:12:44.496Z'
updated: '2026-06-26T11:27:04.076Z'
order: 4
---

It would be good if the terminal for Guests could be a bit more exciting... Some sort of TUI, logs, spinners, colors, stats, whatever?!?

---

**Done by Waldorf the Compiler.**

The "Guest" terminal is what you see when a machine runs `mysteron join <host>`. It was plain `[guest] …` lines and didn't even show the agent's own output locally (it only forwarded it to the host). Now, on an interactive TTY it renders a live dashboard:

- 🎭 header with the guest label and a coloured connection badge (connecting/offered/rejected/stopped) + braille spinner
- Offer countdown ("1h 20m left · up 10m 00s")
- Aggregate work stats: active count, done✓/failed✖/stopped■, total cost, total turns
- A live, stream-coloured tail of agent output for each active run, with per-run cost/turns

Implementation:
- `src/worker/guest-tui.ts` — new `GuestTui` controller + a pure, tested `renderFrame`/`formatDuration`.
- `src/worker/guest.ts` — `GuestConnection` now exposes run-lifecycle hooks (start/line/stats/done) so the guest mirrors run output locally; `handleDispatch` returns its outcome. `joinHost` uses the TUI on a TTY and keeps plain line logging for pipes/CI (and respects `NO_COLOR`).

Tests: added `test/guest-tui.test.ts` (9 tests). Full suite green (67 pass), typecheck clean.
