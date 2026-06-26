---
title: Use a Library
state: review
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-25T18:25:56.088Z'
updated: '2026-06-26T11:27:04.085Z'
order: 7
---

The guest agent UI is quite good, but craps out quite a bit. Could we find a really solid library that has solved the harder problems?

---
**Done.** The "guest agent UI" is the live terminal dashboard in `src/worker/guest-tui.ts` (`GuestTui`). It drove its own repaint with hand-rolled `cursor-up + clear-down` ANSI math, counting only `\n`. That's exactly where it "crapped out": when a frame grew taller than the terminal the scroll desynced the cursor and left garbled/stale lines; resizes and wrapped lines were also mishandled.

Adopted **`log-update`** (v8) — the well-established, lightweight library for in-place terminal repainting. It solves the harder problems: terminal-height clipping, resize handling, wrap-aware line accounting, flicker-free *diffed* writes with synchronized-output (`?2026`) framing, and cursor hide/show.

The pure, fully-tested `renderFrame` is untouched — only the I/O layer (`paint`/`stop`/cursor management) was swapped. `linesDrawn` and the manual ANSI writes are gone.

Tests: `npm test` → 72 pass, 0 fail. `npm run typecheck` clean. One focused commit (cc38df3).
