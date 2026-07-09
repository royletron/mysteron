---
title: LM studio server agent
state: review
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-07-03T11:17:15.779Z'
updated: '2026-07-03T11:27:30.663Z'
subtasks:
  - title: >-
      Add LocalServer type to types.ts and localServerId to Companion; add
      readLocalServers/writeLocalServers persistence
    done: true
  - title: >-
      Add GET/POST/DELETE /api/local-servers routes and setCompanionLocalServer
      PATCH handler in api.ts
    done: true
  - title: >-
      Runner: resolve companion localServerId to ANTHROPIC_BASE_URL in
      manager.ts
    done: true
  - title: 'UI Settings.tsx: LocalAiServers card to add/remove/label LM Studio servers'
    done: true
  - title: 'UI tabs.tsx CompanionRow: server assignment dropdown (default: off)'
    done: true
forceSplit: true
---

Hey. So on a given machine it would be good if we could setup local access to a LM studio server instance - and then use those for work. You might need to research but LM studio can run servers with anthropic API support, so we can just wrap the instance of Claude.

Couple of notes.

1. Want to do this all via the UI, but obviously it'll need to end up in the local config.
2. We should be able to label LM studio server instances - may have different models etc.
3. We should be able to assign companions to use the local servers (default off)
