import { promises as fs } from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { discoverProjectDocs, type DiscoveredKind } from "./discover.js";
import { buildRoster, migrateConfig, needsMigration, seedCompanionSpecs } from "./companions.js";
import {
  ETIQUETTE_DOC,
  SPEC_DOC,
  boardDir,
  docsDir,
  memoryDir,
  projectConfigPath,
  projectMysteronDir,
} from "./paths.js";
import { registerProject } from "./registry.js";
import type { ProjectConfig } from "./types.js";

const DEFAULT_ETIQUETTE = `# Project etiquette

A short contract for any agent working in this project.

- **Always commit** your work in small, focused commits with clear messages.
- **Always merge to main** once a ticket is reviewed and green — don't let branches rot.
- **Always run the tests** before moving a ticket to \`review\` or \`done\`.
- **Write few comments** — let clear code and names carry the meaning; comment only the surprising bits.
- **Match the surrounding style** rather than introducing new conventions.
- **Keep tickets honest** — if tests fail, say so; if a step was skipped, note it on the ticket.
`;

function defaultSpec(name: string): string {
  return `# ${name}

> Project specification. Edit this in the Mysteron web UI or directly on disk —
> changes are watched and can be turned into tickets.

## Overview

_Describe what this project is and what "done" looks like._

## Goals

- ...

## Non-goals

- ...
`;
}

export async function loadProjectConfig(projectRoot: string): Promise<ProjectConfig | undefined> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await fs.readFile(projectConfigPath(projectRoot), "utf8"));
  } catch {
    return undefined;
  }
  // Migrate pre-roster configs (single `companion`) to companions[] once, in place.
  if (needsMigration(parsed)) {
    const migrated = migrateConfig(parsed);
    await saveProjectConfig(projectRoot, migrated).catch(() => undefined);
    await seedCompanionSpecs(projectRoot, migrated).catch(() => undefined);
    return migrated;
  }
  return parsed as unknown as ProjectConfig;
}

export async function saveProjectConfig(
  projectRoot: string,
  config: ProjectConfig,
): Promise<void> {
  await fs.mkdir(projectMysteronDir(projectRoot), { recursive: true });
  await fs.writeFile(
    projectConfigPath(projectRoot),
    JSON.stringify(config, null, 2) + "\n",
    "utf8",
  );
}

export interface InitOptions {
  name?: string;
  plugins?: string[];
  yolo?: boolean;
  /** Agent-team recipe id; drives the companion roster. Defaults to "solo". */
  recipe?: string;
  /** Import docs already present in the project (default true). */
  importDocs?: boolean;
}

export interface ImportedDoc {
  importName: string;
  /** Source path relative to the project root. */
  from: string;
  kind: DiscoveredKind;
}

export interface InitResult {
  config: ProjectConfig;
  /** Docs discovered in the project and imported into .mysteron/docs. */
  importedDocs: ImportedDoc[];
  /** True if Mysteron was already initialised here (nothing was scaffolded). */
  alreadyInitialised: boolean;
  /**
   * True when an existing committed .mysteron/config.json was found and adopted —
   * e.g. the project was cloned from a machine where it was already set up. The
   * shared companion identity, board, docs and memory are reused as-is.
   */
  adopted: boolean;
  /**
   * True when a .mysteron/ folder existed but had no usable config.json, so a new
   * config was written while preserving any existing board/docs/memory.
   */
  repaired: boolean;
}

/**
 * Initialise Mysteron inside an existing project folder: create the .mysteron
 * scaffold, generate a companion, import any docs already in the project,
 * seed SPEC + ETIQUETTE docs, and register it.
 */
export async function initProject(
  projectRoot: string,
  opts: InitOptions = {},
): Promise<InitResult> {
  const abs = path.resolve(projectRoot);
  await fs.mkdir(abs, { recursive: true });

  // Adopt an existing committed setup (e.g. a clone) rather than overwriting it.
  // Reuse the config's id so the project keeps one identity across machines.
  const existing = await loadProjectConfig(abs);
  if (existing) {
    await registerProject(abs, existing.name, existing.id);
    return {
      config: existing,
      importedDocs: [],
      alreadyInitialised: true,
      adopted: true,
      repaired: false,
    };
  }

  // A .mysteron/ folder with no usable config means a half-present / corrupt setup.
  const repaired = await dirExists(projectMysteronDir(abs));

  const name = opts.name ?? path.basename(abs);
  await fs.mkdir(boardDir(abs), { recursive: true });
  await fs.mkdir(docsDir(abs), { recursive: true });
  await fs.mkdir(memoryDir(abs), { recursive: true });

  const specPath = path.join(docsDir(abs), SPEC_DOC);
  const etiquettePath = path.join(docsDir(abs), ETIQUETTE_DOC);

  // Import any docs the project already has, before seeding placeholders so the
  // user's own SPEC/ETIQUETTE win over our defaults.
  const importedDocs: ImportedDoc[] = [];
  if (opts.importDocs !== false) {
    const discovered = await discoverProjectDocs(abs);
    const spec = discovered.find((d) => d.kind === "spec");
    if (spec) {
      const content = await fs.readFile(spec.sourcePath, "utf8").catch(() => undefined);
      if (content !== undefined && (await writeIfAbsent(specPath, content))) {
        importedDocs.push({ importName: SPEC_DOC, from: spec.relPath, kind: "spec" });
      }
    }
    for (const d of discovered) {
      if (d === spec) continue; // already handled as SPEC.md
      const target = path.join(docsDir(abs), d.importName);
      const content = await fs.readFile(d.sourcePath, "utf8").catch(() => undefined);
      if (content !== undefined && (await writeIfAbsent(target, content))) {
        importedDocs.push({ importName: d.importName, from: d.relPath, kind: d.kind });
      }
    }
  }

  // Seed placeholders only where the project didn't already provide one.
  await writeIfAbsent(specPath, defaultSpec(name));
  await writeIfAbsent(etiquettePath, DEFAULT_ETIQUETTE);

  const recipe = opts.recipe ?? "solo";
  const config: ProjectConfig = {
    id: nanoid(8),
    name,
    recipe,
    companions: buildRoster(recipe),
    plugins: opts.plugins ?? ["usage-monitor"],
    yolo: opts.yolo ?? false,
    createdAt: new Date().toISOString(),
  };
  await saveProjectConfig(abs, config);
  await seedCompanionSpecs(abs, config);
  await registerProject(abs, name, config.id);
  return { config, importedDocs, alreadyInitialised: false, adopted: false, repaired };
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** Write `content` to `file` only if it doesn't already exist. Returns true if written. */
async function writeIfAbsent(file: string, content: string): Promise<boolean> {
  try {
    await fs.access(file);
    return false;
  } catch {
    await fs.writeFile(file, content, "utf8");
    return true;
  }
}
