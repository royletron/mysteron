---
title: Run log rotation and auto-pruning
state: backlog
priority: medium
labels:
  - dream
  - tech-debt
  - storage
created: '2026-07-12T18:16:19.383Z'
updated: '2026-07-12T18:16:19.383Z'
---

**Gap.** `.mysteron/runs/` grows unboundedly. Every run (including subtask runs, retried runs, and dream-mode runs) writes a JSON file to this directory. On an active project this accumulates hundreds of files quickly — the current repo already has over 100 run files. Run files include full agent output which can be large.

**Fix.**
1. **Auto-prune on startup.** In `RunManager.hydrate()` (`src/runner/manager.ts`), after loading existing runs, delete runs older than a configurable retention period. Default: keep runs from the last 30 days or the last 50 runs per ticket, whichever is more.

2. **Config knob.** Add optional `runRetention` to `.mysteron/config.json`:
   ```json
   { "runRetention": { "maxAgeDays": 30, "maxPerTicket": 50 } }
   ```
   `null` or absent = keep forever (existing behaviour, backwards-compatible default).

3. **`mysteron prune [path]` CLI command.** Run the same pruning logic on-demand without starting the server. Prints a summary: `Pruned 87 run files (12.4 MB freed)`.

4. **Web UI indicator.** Show the run count and approximate size in the project Settings tab so users know when they're accumulating logs.

**Implementation notes:**
- Pruning must not delete runs for tickets that are currently `in-progress` or have a run with no `endedAt` (orphan runs that might be resumed).
- Pruning should be logged to the server log, not silently swallowed.
- Test: pruning deletes files older than the configured age and keeps the N most recent per ticket.

**Acceptance.** After startup with a full runs dir and `maxAgeDays: 7`, old run files are deleted. `mysteron prune` reports freed space. In-progress runs are never pruned.
