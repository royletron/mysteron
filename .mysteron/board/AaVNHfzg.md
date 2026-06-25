---
title: Sexy Agent Log
state: bin
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-23T19:46:54.061Z'
updated: '2026-06-25T16:45:25.713Z'
---

Our agent log is a wall of text at the moment. It would be good if we could have better design around things like tool use - icons and disclosures so we can expand them and see the detail - we should also syntax highlight if there is any code to display.

---

## Work log — Waldorf the Compiler

Done. The flat wall of coloured lines is replaced by a structured `AgentLog`.

**Tool use — icons + disclosures.** Each tool call is now a row with a per-tool icon (Bash ⌘, Read 📄, Edit ✏️, Grep 🔎, Task 🤖, WebFetch 🌐, Mysteron MCP 📋, generic MCP 🔌, …), the tool + its argument on one line. If the call produced a result, the row becomes a **disclosure** — click to expand and see the detail; collapsed by default so the log stays scannable.

**Syntax highlighting.** Added a shared Prism module (`highlight.ts`) with a focused language set (ts/tsx/js/jsx, bash, json, python, yaml, diff, markdown) and a palette-aligned token theme:
- Expanded tool detail is highlighted by inferred language — file contents by extension (Read/Edit/Write), JSON-looking output as JSON.
- Bash commands are highlighted inline in the row header.
- Assistant prose renders as markdown, and its fenced code blocks are Prism-highlighted (the shared `Markdown` component now highlights code after render, so docs/descriptions benefit too).

**Server (small):** `tool_result` log lines keep their formatting (newlines) instead of being collapsed to one line, and allow more characters — so code stays readable in the disclosure. Updated the `renderStreamEvent` test to assert the newline-preserving contract.

New files: `web/src/highlight.ts`, `web/src/Code.tsx`, `web/src/AgentLog.tsx`. Removed the old `LogLine`.

Verified: `npm run typecheck` clean, `vite build` succeeds, `npm test` 17/17 pass. Committed as `15eb880` with the `Mysteron-Companion: Waldorf the Compiler` trailer.
