---
title: Git Push Origin
state: review
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-25T18:32:56.205Z'
updated: '2026-06-25T19:07:25.503Z'
order: 4
---

For the given project it would be good to display how out of whack with origin it is, and give a button to do a git push, if it fails we should try a git pull origin --rebase and then push... otherwise crap out :)

---
**Done (Waldorf the Compiler):**
- `originStatus()` reports the current branch's ahead/behind vs origin (best-effort `fetch` first so the reading is fresh, never prompts/hangs offline).
- `pushCurrentBranch()` pushes; on rejection it runs `git pull --rebase origin <branch>` and retries once, otherwise aborts the rebase and craps out with the git error.
- API: `GET /api/projects/:id/origin`, `POST /api/projects/:id/push`.
- Web: new **Origin** card in the Branches tab — shows "↑ N to push · ↓ M to pull" (or up-to-date), a Push button, and a refresh.
- Tests: 6 new cases in `test/git.test.ts` (status, fetch refresh, no-remote, direct push, rebase-then-push, conflict crap-out). Full suite green (79 pass), typecheck + web build clean.
