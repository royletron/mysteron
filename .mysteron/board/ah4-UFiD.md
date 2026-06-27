---
title: 'Recipe teams: delegate to real sub-agents'
state: review
priority: medium
assignee: Waldorf the Compiler
labels:
  - feature
  - spec-gap
  - v2
created: '2026-06-25T19:06:01.208Z'
updated: '2026-06-27T13:14:20.088Z'
order: 3
---

**Spec promise, partially delivered.** SPEC: a companion can *"offload it to a number of sub-agents (we can provide recipes for agent teams, designer, backend dev, frontend dev etc)."*

Today recipes (`src/core/recipes.ts`) only produce a **roster of companions + prompt text** ("you may delegate to roles: …" — see `src/runner/manager.ts` prompt assembly). The lead companion is a single Claude Code process; there is no actual sub-agent spawn/coordination. Already on the README roadmap.

**Fix.** Let a lead companion spin up role sub-agents (designer/frontend/backend/reviewer) for a ticket — either as Claude Code sub-agents or as separate Mysteron runs it coordinates — and merge their results. Respect the one-task-at-a-time / usage-budget rules.

**Acceptance.** A `fullstack` ticket can fan a task out to ≥2 role sub-agents and recombine, visible in the live view.
