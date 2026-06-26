---
title: Isolate local runs (implement chosen worker-isolation option)
state: ready
priority: high
createdBy: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels:
  - enhancement
  - needs-decision
created: '2026-06-26T10:15:52.771Z'
updated: '2026-06-26T10:39:15.435Z'
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
