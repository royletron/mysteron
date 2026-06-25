---
title: Dependency Logic
state: done
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-25T17:02:25.479Z'
updated: '2026-06-25T17:54:23.827Z'
---

We need to optionally allow tickets to be dependant on one another. This should pause them in the queue until their dependent tickets are both complete, and merged (if branched) - we basically need to know they are in main.

It should be possible to see both dependant tickets, and dependencies of the current ticket (please come up with better words) - and assign as requred. We probably also want to show this on the board 'blocked by...'

---

## Done — ready for review

**Terminology chosen:** "Blocked by" (the tickets this one depends on / waits for) and "Blocks" (the downstream tickets waiting on this one). Maps cleanly to the board's "blocked by…" label.

**Data model:** tickets gain an optional `blockedBy: string[]` (frontmatter, round-trips). The inverse ("blocks") is computed on read.

**"In main", not just done:** a dependency is satisfied only when it's `done` AND not sitting on an unmerged branch (`unmergedBranchTicketIds` checks open review branches by ticket id). So a ticket parked on an open branch still blocks its dependents. A dependency on a deleted ticket is treated as satisfied (no deadlock).

**Queue pausing:** `nextTicket`, `nextTicketForCompanion`, and the autopilot's guest fan-out all skip blocked tickets, so they pause in the queue. A manual ▶ run is intentionally still allowed as a user override.

**Surfacing & assigning:**
- Board cards show a `🔒 Blocked by N` badge (blockers listed in the tooltip).
- Ticket panel has a dependency editor (pick what it's "Blocked by") plus a read-only "Blocks" list.
- Ticket run page shows both directions read-only.
- MCP `create_ticket`/`update_ticket` accept `blockedBy`.

**Tests:** added coverage for queue gating + enrichment (both directions, orphan deps, clearing) in `test/core.test.ts` and the merged-to-main branch guard in `test/git.test.ts`. Full suite green (51 pass). Typecheck clean for both server and web.

Shipped as 4 focused commits on `main` (30ad13b, 5bcec68, cef5ee0, e2bd581).
