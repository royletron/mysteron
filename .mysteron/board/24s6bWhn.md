---
title: Image Support
state: done
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-23T19:47:28.695Z'
updated: '2026-06-23T22:41:41.428Z'
---

It would be fantastic if I can attach images to a ticket, these are then fed into the prompt - being able to say 'this thing looks wrong on this page' and attach an image would be great

---

## Work log — Waldorf the Compiler

Done — you can attach images to a ticket and the agent sees them.

**Attach (web).** The ticket panel now has an **Images** section: pick one or more images, they upload immediately and show as a thumbnail grid with hover-to-remove. (Attachments appear once a ticket exists — for a brand-new ticket it prompts you to save first, then reopen.)

**Storage (in-repo, so it syncs via git).** Images are written to `.mysteron/board/attachments/<ticketId>/`, and the filenames are recorded in the ticket's frontmatter (`attachments:`). Repeat filenames are de-duped; deleting a ticket removes its attachment folder.

**Fed into the prompt.** When the companion runs, `buildPrompt` adds an **# Attached images** section listing each image by its in-repo path (e.g. `.mysteron/board/attachments/<id>/shot.png`) and tells the agent to view them with the Read tool before starting. Claude Code reads images natively, so "this looks wrong on this page" + a screenshot reaches the agent. No section is added when a ticket has no images.

**Server.** Upload is a raw-binary `POST …/attachments?name=<file>` (bypasses the JSON body limit, so large screenshots are fine), plus DELETE and a GET that serves the bytes for the thumbnails.

Files: `src/core/{board,paths,types}.ts`, `src/runner/manager.ts`, `src/server/api.ts`, `web/src/{TicketPanel,api}.ts`.

Tests: added an attachment round-trip test (bytes + frontmatter persistence, de-dupe, cleanup on delete) and a buildPrompt test asserting the image section appears (and only when there are attachments).

Verified: `npm run typecheck` clean, `npm test` **18/18** pass, `vite build` succeeds. Committed as `9f3028a` with the `Mysteron-Companion: Waldorf the Compiler` trailer.

Notes for review:
- "Fed into the prompt" works by referencing the image file paths for the agent's Read tool (the run shells out to the Claude Code CLI with the prompt as text), rather than embedding image bytes — this is the right fit for the CLI and keeps images in the repo.
- The upload landed as raw-binary (cleaner than base64); a concurrent refinement to my first pass aligned the front and back ends on that contract — I confirmed it's consistent end-to-end and tested.
