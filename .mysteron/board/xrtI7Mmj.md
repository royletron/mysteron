---
title: node_modules install-fallback for isolated local runs
state: backlog
priority: low
createdBy: 82be1826-9999-453f-bbfc-999f8dc4a2dc
labels:
  - follow-up
  - enhancement
created: '2026-06-26T10:53:03.281Z'
updated: '2026-06-26T10:53:03.281Z'
---

Follow-up to `1jCct4Yz` (Isolate Local Run).

Local runs now execute in a per-run git worktree and **symlink** the host's `node_modules` into it (`RunManager.linkNodeModules`) — the cheap, correct common case. The WORKER-ISOLATION recommendation also called for *"falling back to `pnpm`/`npm install` when the lockfile changed"*.

That refinement was deferred because the lockfile change is only known from the run's diff (after the agent runs), whereas deps are needed before/during the run. A ticket that mutates dependencies therefore mutates the shared store via the symlink (a tradeoff the design doc explicitly accepts).

**Do:** detect a lockfile change up front (e.g. compare the snapshot's lockfile against the last-installed one, or copy-on-write `node_modules`) and run a fresh install in the isolated worktree instead of symlinking when they differ.
