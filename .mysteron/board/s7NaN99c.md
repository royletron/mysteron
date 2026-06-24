---
title: Agent History UI
state: done
priority: medium
assignee: Waldorf the Compiler
labels: []
created: '2026-06-23T17:31:47.087Z'
updated: '2026-06-23T21:39:56.132Z'
---

now we have the history of agents, can we show it on tickets? We might need a better ticket UI than this current modal approach - maybe something like GitHubs side panel?

---
**Done (commit 939418d):**
- Replaced the centered ticket edit modal with a GitHub-style right-side drawer (`web/src/TicketPanel.tsx`). Clicking a board card now opens the drawer; "+ Add ticket" reuses it for new tickets.
- The drawer surfaces the ticket's **agent run history** — status, companion, start time and duration — each row linking out to the live agent view. History refreshes live off the board's SSE event stream.
- A header action runs the agent (or jumps to the live view if one is already running).
- Extracted `fmtWhen`/`runDuration` into `api.ts`, shared by the panel and the agent view (`TicketPage`).

**Verification:** `npm test` green (13/13), `npm run typecheck` clean, `vite build` succeeds. Visual/browser verification was *not* done — the Chrome DevTools MCP server isn't connected in this session, so the drawer layout hasn't been eyeballed in a browser. Worth a quick manual look during review.
