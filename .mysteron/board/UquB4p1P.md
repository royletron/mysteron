---
title: 'MCP resources: expose board state as readable resources'
state: done
priority: medium
assignee: Waldorf the Compiler
labels:
  - dream
  - feature
  - mcp
created: '2026-07-12T18:16:46.209Z'
updated: '2026-07-14T16:27:06.724Z'
order: 1
subtasks:
  - title: 'Register static resources (board, spec, memory)'
    done: true
  - title: 'Register resource templates (ticket/{id}, docs/{name})'
    done: true
  - title: Wire board-changed bus event to sendResourceListChanged
    done: true
---

**Gap.** The MCP server (`src/mcp/server.ts`) exposes board state exclusively through tools (`list_tickets`, `get_ticket`, etc.). MCP also supports **resources** — URI-addressable content that clients can read and subscribe to without invoking a tool. Claude Code can read MCP resources directly into its context window, which is more efficient and composable than repeated tool calls.

**Fix.** Register MCP resources alongside the existing tools:

- `mysteron://board` — the full ticket list as JSON (equivalent to `list_tickets`)
- `mysteron://ticket/{id}` — a single ticket as markdown (equivalent to `get_ticket` but richer)
- `mysteron://docs/{name}` — a shared doc file
- `mysteron://spec` — the project's SPEC.md (shorthand for the most common doc access pattern)
- `mysteron://memory/{name}` — a memory file

**Resource templates** (from the MCP spec) let clients discover the `ticket/{id}` and `docs/{name}` patterns without enumerating every ID upfront.

**Why this matters:**
- A companion reading SPEC at the start of every ticket currently calls `read_doc("SPEC.md")` as a tool (counts toward tool-call limits). A resource read is outside the tool-call budget in some clients.
- Resource subscriptions let clients receive push updates when board state changes, rather than polling via `list_tickets`. This aligns with the existing WebSocket event bus.

**Implementation notes:**
- Use `server.resource()` and `server.resourceTemplate()` from `@modelcontextprotocol/sdk`.
- For subscription support, emit a `resources/list_changed` notification when `bus.emitEvent({ type: "board-changed" })` fires.
- Resources are read-only; writes still go through tools.
- Tests: resource read returns expected content; template resolution works for ticket IDs.

**Acceptance.** `mysteron://spec` resolves to the project's SPEC.md content. `mysteron://ticket/abc123` resolves to that ticket's markdown. Subscribing to `mysteron://board` delivers a notification when a ticket changes state.
