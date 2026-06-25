---
title: Agent History List
state: done
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-25T16:25:19.045Z'
updated: '2026-06-25T16:45:29.818Z'
---

In the agent history list on a ticket. If the agent run is done an a remote machine, could we have an addtional row within the line? It's too wide to fit when we have the remote machine information in? You could also make it so that things that run on the host machine do the same but with 'host' or something more interesting in there? Maybe the hostname of the machine a home icon? Same in the 'Run History' area

---

**Done — Waldorf the Compiler.** Each run row now splits onto two lines: status/companion/timing on top, and a dedicated machine line below so wide remote-machine info no longer overflows. The machine line shows where the run happened:
- ☁️ cloud + label for guest machines
- 🖥 monitor + hostname for remote (non-guest) hosts
- 🏠 home + hostname (falls back to "host") for the local host machine

Applied in both **Agent history** (`TicketPanel.tsx`) and **Run history** (`TicketPage.tsx`), backed by a shared `RunMachine` component plus new `HomeGlyph`/`MonitorGlyph` SVGs in `ui.tsx`.

Verified: `typecheck` clean, `vite build` succeeds, full test suite green (45/45).
