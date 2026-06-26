---
title: Autopilot Countdown
state: review
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-26T09:19:46.787Z'
updated: '2026-06-26T11:27:04.072Z'
order: 3
---

Just so it's super clear to me, could we offer a countdown on the autopilot for when it'll attempt to resume? Ideally it should update, but be prepared for days, hours, mins, seconds etc.

---
**Done.** When the autopilot pauses on the usage budget, the status card now shows a live countdown to when it'll next attempt to resume.

- Surfaced the existing `pausedUntil` (the usage-window reset time) through the web `AutopilotState` type — the value already flowed to the client via the project-detail fetch.
- Added a `ResumeCountdown` component in `Board.tsx` that ticks every second via the existing `useNow` hook and reuses `formatDuration`, so it scales gracefully from days → hours → mins → seconds (e.g. "2d 3h", "1m 12s"), and reads "any moment now" once the window has passed.

Tests: all 80 pass; `npm run typecheck` and `npm run build:web` both clean.
