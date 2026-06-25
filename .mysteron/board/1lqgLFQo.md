---
title: Mysteron Commits
state: done
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-25T17:12:23.593Z'
updated: '2026-06-25T17:54:23.833Z'
---

In the 'commits' list, can we put Mysteron commits as the logo? They seem to have 'mysteron@local' as the email with no companion.

---
**Done.** `recentCommits` now reads the author email (`%ae`) and sets a `mysteron` flag when it's `mysteron@local`. The Commits tab renders the Mysteron mark (the header logo) for those commits, falling back to the blank avatar only for non-Mysteron, non-companion authors. Companion commits still show their avatar.

Files: `src/core/git.ts`, `web/src/api.ts`, `web/src/tabs.tsx`, plus a `recentCommits` test in `test/git.test.ts`.

Tests: full suite green (52 passing), typecheck clean. Commit `0f9ffbe`.
