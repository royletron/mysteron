---
title: Schema versioning for .mysteron/config.json
state: backlog
priority: low
labels:
  - tech-debt
created: '2026-06-25T19:06:18.186Z'
updated: '2026-06-25T19:06:18.186Z'
---

**Gap.** Config has exactly one anonymous migration (pre-roster `companion` → `companions[]`, `src/core/companions.ts`) detected by shape-sniffing in `src/core/project.ts`, and the migrated config is saved with `.catch(() => undefined)` — a failed save is swallowed silently. There's no `schemaVersion` field, so future breaking changes will keep stacking fragile shape-sniffs, and an older client reading a newer config has no signal.

**Fix.** Add `schemaVersion` to config.json, a small ordered migration runner keyed off it, and at least log (don't swallow) a failed migration save.

**Acceptance.** New configs carry a version; migrations run by version; a failed migration save is surfaced.
