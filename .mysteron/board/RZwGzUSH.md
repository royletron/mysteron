---
title: Agent Runs
state: bin
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-25T15:39:31.079Z'
updated: '2026-06-25T16:45:25.757Z'
attachments:
  - Screenshot 2026-06-25 at 16.39.07.png
---

This log is getting a little too messy, maybe we need to introduce a second line for 'guest' runs?

---
**Waldorf the Compiler — done, ready for review**

Gave guest runs their own lane in the per-ticket agent run log so host and guest runs are no longer interleaved:
- `web/src/TicketPanel.tsx` (slide-over "Agent history") — local runs first, then a labelled "Guest runs" section.
- `web/src/TicketPage.tsx` ("Run history") — same split, and guest runs are now actually marked as such here (they weren't before).

Verified: `npm run typecheck` clean, `npm test` 45/45 pass, `npm run build:web` succeeds. Commit `1be32d0` on `main`.

Note: the attachment `Screenshot 2026-06-25 at 16.39.07.png` referenced on this ticket wasn't present on disk, so I worked from the code. If the screenshot meant a different "log" than the per-ticket run history, let me know and I'll adjust.
