/**
 * Agent-team "recipes". A companion agent can either do all the work itself
 * or delegate to a team of sub-agents described by one of these recipes.
 */

import type { CommitStrategy, ProjectConfig } from "./types.js";

export interface RecipeRole {
  role: string;
  description: string;
}

/**
 * How a recipe expects agents to use git. The default — and the one most users
 * want when several agents share one checkout — keeps small discrete commits on
 * whatever branch is currently checked out rather than spinning up new branches.
 */
export type GitStrategy = "current-branch" | "new-branch";

export interface RecipeGit {
  strategy: GitStrategy;
  /** Branch name prefix used when strategy is "new-branch", e.g. "spike/". */
  branchPrefix?: string;
}

/**
 * The git landing behaviour actually used for a run, after resolving the
 * project's explicit commit strategy (if any) over the recipe default. Adds
 * "target-branch" — land on a specific named branch — to the recipe strategies.
 * Consumed by both the prompt ({@link gitInstruction}) and the landing path
 * (`landGuestPatch`), so local and guest runs commit identically.
 */
export interface EffectiveGit {
  strategy: "current-branch" | "new-branch" | "target-branch";
  /** Named branch to land on when strategy is "target-branch". */
  targetBranch?: string;
  /** Branch-name prefix when strategy is "new-branch". */
  branchPrefix?: string;
}

export interface Recipe {
  id: string;
  name: string;
  description: string;
  /** Git behaviour the companion should follow when working under this recipe. */
  git: RecipeGit;
  roles: RecipeRole[];
}

const CURRENT_BRANCH: RecipeGit = { strategy: "current-branch" };

export const RECIPES: Recipe[] = [
  {
    id: "solo",
    name: "Solo",
    description:
      "The companion does everything itself. Best for small tickets and quick fixes.",
    git: CURRENT_BRANCH,
    roles: [{ role: "soloist", description: "Plans, implements, tests and ships the ticket end to end." }],
  },
  {
    id: "fullstack",
    name: "Full-stack team",
    description: "A balanced team for feature work that spans UI and server.",
    git: CURRENT_BRANCH,
    roles: [
      { role: "designer", description: "Owns UX, layout and visual polish; produces markup/styles." },
      { role: "frontend", description: "Implements client-side behaviour and wires up the UI." },
      { role: "backend", description: "Implements APIs, data models and business logic." },
      { role: "reviewer", description: "Reviews the diff for correctness and etiquette before merge." },
    ],
  },
  {
    id: "backend",
    name: "Backend team",
    description: "For API, data and infrastructure heavy tickets.",
    git: CURRENT_BRANCH,
    roles: [
      { role: "backend", description: "Implements APIs, data models and business logic." },
      { role: "tester", description: "Writes and runs tests; verifies acceptance criteria." },
      { role: "reviewer", description: "Reviews the diff for correctness and etiquette before merge." },
    ],
  },
  {
    id: "research",
    name: "Research + spike",
    description: "Investigate an unknown before committing to an approach.",
    // A spike is throwaway, so isolate it on its own branch rather than the shared one.
    git: { strategy: "new-branch", branchPrefix: "spike/" },
    roles: [
      { role: "researcher", description: "Explores options, reads docs/code, summarises tradeoffs." },
      { role: "prototyper", description: "Builds a throwaway spike to validate the chosen approach." },
    ],
  },
];

export function findRecipe(id: string): Recipe | undefined {
  return RECIPES.find((r) => r.id === id);
}

/**
 * The git landing behaviour for a project: the explicit commit strategy when one
 * is set, otherwise the recipe's default. This is the single source of truth both
 * local and guest runs use, so completed work commits the same way everywhere.
 */
export function resolveProjectGit(config: Pick<ProjectConfig, "recipe" | "commit">): EffectiveGit {
  const c = config.commit;
  if (c) {
    if (c.mode === "main") return { strategy: "target-branch", targetBranch: "main" };
    if (c.mode === "branch") return { strategy: "target-branch", targetBranch: (c.branch || "main").trim() || "main" };
    if (c.mode === "per-ticket") return { strategy: "new-branch", branchPrefix: c.branchPrefix?.trim() || "mysteron/" };
  }
  const recipe = findRecipe(config.recipe ?? "solo") ?? findRecipe("solo")!;
  return { strategy: recipe.git.strategy, branchPrefix: recipe.git.branchPrefix };
}

/** Prompt-ready instructions describing the run's git landing strategy. */
export function gitInstruction(git: EffectiveGit | RecipeGit): string {
  if (git.strategy === "new-branch") {
    const prefix = git.branchPrefix ?? "mysteron/";
    return `Create a dedicated git branch for this ticket (e.g. \`${prefix}<ticket-id>\`) and commit your work there, keeping it isolated from the shared branch.`;
  }
  return "Work in the branch that is currently checked out — do NOT create or switch branches. Land your work as small, focused, discrete commits on the current branch (this space is shared with the user and other agents).";
}

/** Human-readable summary of a commit strategy, for the UI / prompt context. */
export function commitStrategyLabel(c: CommitStrategy): string {
  if (c.mode === "main") return "always commit to main";
  if (c.mode === "branch") return `always commit to ${(c.branch || "main").trim() || "main"}`;
  return `new branch per ticket${c.branchPrefix ? ` (${c.branchPrefix}…)` : ""}`;
}
