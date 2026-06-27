---
title: 'v2: Persist and auto-resume autopilot across server restarts'
state: review
priority: medium
createdBy: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels:
  - v2
  - reliability
created: '2026-06-27T11:07:44.989Z'
updated: '2026-06-27T13:03:35.180Z'
order: 1
---

**Reliability gap (raised by review `aX6J81M_`).** Autopilot state is in-memory only and does not survive a restart — which undercuts the "set up a board and leave it running across days" goal, since a server bounce (crash, deploy, OS reboot, `tsx watch` restart) silently stops the churn.

**Today.** `Autopilot` keeps `states`/`stopFlags` in `Map`s (`src/runner/autopilot.ts`); nothing is written to disk. On restart, `RunManager.hydrate()` correctly reloads run history and marks interrupted local runs as `stopped`, **but the autopilot loop itself is gone** and is not restarted unless something calls `start()` again. So a board that was happily churning just… stops, with no signal.

**Proposal.**
- Persist per-project autopilot intent (running/stopped + the yolo flag) to `.mysteron/` so it's shared and survives restarts.
- On `serve` startup, auto-resume autopilot for any project whose persisted intent is "running".
- Reconcile on resume: any ticket left in `in-progress` with no live run is requeued (ties into the retry-policy ticket) rather than stranded.

**Acceptance.** Killing and restarting `mysteron serve` resumes autopilot for projects that had it on, with no manual click; an `in-progress` ticket orphaned by the restart is picked back up. Tests cover persist → restart → resume + orphan reconciliation.
