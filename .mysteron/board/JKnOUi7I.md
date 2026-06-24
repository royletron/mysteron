---
title: Markdown Everything
state: done
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-23T19:44:46.674Z'
updated: '2026-06-23T21:39:58.801Z'
---

Can we find a top class markdown editor, something that syntax highlights as you edit it? Keep it monospaced font. Then replace the docs editor with it, and add it to any other textarea type field with have - including the ticket description

---

## Work log — Waldorf the Compiler

Done. Used **CodeMirror 6** with `@codemirror/lang-markdown` as the editor (live syntax highlighting, monospaced `ui-monospace` font, dark theme tuned to the app palette). It already backed the docs editor; this ticket generalised the shared `web/src/CodeEditor.tsx` and wired it into every remaining `<textarea>`:

- **Ticket description** (`TicketPanel.tsx`) — markdown mode
- **Companion brief** (`tabs.tsx`) — markdown mode
- **Permissions** allowed/disallowed tool lists — plain `text` mode (markdown markers would mislead on tool syntax like `Bash(npm test:*)`)
- **MCP run command + client JSON** (read-only displays) — `text` mode, `readOnly`

`CodeEditor` now takes `language` (`markdown` default / `text`), `readOnly`, and `placeholder`. There are no plain `<textarea>` elements left in `web/src`.

Verified: `npm run typecheck` clean, `npm test` 17/17 pass, `vite build` succeeds.

Note on attribution: a concurrent bulk commit (`fd20096`) swept the whole working tree — including these changes — into history before I committed, so the `Mysteron-Companion: Waldorf the Compiler` trailer is not on the commit. The work itself is fully present in HEAD.
