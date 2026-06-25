---
title: Password Protect
state: bin
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-24T13:44:23.998Z'
updated: '2026-06-25T16:45:25.752Z'
---

Can we put a simple password protection in place? We should just hash the password into the settings somewhere and save an id when it changes. This should mint a cookie which checks if the id has changed before allowing the user in. It should be optional and changeable in a settings page (this is global to the app)
