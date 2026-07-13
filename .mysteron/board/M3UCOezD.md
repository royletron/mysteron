---
title: Webhook notifications for board events
state: backlog
priority: medium
labels:
  - dream
  - feature
  - notifications
created: '2026-07-12T18:15:55.028Z'
updated: '2026-07-12T18:15:55.028Z'
---

**Gap.** The event bus fires `board-changed`, `run` lifecycle events, and autopilot status changes internally — but there's no way for external systems to receive them. The headline use case is "leave it churning while you sleep," which means users need an out-of-band signal when something finishes or gets stuck.

**Fix.** Add optional per-project webhook configuration in `.mysteron/config.json`:
```json
{
  "webhooks": [
    { "url": "https://hooks.slack.com/...", "events": ["ticket.done", "ticket.stuck", "autopilot.paused"] }
  ]
}
```

When a matching event fires, POST a JSON payload to each configured URL:
```json
{
  "event": "ticket.done",
  "project": { "id": "...", "name": "..." },
  "ticket": { "id": "...", "title": "...", "state": "done" },
  "companion": "Waldorf the Compiler",
  "at": "2026-07-12T..."
}
```

**Events to support:**
- `ticket.done` — ticket moved to `done`
- `ticket.stuck` — ticket dead-lettered by autopilot (labelled `stuck`)
- `ticket.ready` — ticket moved to `ready` (optional, can be noisy)
- `autopilot.paused` — budget/quota pause
- `run.failed` — a run failed

**Implementation notes:**
- Fire-and-forget HTTP POST, don't block the event bus. Log delivery errors but don't retry (callers can use a retry-capable receiver like Make/Zapier).
- Respect common Slack/Discord incoming-webhook payloads: if the URL looks like Slack/Discord, shape the body to their format (simple `text`/`content` field).
- Expose PATCH endpoint on `POST /api/projects/:id/config` (already exists) to let the web UI add/remove webhooks.
- Surface a minimal "Webhooks" card in the project Settings tab alongside auth/guest-token.

**Acceptance.** Configuring a webhook URL and moving a ticket to done POSTs the payload to that URL within 5 seconds. Slack/Discord incoming-webhook URLs receive a formatted message.
