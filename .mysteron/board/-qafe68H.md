---
title: Make Sure Guests Believe The Ticket
state: review
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-25T18:07:04.494Z'
updated: '2026-06-25T18:10:33.450Z'
order: 0
---

When a worker pulls a ticket and see's it is no longer ready/in progress it needs to not second guess. Currently it'll try and fetch the changes in the commit log - but often they're not merged to the commits they get. We need to prompt it to just exist if the ticket is in 'review' or greater.
