import os from "node:os";
import path from "node:path";

/** Root of the central Henson config (registry, global plugin state). */
export function hensonHome(): string {
  return process.env.HENSON_HOME ?? path.join(os.homedir(), ".henson");
}

export function registryPath(): string {
  return path.join(hensonHome(), "registry.json");
}

/** The per-project Henson directory, e.g. <project>/.henson */
export function projectHensonDir(projectRoot: string): string {
  return path.join(projectRoot, ".henson");
}

export function projectConfigPath(projectRoot: string): string {
  return path.join(projectHensonDir(projectRoot), "config.json");
}

export function boardDir(projectRoot: string): string {
  return path.join(projectHensonDir(projectRoot), "board");
}

export function docsDir(projectRoot: string): string {
  return path.join(projectHensonDir(projectRoot), "docs");
}

/** Where a ticket's image attachments live, e.g. <project>/.henson/board/attachments/<id> */
export function attachmentsDir(projectRoot: string, ticketId: string): string {
  return path.join(projectHensonDir(projectRoot), "board", "attachments", ticketId);
}

export function memoryDir(projectRoot: string): string {
  return path.join(projectHensonDir(projectRoot), "memory");
}

/** Where agent-run history is persisted, e.g. <project>/.henson/runs */
export function runsDir(projectRoot: string): string {
  return path.join(projectHensonDir(projectRoot), "runs");
}

/** Companion role-spec docs, e.g. <project>/.henson/companions/<id>.md */
export function companionsDir(projectRoot: string): string {
  return path.join(projectHensonDir(projectRoot), "companions");
}

export const ETIQUETTE_DOC = "ETIQUETTE.md";
export const SPEC_DOC = "SPEC.md";
