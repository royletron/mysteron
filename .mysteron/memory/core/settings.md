---
name: core/settings
description: Per-machine app settings (~/.mysteron/settings.json) shape and the loadSettings passthrough gotcha
metadata:
  type: project
---

`src/core/settings.ts` owns per-machine settings at `~/.mysteron/settings.json`
(`AppSettings`: `auth`, `guest`, `localServers`). All mutators do
load→modify→save, so `loadSettings` MUST return every field it read.

Gotcha (fixed in ticket _SnBDxCi): `loadSettings` used to rebuild the object as
`{ auth, guest }`, silently dropping `localServers`. Effect: adding a local LLM
server persisted once but the next load (GET refresh, or any other save like
`mintGuestToken`) clobbered it — the classic "silently fails, no feedback" bug.
Fix: spread `...parsed` first, then normalise `auth`/`guest`. Any NEW top-level
setting is now preserved for free — don't reintroduce an explicit whitelist here.

Related clobber-on-reload pattern: [[plugins/usage-monitor]].
