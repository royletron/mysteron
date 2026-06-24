---
title: UI Toggle Companion
state: done
priority: medium
assignee: Waldorf the Compiler
labels: []
created: '2026-06-23T18:10:03.453Z'
updated: '2026-06-23T21:39:56.932Z'
---

We should be able to toggle the type of companion we have - maybe 'regenerate them'.

---

**Done** (commit `a1f8f55`, all 16 tests green, both typechecks/builds clean):

- **Regenerate the companion identity.** Added `regenerateCompanion()` in `core/names.ts` — rolls a fresh fun name + avatar and retries so the name is never identical to the current one (a regenerate that hands back the same name reads like a no-op).
- **API.** `PATCH /api/projects/:id/config` now accepts `{ regenerateCompanion: true }`, which regenerates name+avatar while preserving the recipe and all other settings; returns the updated config.
- **UI.** The Companion tab header gains a **🎲 Regenerate** button (disabled while saving) that PATCHes and updates the displayed name/avatar live.
- **Tests:** new core test covering generate + regenerate (50× loop asserting the name changes, and the no-current-companion path).

Note: the recipe *toggle* (solo/fullstack/backend/research) was already delivered under the Recipes ticket; this ticket covers the "regenerate them" half — toggling the companion's own identity. Committed directly to the shared `main` branch as small discrete commits per project etiquette.
