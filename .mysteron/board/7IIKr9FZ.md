---
title: Branch Merging
state: done
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-25T16:50:25.169Z'
updated: '2026-06-25T17:54:23.819Z'
---

This is getting a little complicated, but it seems really hard to merge branch changes. Mainly because we don't commit new tickets/ticket changes - so they tend to sit as uncomitted changes and then the merge fails. Could we do a check locally to see if it's just `.mysteron` changes and automatically commit them? Then run the branch merge? We also need to delete the branch after successful merge - or follow githubs lead and show whether the branch is merged, and allow deletion in the UI at that point?

---

**Done (in review):**

- `mergeBranch` now inspects the working tree and, when the only pending changes are under `.mysteron/` (tracked edits *or* untracked new ticket files), auto-commits them via a scoped pathspec commit before merging. New `commitBoardChanges()` helper does the surgical commit.
- Safety: any tracked change to the user's *own* files still refuses the merge — their work is never swept into a commit. Untracked non-board files are left for git's own merge to handle (preserves prior behaviour). Pass `{ autoCommitBoard: false }` to opt out.
- Followed GitHub's lead for deletion: `listBranches` returns a `merged` flag (branch tip is an ancestor of the current branch). The web Branches tab shows a green **Merged** badge in place of the Merge button, keeps the delete button with a softer confirm, and toasts when board changes were auto-committed during a merge.
- Tests: added 3 git tests (auto-commit board-only + merge; refuse on real local edits; `commitBoardChanges` leaves staged user work alone) and assert the `merged` flag in the round-trip test. Full suite green (49/49), typecheck clean (server + web).

Two small commits on `main`: `8cb8ac9` (core/git + tests), `3e03ee1` (web UI).
