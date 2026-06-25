---
title: 'Integration tests: server API, WebSocket, MCP tools, autopilot'
state: backlog
priority: medium
labels:
  - tech-debt
  - testing
created: '2026-06-25T19:06:08.357Z'
updated: '2026-06-25T19:06:08.357Z'
---

**Gap.** Core domain logic is well covered (80 tests across board/git/runner/usage/etc.), but the biggest surfaces have **no tests**:
- `src/server/api.ts` — 40+ REST endpoints, zero tests
- `src/server/ws.ts` — WebSocket multiplexing/replay, zero tests
- `src/mcp/server.ts` — all MCP tools, zero tests
- `src/runner/autopilot.ts` — only 1 test; budget pause/resume + guest fan-out untested
- `src/core/watcher.ts` — zero tests
- `web/` — zero frontend tests

**Fix.** Add happy-path + error integration tests for the REST API (project/ticket/run lifecycle), a WS subscribe/broadcast test, MCP tool-execution tests, and autopilot budget-pause/guest-dispatch tests. (Frontend smoke tests can be a separate follow-up.)

**Acceptance.** `npm test` exercises the API, WS, MCP and autopilot paths; CI runs them (see CI ticket).
