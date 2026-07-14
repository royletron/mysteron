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

`LocalServer` (`src/core/types.ts`) is `{ id, label, url, apiKey?, authToken? }`.
Both credentials are Unsloth-style and are handed to a run in
`src/runner/manager.ts` when a companion's `localServerId` routes it at that
server:
  - `apiKey` (ticket aby9U0WZ) → `ANTHROPIC_API_KEY` (x-api-key). Always exported,
    even empty (`""`), so Claude Code doesn't prompt for a cloud key.
  - `authToken` (ticket sig7qmZt) → `ANTHROPIC_AUTH_TOKEN` (Authorization: Bearer).
    This is the *real* Unsloth key (`sk-unsloth-…` from Unsloth Studio →
    Settings → API). Only exported when set.
Per the Unsloth docs macOS/Linux use the empty API key, Windows/Studio uses the
`sk-unsloth-` bearer token — we support both so either setup works.

CRUD is `POST`/`PATCH`/`DELETE /api/local-servers` in `src/server/api.ts` (PATCH
with an empty string clears a credential, undefined leaves it). The Settings UI
(`web/src/Settings.tsx`, `LocalAiServers`) has an input per credential (🔑 = api
key set, 🎫 = auth token set). Guest runs (`src/worker/guest.ts`) do NOT consult
local servers — these are host-machine-local only.

Related clobber-on-reload pattern: [[plugins/usage-monitor]].
