# Worker isolation — options for ticket `iTunKOwa`

_Design write-up for ticket iTunKOwa ("Work Tree/Commits"), by Waldorf the Compiler, 2026-06-26._

## The problem, precisely

Local companions step on each other because they all run **in the same checkout**.
`RunManager.start()` spawns the agent with `cwd: projectRoot` (`src/runner/manager.ts`),
and the autopilot loop fans **every** free companion into that one working tree at
once (`src/runner/autopilot.ts`, step 4). So two local agents working in parallel:

- see each other's half-finished edits,
- `git add -A` and commit one another's work,
- break the build for each other mid-task.

Crucially, **remote (guest) workers already do the right thing** and have done since the
fan-out landed. `startOnWorker()` →

1. `captureSnapshotRef()` pins the host's working tree as a commit (tracked **and**
   untracked-but-not-ignored files), via a throwaway index that never touches the real
   checkout (`src/core/git.ts`).
2. The snapshot is served as a tar; the guest unpacks it into its **own throwaway repo**,
   does its thing, and returns a `git diff --binary` patch.
3. `landGuestPatch()` builds the commit in a temporary worktree off HEAD, `git apply
   --3way`s the patch, and lands it **under the project's commit strategy** — fast-forward
   onto the current branch when the tree is clean, else a dedicated `<prefix><ticket>`
   branch (`src/core/recipes.ts` `RecipeGit`).

That flow is exactly the three steps the ticket asks for (clean tree → work → return
commits through the project strategy). The job, then, is **not to invent isolation — it
already exists for remote — but to put local runs through the same kind of door.** Do
that and the commit strategy (straight-to-`main` vs branch) automatically applies
identically to local and remote workers, which is the parity the ticket calls for.

## What "clean version + node_modules" means here

`captureSnapshotRef` stages with `git add -A`, which honours `.gitignore` — so
`node_modules/` is **not** in the snapshot. An isolated tree therefore starts without
installed deps. Two ways to deal with that, usable by any option below:

- **Symlink** the host's `node_modules` into the isolated tree. Near-instant, shares the
  build/Vite cache, correct as long as the ticket doesn't change dependencies. Risk: a
  ticket that mutates deps mutates the shared store.
- **`pnpm install`** in the isolated tree. pnpm's global content-addressed store makes
  this a hardlink-and-go in seconds even on a cold tree, and it's always correct.

Recommended default: **symlink, with an install fallback when the lockfile changed in
the diff.** Cheap in the common case, correct in the rare one.

## Options

| # | Approach | Isolation | node_modules | Reuses today's code | Cost |
| - | -------- | --------- | ------------ | ------------------- | ---- |
| **A** | **`git worktree` per local run** (recommended) | Full | symlink / install | High — lands via existing `landGuestPatch` | Low |
| B | **Loopback guest** — local run = guest dialing localhost | Full | install (tar excludes it) | Highest — literally the guest runner | Medium |
| C | **`git clone --local` per run** | Full (separate object DB) | symlink / install | Medium | Medium |
| D | **Serialize local companions** (a checkout lock) | None | n/a | Trivial | Kills parallelism |

### A — Worktree per local run  ⭐ recommended

Swap `cwd: projectRoot` for a per-run `git worktree add <tmp> <snapshotRef>` off the
captured snapshot, run the agent there, then feed the resulting diff through the **same**
`landGuestPatch()` the guests already use. Tear the worktree down on finish (mirrors the
temp-worktree teardown already in `landGuestPatch`).

- **For:** smallest change that unifies local + remote on one strategy-aware landing path;
  shares the object DB (no clone); keeps build caches via symlinked `node_modules`.
- **Against:** worktrees need disciplined cleanup (an orphaned `.git/worktrees/` entry if a
  run is killed — already a solved pattern in `landGuestPatch`, so reuse it); symlinked
  deps mutate the shared store if a ticket changes dependencies (mitigated by the install
  fallback).

### B — Loopback guest

Make a local run a guest that connects to its own host: extract the snapshot tar to a
temp dir, run, diff, return the patch. One runner for both local and remote.

- **For:** maximum reuse — local and remote become the *same* code path, not just the same
  landing step.
- **Against:** the tar excludes `node_modules`, so every run installs unless we also seed
  deps; an extra process/transport hop for what is a same-machine run; harder to debug.

### C — Cheap local clone

`git clone --local` (hardlinked objects) into a temp dir per run, work, land via
`landGuestPatch`.

- **For:** dead-simple mental model; total isolation.
- **Against:** separate object DB (landing must apply across repos — `landGuestPatch`
  already works from a patch, so OK, but it's more moving parts than a worktree); more
  disk churn than A.

### D — Serialize local companions

Don't isolate; just take a per-checkout lock so only one local run touches the tree at a
time.

- **For:** trivial; removes the "committing each other's work" failure immediately.
- **Against:** kills the concurrency that is the whole point of the fan-out, and a run that
  leaves a half-finished/broken commit still breaks the build for the next one. Stopgap
  only.

## Recommendation

**Option A**, with `node_modules` symlinked (install fallback on lockfile change).
It's the least code, reuses the strategy-aware `landGuestPatch` so **local and remote
workers commit through one identical path**, and keeps the build cache warm. Options B/C
are viable if we'd rather collapse local and remote into a single runner outright; D is a
stopgap, not a fix.

## Notes / adjacent work

- Isolating the **working tree** does not isolate **board writes**. Concurrent companions
  still read-modify-write `.mysteron/` tickets with bare `fs.writeFile`; that race is
  tracked separately as `__J9CotP` (atomic/locked board writes) and should land alongside
  whichever option we pick, or the board itself stays a shared-mutation hazard.
- Whichever option, the **commit strategy needs no remote-specific work** — guests already
  honour it through `landGuestPatch`. Picking an option here is purely about bringing local
  runs up to the same bar.
