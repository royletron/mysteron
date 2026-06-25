# Mysteron — gap & tech-debt review

_Review for ticket 2-Mf_im8 ("Any Missing Features?"), by Waldorf the Compiler, 2026-06-25._

Short version: it really is a decent all-in-one deal. The spec is substantially
delivered — board, docs, memory, etiquette, MCP, companions+avatars, web UI,
autopilot, usage-monitor plugin, and the guest-companion fan-out (which goes
*beyond* the original spec). Security came back clean (timing-safe credential
checks, path-traversal guards on attachments/snapshots, no shell-injection path,
async routes wrapped against unhandled rejections). Baseline tests: **80 pass**.

Below are the genuine gaps. Each has a backlog ticket.

## Missing / partial vs. the spec

| Area | Status | Ticket |
| ---- | ------ | ------ |
| Auto-derive tickets from doc/spec changes | **Partial** — watcher emits `docs-changed` + UI flag, but nothing consumes it to make tickets | `RduSwHaY` |
| Offload to real sub-agent teams (recipes) | **Partial** — recipes are roster + prompt text only; lead companion is one process, no real delegation | `ah4-UFiD` |
| Extensible plugin system | **Partial** — clean interface, but `manager.ts` registry is hardcoded to usage-monitor; no config/3rd-party loading | `KacZf6ue` |

(Avatars/names: fully implemented. Usage-monitor + yolo budget pausing: implemented.)

## Tech debt worth addressing

| Issue | Why it matters | Ticket |
| ----- | -------------- | ------ |
| No atomic/locked writes for board/docs/memory | Bare read-modify-write `fs.writeFile`; concurrent companions+guests can silently lose writes — and that concurrency is the whole point | `__J9CotP` (high) |
| Big untested surfaces | API (40+ routes), WebSocket, MCP tools, autopilot pause/fan-out, web UI all have ~no tests | `GGxQv2wu` |
| No CI / lint / formatter | Etiquette says "always run tests" but nothing enforces it; fresh checkout "fails" until `npm install` | `5JirmCP8` |
| No config schema versioning | One anonymous shape-sniff migration; failed migration save is swallowed | `z0vX7hO9` |
| settings.json default perms | Holds password hash + guest tokens; should be `0600` (low) | `OAqbZIr0` |

## Not a concern

Security audit found no high/medium issues. Credential compares are timing-safe,
attachment/snapshot paths are sanitized, git invocations use `execFile` (no shell),
and the agent command only uses `shell:true` for the documented `MYSTERON_AGENT_CMD`
escape hatch with the prompt passed on stdin rather than interpolated.
