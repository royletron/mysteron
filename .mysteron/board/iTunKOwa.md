---
title: Work Tree/Commits
state: ready
priority: medium
companionId: c1bf55fe-3e93-410d-94a7-cfde4dc1f80e
assignee: Waldorf the Compiler
labels: []
created: '2026-06-26T10:11:43.436Z'
updated: '2026-06-26T10:16:09.590Z'
order: 0
---

At the moment we have a bit of an issue with workers in that they're interfering with each other and committing one anothers work (or breaking the build whilst someone else is working). Ideally we need some isolation for each task but I am not sure what to suggest? Can you come up with a ticket, with some options in that I can choose from? I also want to make sure this works with remote workers and the commit strategy for a project - so if it's straight to `main` sort of project we need to make sure that applies for remote workers to.

Ideally we want

1. Clean version of the project from the last commit for the worker to work on (consider how we deal with node modules, although pnpm will cache things at worst)
2. Does it's thing
3. Returns the changes as commits that can then go through the strategy for the project (branching, or straight to main)
