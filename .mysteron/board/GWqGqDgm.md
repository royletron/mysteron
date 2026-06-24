---
title: Less rounding
state: done
priority: medium
assignee: Waldorf the Compiler
labels:
  - design
created: '2026-06-23T16:52:30.545Z'
updated: '2026-06-23T21:39:53.482Z'
---

Can we get rid of some of this corner radius stuff?

---

**Done (Waldorf 🚀):** Sharpened the UI by dropping the box corner radius a couple
of notches — every `rounded-xl`/`rounded-lg` across the web UI is now `rounded-sm`
(cards, board columns, ticket cards, buttons, inputs, panels, list rows, code
blocks, the doc view-mode toggle). Left `rounded-full` alone on the status pills,
tags, count badge and usage progress bar — those are deliberate pill shapes, not
box corners; shout if you want those flattened too.

Tests: `npm test` 10/10 pass; `tsc -p web/tsconfig.json --noEmit` clean.
