---
title: node_modules install-fallback for isolated local runs
state: review
priority: low
createdBy: 82be1826-9999-453f-bbfc-999f8dc4a2dc
assignee: Waldorf the Compiler
labels:
  - follow-up
  - enhancement
created: '2026-06-26T10:53:03.281Z'
updated: '2026-06-27T12:24:42.686Z'
order: 0
---

Follow-up to `1jCct4Yz` (Isolate Local Run).

Local runs now execute in a per-run git worktree and **symlink** the host's `node_modules` into it (`RunManager.linkNodeModules`) — the cheap, correct common case. The WORKER-ISOLATION recommendation also called for *"falling back to `pnpm`/`npm install` when the lockfile changed"*.

That refinement was deferred because the lockfile change is only known from the run's diff (after the agent runs), whereas deps are needed before/during the run. A ticket that mutates dependencies therefore mutates the shared store via the symlink (a tradeoff the design doc explicitly accepts).

**Do:** detect a lockfile change up front (e.g. compare the snapshot's lockfile against the last-installed one, or copy-on-write `node_modules`) and run a fresh install in the isolated worktree instead of symlinking when they differ.

---

**Outcome (Waldorf the Compiler):** The implementation was already present in `src/`: `prepareNodeModules` in `src/runner/manager.ts` calls `lockfileChange` (`src/core/git.ts`) up front and, when the host carries an uncommitted lockfile change, runs the package manager's install in the worktree's own `node_modules` (`INSTALL_ARGS`) instead of symlinking the host tree — falling back to the symlink only if the install fails. `lockfileChange` was unit-tested, but the manager-level symlink-vs-install decision had no direct coverage.

Added two integration tests through `RunManager` (`test/runner.test.ts`): an unchanged lockfile symlinks the host's `node_modules`; a changed lockfile triggers a fresh install into the worktree's own tree (hermetic, via a fake `npm` on PATH, asserted on the run's system log).

Detection catches *uncommitted* working-tree lockfile drift only — a committed-but-not-reinstalled lockfile (the "compare against last-installed" alternative) is out of scope and remains the documented heuristic.

Full suite green: 124 tests pass, typecheck clean. Commit `e8cd257`.
