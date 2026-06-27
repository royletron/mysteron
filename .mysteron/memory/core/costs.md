---
name: core/costs
description: The cross-project cost ledger and spend explorer — where run costs are stored and aggregated
metadata:
  type: project
---

# Cost ledger (`src/core/costs.ts`)

A tiny JS-native (single JSON file) ledger of agent-run spend, owned by Waldorf the Compiler.

- **Where:** `~/.mysteron/costs.json` (`costsPath()`), in the central Mysteron home — NOT in any project. Costs are machine/account-wide and must not pollute a project's git history. Same store family as `registry.json` / `settings.json`.
- **What pushes to it:** `RunManager.finish()` calls `recordRunCost(run)` for every finished run (local and guest). No-op when the run reported no `costUsd`. Upserts by `runId` so a guest run finalised twice never double-counts. Writes are serialised through an in-process promise queue so parallel companions don't clobber each other; disk errors are swallowed (never breaks a live run).
- **Reading:** `loadCostEntries()` for raw entries; `costStats()` aggregates into `CostStats` — overall totals, avg/ticket (= total ÷ distinct tickets) and avg/run, per-project breakdown (each with its own daily series), an overall daily series (bucketed by `endedAt` date), and the top-10 priciest tickets. Project names are resolved from the registry, falling back to the project id for unregistered projects.
- **HTTP:** `GET /api/costs` → `costStats()`. Web UI is `web/src/Costs.tsx` at route `#/costs` (header `$`-icon link), with stat cards, a dependency-free daily bar chart, and project/ticket tables.

Cost data per run also still lives in each project's `.mysteron/runs/<id>.json` (`Run.costUsd`/`numTurns`); the ledger is the cross-project aggregate on top of that. See [[runner/dispatch]].
