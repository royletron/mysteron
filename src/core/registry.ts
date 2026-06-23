import { promises as fs } from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { hensonHome, registryPath } from "./paths.js";
import type { Registry, RegistryEntry } from "./types.js";

async function ensureHome(): Promise<void> {
  await fs.mkdir(hensonHome(), { recursive: true });
}

export async function loadRegistry(): Promise<Registry> {
  try {
    const raw = await fs.readFile(registryPath(), "utf8");
    const parsed = JSON.parse(raw) as Registry;
    if (!Array.isArray(parsed.projects)) return { projects: [] };
    return parsed;
  } catch {
    return { projects: [] };
  }
}

export async function saveRegistry(reg: Registry): Promise<void> {
  await ensureHome();
  await fs.writeFile(registryPath(), JSON.stringify(reg, null, 2) + "\n", "utf8");
}

/**
 * Register a project path. If already registered (by path), returns the
 * existing entry. Pass `id` to reuse a project's committed config id so the
 * project keeps the same identity across machines/clones.
 */
export async function registerProject(
  projectRoot: string,
  name: string,
  id?: string,
): Promise<RegistryEntry> {
  const abs = path.resolve(projectRoot);
  const reg = await loadRegistry();
  const existing = reg.projects.find((p) => p.path === abs);
  if (existing) {
    // Keep the local entry's name/id in sync with the (possibly cloned) config.
    let changed = false;
    if (id && existing.id !== id) {
      existing.id = id;
      changed = true;
    }
    if (existing.name !== name) {
      existing.name = name;
      changed = true;
    }
    if (changed) await saveRegistry(reg);
    return existing;
  }
  // Avoid id collisions if the same shared id is somehow already present.
  const desiredId = id && !reg.projects.some((p) => p.id === id) ? id : nanoid(8);
  const entry: RegistryEntry = {
    id: desiredId,
    name,
    path: abs,
    createdAt: new Date().toISOString(),
  };
  reg.projects.push(entry);
  await saveRegistry(reg);
  return entry;
}

export async function unregisterProject(idOrPath: string): Promise<boolean> {
  const reg = await loadRegistry();
  const abs = path.resolve(idOrPath);
  const before = reg.projects.length;
  reg.projects = reg.projects.filter((p) => p.id !== idOrPath && p.path !== abs);
  if (reg.projects.length === before) return false;
  await saveRegistry(reg);
  return true;
}

export async function findEntry(idOrPath: string): Promise<RegistryEntry | undefined> {
  const reg = await loadRegistry();
  const abs = path.resolve(idOrPath);
  return reg.projects.find((p) => p.id === idOrPath || p.path === abs);
}
