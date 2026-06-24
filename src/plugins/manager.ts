import type { Plugin } from "./types.js";
import { usageMonitorPlugin } from "./usage-monitor/index.js";

/** All plugins known to Mysteron, keyed by id. */
const REGISTRY: Record<string, Plugin> = {
  [usageMonitorPlugin.id]: usageMonitorPlugin,
};

export function allPlugins(): Plugin[] {
  return Object.values(REGISTRY);
}

export function getPlugin(id: string): Plugin | undefined {
  return REGISTRY[id];
}

/** Resolve the plugins enabled for a project config. */
export function enabledPlugins(ids: string[]): Plugin[] {
  return ids.map((id) => REGISTRY[id]).filter((p): p is Plugin => Boolean(p));
}
