---
title: Isolate Local Run
state: review
priority: medium
companionId: 82be1826-9999-453f-bbfc-999f8dc4a2dc
assignee: Zoot the Swift
labels: []
created: '2026-06-26T10:34:18.445Z'
updated: '2026-06-26T11:32:51.046Z'
order: 1
---

Follow-up to `iTunKOwa`. See `.mysteron/docs/WORKER-ISOLATION.md` for the full analysis and four options.

**Root cause:** local runs spawn the agent with `cwd: projectRoot` (`src/runner/manager.ts`) and the autopilot fans every free companion into that one shared checkout, so they see and commit each other's work and break the build for each other. Remote/guest runs are already isolated (snapshot → throwaway repo → patch → strategy-aware `landGuestPatch`).

**Recommended:** Option A — `git worktree` per local run off the captured snapshot, landing the result through the existing `landGuestPatch` so local and remote commit through one identical, strategy-aware path. node_modules: symlink the host's tree, falling back to `pnpm install` when the lockfile changed.

Can we make sure that we are following the commit strategy for the project - we made also need to make that an explicit option for the project. There are three:

1. Always commit to `main`
2. Always commit to `other-branch` (editable)
3. Always create a branch per ticket, which is then up to the user to review and merge

Once selected, both local and remote changes need to adhere to this.

---

## Progress — Zoot the Swift

Most of Option A was already in place on the current branch and covered by tests:

- **Worktree isolation** — local runs no longer use `cwd: projectRoot`. `RunManager.setUpIsolation` snapshots the working tree (`captureSnapshotRef`), checks it out in a per-run `git worktree` (`addRunWorktree`), runs the agent there, and lands the diff through the same `landGuestPatch` guests use. Worktrees are torn down on finish (`teardownIsolation`); falls back to running in place for non-git projects.
- **Commit strategy as an explicit project option** — `ProjectConfig.commit` (`CommitStrategy`) with the three requested modes: `main`, `branch` (editable name), `per-ticket`. `resolveProjectGit` resolves it over the recipe default, and **both** `landLocalRun` and `applyGuestResult` (local + remote) commit through it, so the choice applies everywhere. Editable in the web UI (Commit-strategy card), settable via `PATCH /api/projects/:id/config`, and reflected in the agent prompt (`gitInstruction`).

**What I added this pass:** the missing node_modules step from the recommendation — the install fallback when the lockfile changed. Previously `node_modules` was always symlinked, which is stale (and shared-store-corrupting) when the run's snapshot carries a changed lockfile. `lockfileChange` (in `core/git.ts`) detects a changed lockfile and its package manager; `prepareNodeModules` then installs into the worktree's own `node_modules` instead of symlinking, falling back to the symlink if the install fails. Commit `c0938c9`.

Tests: `npm test` — 91 pass (added two `lockfileChange` cases). `npm run typecheck` clean.

Note: concurrent board (`.mysteron/`) writes remain a separate race, tracked as `__J9CotP` per the design doc — out of scope here.
