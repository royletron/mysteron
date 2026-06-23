/**
 * Agent-team "recipes". A companion agent can either do all the work itself
 * or delegate to a team of sub-agents described by one of these recipes.
 */

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

/** Prompt-ready instructions describing a recipe's git branching strategy. */
export function gitInstruction(git: RecipeGit): string {
  if (git.strategy === "new-branch") {
    const prefix = git.branchPrefix ?? "henson/";
    return `Create a dedicated git branch for this ticket (e.g. \`${prefix}<ticket-id>\`) and commit your work there, keeping it isolated from the shared branch.`;
  }
  return "Work in the branch that is currently checked out — do NOT create or switch branches. Land your work as small, focused, discrete commits on the current branch (this space is shared with the user and other agents).";
}
