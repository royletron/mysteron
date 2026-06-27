---
title: 'Atomic, serialized writes for board/docs/memory'
state: review
priority: high
assignee: Waldorf the Compiler
labels:
  - tech-debt
  - reliability
  - v2
created: '2026-06-25T19:06:01.084Z'
updated: '2026-06-27T13:11:31.978Z'
order: 2
---

**Problem.** Every write to the shared `.mysteron/` state is a bare read-modify-write `fs.writeFile` with no locking and no temp+rename:
- `src/core/board.ts:154,172,210` (create/update ticket, attachments)
- `src/core/docs.ts:56` (write_doc)
- `src/core/memory.ts:61` (write_memory)

`updateTicket()` reads the ticket, spreads a patch, and writes it back. Mysteron's whole premise is **multiple companions + guests working one board concurrently**, so two writers interleaving will silently lose each other's changes (last-writer-wins), and a crash mid-write can leave a half-written ticket file.

**Fix.**
- Write to a temp file then `fs.rename` (atomic on same fs) so a reader never sees a partial file.
- Add a per-file (or per-board) async mutex/queue around read-modify-write so concurrent `update_ticket` calls serialize instead of clobbering.
- Optionally add an `updated`/revision check to detect conflicting concurrent edits.

**Acceptance.** Concurrent `update_ticket` calls on the same ticket no longer drop writes (add a test that fires N concurrent patches and asserts all land). No partial-file reads.
