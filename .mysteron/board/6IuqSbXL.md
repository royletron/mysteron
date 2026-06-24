---
title: Recipes
state: done
priority: medium
assignee: Waldorf the Compiler
labels: []
created: '2026-06-23T18:03:21.950Z'
updated: '2026-06-23T21:40:06.684Z'
---

For the recipes. We need to be able to toggle our companion onto them. We also need to be able to determine things like git behaviour in the recipe - at the moment my agents seem to always want to create branches, but I would much rather they worked with discrete commits in the branch I am currently in (as they have to share the space).

---

**Done** (commit `681593b`, all tests green, both typechecks clean):

- **Per-recipe git behaviour.** Added a `git` strategy to recipes (`current-branch` | `new-branch`, with optional `branchPrefix`). solo/fullstack/backend default to `current-branch` → small discrete commits on the branch you're already on, *no* new branches (this is the bit you asked for). `research` opts into a throwaway `spike/` branch since a spike is disposable.
- **Wired into the agent.** The recipe's git instruction is now injected into the agent prompt (a `# Git` section) — previously the companion's `recipe` was stored but never actually used. Multi-role recipes also inject a `# Team` section listing roles to delegate to.
- **Toggle the companion onto a recipe.** The Companion tab lists recipes as selectable cards (highlights the active one, shows each recipe's git behaviour) and PATCHes `companion.recipe`. The config endpoint now validates the recipe id.
- **Tests:** new coverage for `buildPrompt` (git + team sections, unknown-recipe fallback to solo) and for recipe git data / `gitInstruction`.

Note: committed directly to `main` per project etiquette and this ticket's own "discrete commits in the current branch" intent (matching the existing history), rather than cutting a feature branch.
