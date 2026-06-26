---
title: Any Missing Features?
state: review
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-25T19:00:44.012Z'
updated: '2026-06-26T11:27:04.094Z'
order: 10
---

Feels like a decent all in one deal. Do you see anything we have missed out, any missing features, tech debt whatever?

---

**Review done — see `docs/REVIEW.md`.** Short version: the spec is substantially delivered, and security came back clean. Genuine gaps, each filed as a backlog ticket:

_Spec gaps (partial):_
- Auto-derive tickets from doc/spec changes — `RduSwHaY`
- Recipes don't spawn real sub-agents (prompt-only) — `ah4-UFiD`
- Plugin registry is hardcoded, not extensible — `KacZf6ue`

_Tech debt:_
- **No atomic/locked writes** for board/docs/memory → concurrent companions+guests can lose writes (high) — `__J9CotP`
- Big untested surfaces (API/WS/MCP/autopilot/web) — `GGxQv2wu`
- No CI / lint / formatter — `5JirmCP8`
- No config schema versioning — `z0vX7hO9`
- settings.json should be `0600` (low) — `OAqbZIr0`

Tests: 80 pass (after `npm install` — fresh checkout needs deps). No code change in this ticket, so no commit/diff; deliverables are the review doc + tickets above.
