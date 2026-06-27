---
title: Bug
state: review
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-27T13:58:14.414Z'
updated: '2026-06-27T14:03:50.061Z'
---

Getting this a lot:

API Error: Response stalled mid-stream. The response above may be incomplete.

---

**Fixed (be1eef3).** This is Claude Code's transient streaming-drop error — the agent never finishes or lands its work, so the run was being treated as a clean failure and (past the lower non-retryable cap) dead-lettered.

The runner now detects it (`STREAM_STALL_RE` in `src/runner/manager.ts`), sets `run.streamStalled`, bounces the ticket back to `ready` in `finish()` (gated on `status !== "done"`, like the usage-limit path), and `classifyFailure` treats it as **retryable** so the autopilot retries with backoff instead of giving up. Reason surfaced as "stream stalled" in the activity log.

Tests: added coverage in `test/retry.test.ts` (classification) and `test/runner.test.ts` (end-to-end bounce-to-Ready). Full suite green (129 passing) + typecheck clean.
