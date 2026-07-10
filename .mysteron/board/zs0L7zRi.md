---
title: 'Git: host-as-origin live push for remote (guest) workers'
state: review
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
createdBy: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels:
  - v2
  - git
created: '2026-06-30T13:15:09.914Z'
updated: '2026-07-10T08:49:37.199Z'
order: 0
---

Follow-up from `r4zbwCW8`, which delivered the **local** half of the git rework (branch-per-ticket up front, commit-onto-branch, resume from the ticket branch) plus the design note `docs/GIT-WORKFLOW.md`. This ticket is the **remote** half (parts 3 and remote-4 of that design).

Today a guest worker runs in a throwaway repo off a downloaded snapshot and returns one squashed diff (`patchBase64`), which the host applies via `landGuestPatch`. Goal: let a guest commit straight onto the ticket branch on the host, live, so its work survives the guest's death and a re-run resumes from it.

**Scope:**
1. **Host serves git over HTTP.** Expose the repo at an authenticated worker path (git smart-HTTP / `receive-pack`), reusing the guest token used for the snapshot/MCP. Add a `gitPath` to `DispatchMsg` (alongside `snapshotPath`/`mcpPath`) that the guest turns into a remote URL.
2. **Guest pushes to the host.** Instead of (or as well as) returning a diff, the guest sets the host as `origin`, fetches `<prefix><ticketId>` (created up front by `ensureTicketBranch`), commits onto it, and `git push origin <ticketBranch>` as it works.
3. **Ref guard.** Host accepts pushes only to `refs/heads/<prefix>*` ticket branches — never `main`/the checkout (pre-receive hook).
4. **Resume + fallback.** A dead guest leaves the branch on the host; a re-run (local or remote) continues from it. Keep the diff-return path (`landGuestPatch`) as the fallback when git-HTTP is unavailable (offline/locked-down host).

**Touches:** `src/worker/guest.ts` (push loop), `src/core/worker-protocol.ts` (`DispatchMsg.gitPath`), `src/server/workers.ts` / `src/server/api.ts` (git-HTTP endpoint + auth + ref guard), `src/runner/manager.ts` `startOnWorker` (ensure ticket branch up front for guests; stop relying on `captureSnapshotRef` for this path), `core/git` (`ensureTicketBranch` already exists). See `docs/GIT-WORKFLOW.md` part 3.

**Known edge to resolve:** when a per-ticket ticket runs locally first (creating `mysteron/<id>`) then later on a guest, today's snapshot+`landGuestPatch` path would create a divergent `mysteron/<id>-<runId>` branch on collision. Host-as-origin removes that by having both paths push to the one branch.
