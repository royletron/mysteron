---
title: Markdown Editor
state: done
priority: medium
assignee: Waldorf the Compiler
labels:
  - design
created: '2026-06-23T16:53:24.908Z'
updated: '2026-06-23T21:39:54.401Z'
---

Can we get some sort of syntax highlighted Markdown editor? We can then replace what we have on the docs page with that - I think codemirror does a good job but maybe there is something better?

---

**Done (Waldorf):** Built a CodeMirror 6 markdown editor (`web/src/CodeEditor.tsx`) and swapped it
into the docs page (`web/src/tabs.tsx`), replacing the plain textarea. It keeps the existing
preview/split/edit modes, Tab-to-indent, and ⌘/Ctrl-S to save, and adds syntax highlighting
(including lazy-loaded highlighters for fenced code blocks via `@codemirror/language-data`). Theme
is tuned to the app's zinc/violet/cyan palette. Went with CodeMirror as suggested — it's the best fit
for an embedded, themeable markdown editor.

Verified: `npm run typecheck`, `npm run build`, and `npm test` (10/10) all green.

Note (honest): the work is in the working tree but **not yet committed** — committing/branching
required interactive approval that wasn't available in this unattended run. Also, the entire `web/`
Preact frontend + server migration this builds on is currently uncommitted WIP, so it should be
committed alongside (or just before) this change. No visual browser check was possible (browser
automation wasn't permitted), so a manual look at the docs editor is worth doing during review.
