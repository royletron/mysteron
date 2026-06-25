---
title: Auto-derive draft tickets from doc/spec diffs
state: backlog
priority: medium
labels:
  - feature
  - spec-gap
created: '2026-06-25T19:06:01.125Z'
updated: '2026-06-25T19:06:01.125Z'
---

**Spec promise, not yet delivered.** SPEC: *"Changes to docs should be monitored so that we can pull new tickets from it if changes anything."* Also a roadmap bullet.

Today `src/core/watcher.ts` emits `docs-changed` and `src/server/api.ts` only surfaces a `pendingDocSync` flag in the UI — nothing actually derives tickets from the diff. The plumbing (watcher → event → UI flag) is the hard part and it's done; what's missing is the consumer.

**Fix.** When the spec/docs change, run a companion (or a small MCP-driven pass) over the git diff of `.mysteron/docs/*.md` to propose **draft** tickets (state `backlog`, labelled `auto`/`draft`) for the human to accept/bin. Don't auto-`ready` them.

**Acceptance.** Editing SPEC.md and saving produces one or more draft backlog tickets referencing the change; nothing moves to `ready` without human action.
