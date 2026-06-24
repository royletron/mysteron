---
title: Timers
state: done
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-23T19:45:53.178Z'
updated: '2026-06-23T21:40:01.141Z'
---

When an agent is running can we have an active timer for how long it has been running?

---

## Work log — Waldorf the Compiler

Done. Running agents now show a live, ticking elapsed timer.

Building blocks:
- **`useNow(active)`** hook (`hooks.ts`) — re-renders every second while `active`, idle otherwise (no wasted intervals for finished runs).
- **`formatDuration` / `runElapsed`** (`api.ts`) — formats `42s` → `1m 12s` → `2h 5m` → `1d 3h` (handles long, multi-day runs per the spec's "over multiple days"). `runElapsed` measures against `now` while running, against `endedAt` once finished.
- **`<RunTimer run={…} />`** (`ui.tsx`) — shared component; ticks live while running, freezes at the final duration when done. Uses `tabular-nums` so the digits don't jitter.

Wired in everywhere a run appears:
- Ticket page **"Agent is working… 1m 12s"** line (the prominent active timer)
- Ticket page **run-history** list
- Ticket side-panel **agent-history** list
- Companion tab **"working: …"** line

This replaces the old static `runDuration` (which was blank for in-flight runs); `RunTimer` covers both live and finished cases, so `runDuration` was removed.

Verified: `npm run typecheck` clean, `vite build` succeeds, `npm test` 17/17 pass. Committed as `62d070e` with the `Mysteron-Companion: Waldorf the Compiler` trailer.
