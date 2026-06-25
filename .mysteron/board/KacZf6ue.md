---
title: Extensible plugin loading (beyond the hardcoded registry)
state: backlog
priority: low
labels:
  - tech-debt
  - feature
created: '2026-06-25T19:06:01.347Z'
updated: '2026-06-25T19:06:01.347Z'
---

**Spec wants "a plugins system."** The interface (`src/plugins/types.ts`) is clean, but `src/plugins/manager.ts` has a hardcoded `REGISTRY` containing only `usageMonitorPlugin`. Adding a plugin means editing source — there's no config-driven or third-party discovery.

**Fix.** Allow plugins to be declared in `.mysteron/config.json` (and/or discovered from a `plugins/` dir or npm package), loaded by the manager at startup, contributing their MCP tools. Keep the bundled usage-monitor as the reference implementation.

**Acceptance.** A second example plugin can be enabled purely via config (no edit to `manager.ts`) and its tools appear over MCP.
