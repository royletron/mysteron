---
title: Add CI (typecheck + tests) and a linter/formatter
state: backlog
priority: medium
labels:
  - tech-debt
  - ci
created: '2026-06-25T19:06:13.014Z'
updated: '2026-06-25T19:06:13.014Z'
---

**Gap.** No `.github/workflows`, no ESLint/Prettier/Biome config, no pre-commit hook. The etiquette says *"always run the tests"* but nothing enforces it — and the suite silently "fails" on a fresh checkout until `npm install` is run (tsx missing), which a CI job would catch immediately.

**Fix.**
- GitHub Actions workflow: `npm ci` → `npm run typecheck` → `npm test` on push/PR.
- Add a formatter/linter (Biome is a single-dep option) and wire it into the workflow.
- Optional: a pre-commit hook running typecheck + tests.

**Acceptance.** CI is green on `main` and runs on every PR; `npm run lint` exists.
