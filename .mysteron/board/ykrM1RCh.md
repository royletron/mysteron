---
title: Guest companion Commits
state: review
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-25T17:59:27.634Z'
updated: '2026-06-25T18:06:00.974Z'
order: 1
---

We tried to fix this in a previous ticket, but I am still seeing commits from guests that clearly aren't adhering to what has been set in the companion spec - I worry that this might mean they're not getting that spec at all?

---

## Good news: they *are* getting the spec

The companion brief reaches guests. `buildPrompt()` embeds it under a `# Your brief` heading, and **both** run paths feed it in: local runs (`RunManager.start`) and guest runs (`RunManager.startOnWorker`) read `readCompanionSpec()` and pass it through identically. So a guest agent sees the same commit conventions a local one does. I added a regression test (`buildPrompt includes the companion's brief…`) so this can't silently regress.

## The real cause: the agent's commits were failing on the guest

The previous fix (Cloud Companions) preserves the agent's own commit message — but **only when the agent actually commits**. The guest runs the agent inside a throwaway `git init` repo in `/tmp`, and that repo had no committer identity in its config. The host's own bookkeeping commits passed `-c user.name=…` inline, but the agent's `git commit` did not inherit those.

On any guest box without a global git identity (e.g. the headless-server setup), the agent's `git commit` fails. The agent then leaves its work uncommitted, we capture no message, and `guestLandMessage()` falls back to the **bare ticket title** — a commit with no emoji, no conventional-commit prefix, no trailer. Exactly the "not adhering to the spec" symptom. Local runs were never affected because they commit straight into the real repo, which has the user's identity.

## Fix

- `src/worker/guest.ts`: set `user.name`/`user.email` in the throwaway repo's **config** right after `git init`, so the agent's commits always succeed (and its spec-following message gets captured + landed). Dropped the now-redundant per-commit `-c` flags.

## Tests

- New test asserting the companion brief is embedded in the prompt (and that no empty heading is emitted when there's no brief).
- Full suite green: **57 passing**, typecheck clean.

Committed `d62c5d1` on `main` (current branch).
