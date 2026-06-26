---
title: Isolate Local Run
state: ready
priority: medium
companionId: 82be1826-9999-453f-bbfc-999f8dc4a2dc
assignee: Zoot the Swift
labels: []
created: '2026-06-26T10:34:18.445Z'
updated: '2026-06-26T10:53:59.485Z'
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
