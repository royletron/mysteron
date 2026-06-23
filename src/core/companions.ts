import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { companionsDir } from "./paths.js";
import { generateCompanion } from "./names.js";
import { findRecipe } from "./recipes.js";
import type { Companion, ProjectConfig } from "./types.js";

/**
 * Build a companion roster for a recipe — one companion per role, each with a
 * unique fun name and a stable id (which doubles as its Claude session id).
 */
export function buildRoster(recipeId: string): Companion[] {
  const recipe = findRecipe(recipeId) ?? findRecipe("solo")!;
  const used = new Set<string>();
  return recipe.roles.map((role) => {
    let name = generateCompanion().name;
    for (let i = 0; used.has(name) && i < 30; i++) name = generateCompanion().name;
    used.add(name);
    return { id: randomUUID(), name, role: role.role, avatarSeed: name };
  });
}

/** The companion to use when none is specified — the soloist, else the first. */
export function defaultCompanion(config: ProjectConfig): Companion | undefined {
  return config.companions.find((c) => c.role === "soloist") ?? config.companions[0];
}

export function getCompanion(config: ProjectConfig, id: string | undefined): Companion | undefined {
  return id ? config.companions.find((c) => c.id === id) : undefined;
}

// --- Role-spec docs (seeded from the recipe, then user-customisable) --------

function specPath(projectRoot: string, companionId: string): string {
  return path.join(companionsDir(projectRoot), `${companionId}.md`);
}

export async function readCompanionSpec(
  projectRoot: string,
  companionId: string,
): Promise<string | undefined> {
  try {
    return await fs.readFile(specPath(projectRoot, companionId), "utf8");
  } catch {
    return undefined;
  }
}

export async function writeCompanionSpec(
  projectRoot: string,
  companionId: string,
  content: string,
): Promise<void> {
  await fs.mkdir(companionsDir(projectRoot), { recursive: true });
  await fs.writeFile(specPath(projectRoot, companionId), content, "utf8");
}

function defaultSpec(companion: Companion, roleDescription: string): string {
  return [
    `# ${companion.name} — ${companion.role}`,
    ``,
    roleDescription || "_Describe what this companion is responsible for._",
    ``,
    `## How I work`,
    ``,
    `- Follow the project's etiquette and specification.`,
    `- Stay within my role; hand off work outside it to the right companion.`,
    `- Keep changes small and focused.`,
    ``,
  ].join("\n");
}

/** Seed a role-spec doc for any companion that doesn't have one yet (never overwrites edits). */
export async function seedCompanionSpecs(projectRoot: string, config: ProjectConfig): Promise<void> {
  const recipe = findRecipe(config.recipe) ?? findRecipe("solo")!;
  for (const c of config.companions) {
    if (await readCompanionSpec(projectRoot, c.id)) continue;
    const role = recipe.roles.find((r) => r.role === c.role);
    await writeCompanionSpec(projectRoot, c.id, defaultSpec(c, role?.description ?? ""));
  }
}

/** Migrate a pre-roster config (single `companion`) to the companions[] model. */
export function migrateConfig(raw: Record<string, unknown>): ProjectConfig {
  if (Array.isArray(raw.companions) && typeof raw.recipe === "string") {
    return raw as unknown as ProjectConfig;
  }
  const old = raw.companion as { name?: string; recipe?: string } | undefined;
  const name = old?.name ?? "Companion";
  raw.recipe = (raw.recipe as string) ?? old?.recipe ?? "solo";
  raw.companions = [{ id: randomUUID(), name, role: "soloist", avatarSeed: name }];
  delete raw.companion;
  return raw as unknown as ProjectConfig;
}

export function needsMigration(raw: Record<string, unknown>): boolean {
  return !(Array.isArray(raw.companions) && typeof raw.recipe === "string");
}
