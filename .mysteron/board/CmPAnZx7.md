---
title: Dream Mode
state: backlog
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels:
  - dream
created: '2026-07-03T10:40:56.567Z'
updated: '2026-07-03T21:52:25.652Z'
---

The aim of this optional feature is to produce tickets that feed into the improvement of the project whilst credits are available, agents are idle and the humans are asleep. 

This feature is turned on at project level and configured to run on schedule set by for that project e.g. nightly, few times a week or weekly. 

A spec at project level must be provided to the agent to follow in dream mode, this spec can be improved over time. In the first instance write a generic spec. The output from the agent should be tickets in the backlog that
- Fixes bugs 
- Adds or progresses features
- General ideas (marketing, pricings etc..)   

The agent must evaluate 
- Current state of the code base
- All tickets and plans - past, present and future 

Some of these ticket might be discarded, the agent must retain memory of all dream tickets it has created to avoid duplicates.  

All tickets in dream mode must be tagged "dream".
