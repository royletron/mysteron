---
name: runner/isolation
description: How a local run gets its node_modules in the isolated worktree (symlink vs fresh install)
metadata:
  type: project
---

`src/runner/manager.ts` isolates each local run in a per-run git worktree (`setUpIsolation` → `addRunWorktree`). It then provisions `node_modules` via `prepareNodeModules`:

- **Common case — symlink.** No lockfile change → symlink the host's `node_modules` into the worktree (near-instant, shares the build cache). Skipped silently when the host has no installed tree.
- **Changed lockfile — fresh install.** When `lockfileChange(projectRoot)` (in `src/core/git.ts`) reports an **uncommitted** lockfile edit (modified/staged/untracked, via `git status --porcelain`), the host's installed tree is stale *and* a shared symlink would leak the run's own install back into it — so it runs the manager's install in the worktree's own `node_modules` (`INSTALL_ARGS` per `pnpm`/`npm`/`yarn`/`bun`). Best-effort: a failed install logs `⚠ isolated install failed` and falls back to the host symlink. (Ticket `xrtI7Mmj`.)

Detection is **up front** and only catches *uncommitted* working-tree lockfile drift — a committed-but-not-reinstalled lockfile (the "compare against last-installed" alternative from the ticket) is not handled; the chosen heuristic is the documented design.

**Testing gotcha.** A run whose snapshot carries a lockfile change leaves the host working tree dirty, so its result lands on a **new branch**, not the current-branch working tree (landGuestPatch avoids clobbering a dirty tree — see [[core/git]]). Don't assert on a file appearing in the host checkout for that path; assert on the run's `system` log lines (`installing deps in the isolated tree`) instead. The clean symlink case (clean tree) does land on the current branch. Both branches are covered in `test/runner.test.ts`; `lockfileChange` itself is unit-tested in `test/git.test.ts`.
