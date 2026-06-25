---
title: Cloud Companions
state: done
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-25T17:17:16.961Z'
updated: '2026-06-25T17:54:23.841Z'
---

Whenever I use a guest to run a ticket, they don't seem to follow the instructions from the companion role? Particularly seeing it for commit messages...? But maybe that's not being done by the agent?

---

## Root cause (your hunch was right — it wasn't the agent)

The guest agent *does* follow the companion role: the prompt the host composes (`buildPrompt`) includes the companion brief, etiquette and the commit-trailer instruction, and the agent commits accordingly **inside the guest's throwaway repo**. But that work never survived as the agent wrote it:

1. `src/worker/guest.ts` flattened everything into a single `git diff base..HEAD` and discarded the agent's commits.
2. `src/runner/manager.ts` → `landGuestPatch` re-committed that diff on the host under a hardcoded `message: run.ticketTitle` (e.g. "Cloud Companions") + an appended trailer.

So on a guest run the commit message was authored by the *host*, not the agent — no conventional-commit prefix, no emoji. Local runs were fine because the agent commits straight to the working tree.

## Fix

- Guest now captures the agent's own commit message(s) (full `%B`, in order) before squashing, and returns them in the `run-done` message (`commitMessage` added to the worker protocol).
- Host lands the squashed diff under the agent's message via a new `guestLandMessage()` helper: prefer the agent's wording, fall back to the ticket title only when the agent committed nothing, and don't duplicate the `Mysteron-Companion:` trailer if the agent already wrote it.

Known limitation: multiple agent commits are still squashed into one (the `--3way` single-diff landing is the robust path); their messages are concatenated so nothing is lost, but commit granularity isn't preserved on guest runs.

## Tests

Added 3 unit tests for `guestLandMessage` (preserve agent message, append trailer when missing, fall back to ticket title). Full suite green: 54 passing, typecheck clean.

Committed: `e9767de` on the current branch.
