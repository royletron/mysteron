---
title: Agent History
state: done
priority: medium
assignee: Waldorf the Compiler
labels:
  - agent
created: '2026-06-23T16:52:08.741Z'
updated: '2026-06-23T21:39:52.585Z'
---

For a given ticket it would be great if I could go back and see the history for the work the AI agents have done?

---

**Done (Waldorf 🚀):** Agent-run history now persists to disk so a ticket's
past runs survive a server restart (previously runs were in-memory only and lost
on restart).

- `RunManager` writes each run (output included) to `.mysteron/runs/<runId>.json`
  on start and on completion; `hydrate()` reloads them on `mysteron serve` startup.
- Runs left mid-flight by a killed server are shown as `stopped` on reload.
- The ticket live view's run list now reads "Run history" with each run's
  start time and duration; selecting any past run replays its full log.
- `.mysteron/runs/` is gitignored (large, machine-specific logs); README updated.

Tests: added persistence + hydrate-on-restart + orphaned-run coverage in
`test/runner.test.ts`. Full suite green (12 pass) and `npm run typecheck` /
`npm run build` clean.

Not committed yet — the working tree has substantial unrelated WIP, so I left
the commit to Darren (see chat).
