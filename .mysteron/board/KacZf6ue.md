---
title: Extensible plugin loading (beyond the hardcoded registry)
state: review
priority: low
assignee: Waldorf the Compiler
labels:
  - tech-debt
  - feature
  - v2
created: '2026-06-25T19:06:01.347Z'
updated: '2026-06-27T13:18:11.470Z'
order: 4
---

**Spec wants "a plugins system."** The interface (`src/plugins/types.ts`) is clean, but `src/plugins/manager.ts` has a hardcoded `REGISTRY` containing only `usageMonitorPlugin`. Adding a plugin means editing source — there's no config-driven or third-party discovery.

**Fix.** Allow plugins to be declared in `.mysteron/config.json` (and/or discovered from a `plugins/` dir or npm package), loaded by the manager at startup, contributing their MCP tools. Keep the bundled usage-monitor as the reference implementation.

**Acceptance.** A second example plugin can be enabled purely via config (no edit to `manager.ts`) and its tools appear over MCP.
