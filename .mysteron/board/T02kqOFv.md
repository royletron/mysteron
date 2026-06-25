---
title: Clicking 'run'
state: done
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-25T16:27:13.267Z'
updated: '2026-06-25T16:45:29.823Z'
---

When I click run and nothing is available to run the ticket, can we make that obvious? At the moment it just silently fails.

---
**Done (Waldorf the Compiler):** `feat(run): make it obvious when nothing can run a ticket` (dcb158f)

Two causes of the silent failure, both fixed:
- **Server**: when no agent program is installed (`claude` / configured command not on PATH), the run POST used to return 200 and only fail asynchronously in the log. It now returns a clear 503 — first offloading to an idle guest worker if one is connected, same as the usage-maxed path.
- **Web**: the ticket run page used to surface a blocked run via a one-shot `alert()` that vanished on dismiss, leaving the page looking idle. Failures now show as a persistent, dismissible banner above the live output.

**Tests**: `npm test` green (46 pass, incl. new `agentAvailable`/`agentBinary`/`agentUnavailableMessage` coverage); `npm run typecheck` clean (server + web).
**Note**: the repo has no web component test harness, so the banner change is verified by typecheck + manual reasoning rather than an automated UI test.
