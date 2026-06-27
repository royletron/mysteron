import path from "node:path";
import type { Plugin } from "./types.js";
import { usageMonitorPlugin } from "./usage-monitor/index.js";

/** All plugins bundled with Mysteron, keyed by id. */
const REGISTRY: Record<string, Plugin> = {
  [usageMonitorPlugin.id]: usageMonitorPlugin,
};

export function allPlugins(): Plugin[] {
  return Object.values(REGISTRY);
}

export function getPlugin(id: string): Plugin | undefined {
  return REGISTRY[id];
}

/**
 * Resolve the plugins enabled for a project. Entries that match a bundled id
 * are returned synchronously from the registry. Entries that look like a path
 * (contain a separator or start with `.`) are dynamically imported relative to
 * `projectRoot` — this lets a user ship a custom plugin in their project repo
 * and add its path to `config.plugins` without touching manager.ts.
 *
 * Unresolvable entries (missing file, bad export shape) are silently skipped so
 * a typo doesn't crash the MCP server.
 */
export async function resolvePlugins(projectRoot: string, ids: string[]): Promise<Plugin[]> {
  const plugins: Plugin[] = [];
  for (const id of ids) {
    if (REGISTRY[id]) {
      plugins.push(REGISTRY[id]);
      continue;
    }
    // ponytail: any non-registry entry is treated as a module path; import() handles
    //           both relative ('./plugins/x.js') and absolute paths cleanly.
    try {
      const abs = path.isAbsolute(id) ? id : path.resolve(projectRoot, id);
      const mod = (await import(abs)) as { default?: Plugin; plugin?: Plugin };
      const plugin = mod.default ?? mod.plugin;
      if (plugin && typeof plugin.id === "string" && typeof plugin.name === "string") {
        plugins.push(plugin);
      }
    } catch {
      /* skip unresolvable entries — a missing/broken plugin must not crash the server */
    }
  }
  return plugins;
}

/** Synchronous resolver for callers that can't await (API listing, legacy paths). */
export function enabledPlugins(ids: string[]): Plugin[] {
  return ids.map((id) => REGISTRY[id]).filter((p): p is Plugin => Boolean(p));
}
