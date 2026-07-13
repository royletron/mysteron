---
title: Local LLM Setup
state: review
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-07-13T12:18:57.969Z'
updated: '2026-07-13T12:22:14.413Z'
order: 0
---

I just tried adding a local model server and it silently fails. It doesn't seem to add the config and provides no feedback

---
**Root cause:** `loadSettings` in `src/core/settings.ts` rebuilt `AppSettings` as `{ auth, guest }`, silently dropping `localServers`. Adding a server persisted to disk once, but the very next load (the UI refetch, or any other setting save such as minting a guest token) reloaded without it and clobbered it on the next write — so the config appeared to never stick and no error surfaced.

**Fix:** spread `...parsed` in `loadSettings` before normalising `auth`/`guest`, so `localServers` (and any future top-level setting) is preserved.

**Tests:** added a regression test in `test/auth.test.ts` (local servers survive a reload and unrelated saves). Verified it fails without the fix and passes with it. Full suite green (151 tests), typecheck clean.
