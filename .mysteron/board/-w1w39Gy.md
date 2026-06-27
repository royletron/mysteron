---
title: Fail on resume
state: review
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-27T08:35:40.969Z'
updated: '2026-06-27T09:02:10.287Z'
---

I'm currently seeing failures on resuming failed tasks. It seems to be when the task originally started on another machine and then it fails to start because the Claude session id doesn't belong to the account. Can we add a guard for this sort of failure and drop the resume and restart?
