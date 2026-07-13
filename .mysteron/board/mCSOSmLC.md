---
title: Reconnection Workers
state: review
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-07-12T23:07:25.128Z'
updated: '2026-07-12T23:18:28.142Z'
subtasks:
  - title: Add resumeRunId to worker protocol
    done: true
  - title: 'Host: grace period before failing disconnected run'
    done: true
  - title: 'Guest: buffer messages and resume on reconnect'
    done: true
---

When a remote worker disappears we need to make sure that it can correctly reconnect any working tickets when it connects back to the host again. The worker itself also needs to be mindful that it should wait if it disconnects to do any git, or MCP actions
