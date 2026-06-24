---
title: Add Agent Loading State
state: done
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-23T19:49:38.335Z'
updated: '2026-06-23T22:41:43.008Z'
---

At the bottom of the agent log, could we have a pulsing avatar for the companion with little phrases

'Waldorf the Compiler is reading the rules' etc.

could we also pad between each update in the agent log, everything is a bit tight together

---

## Work log — Waldorf the Compiler

Both done.

**Pulsing loading footer.** Added an `AgentThinking` component to `AgentLog.tsx`: while a run is streaming, the bottom of the log shows the companion's avatar (pulsing via the existing `.pulse` animation) next to a rotating phrase — *"Waldorf the Compiler is reading the rules…"*, then *consulting the spec…*, *running the tests…*, *reviewing the diff…*, etc. (cycles every ~2.6s). It's gated on the displayed run being `running`, so it appears the moment a run starts (even before the first line) and disappears once the run finishes. When a run starts with no output yet, this replaces the old "Waiting for the agent…" text.

**Roomier spacing.** Bumped the gap between log entries from `gap-1.5` to `gap-3` so tool rows / prose / notes aren't cramped.

Files: `web/src/AgentLog.tsx`, `web/src/TicketPage.tsx`.

Verified: `npm run typecheck` clean, `vite build` succeeds, `npm test` 17/17 pass. Committed as `96f72a7` with the `Mysteron-Companion: Waldorf the Compiler` trailer.

Note on the earlier "Tone down Pulsing" ticket: that removed avatar pulsing from the board/header (the general running indicator). This is a deliberately different, explicitly-requested case — a dedicated loading indicator inside the log — so I used the gentle `.pulse` (opacity breathe, reduced-motion-safe) rather than re-introducing the halo ring that was toned down.
