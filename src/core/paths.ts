import os from "node:os";
import path from "node:path";

/** Root of the central Mysteron config (registry, global plugin state). */
export function mysteronHome(): string {
  return process.env.MYSTERON_HOME ?? path.join(os.homedir(), ".mysteron");
}

export function registryPath(): string {
  return path.join(mysteronHome(), "registry.json");
}

/** The per-project Mysteron directory, e.g. <project>/.mysteron */
export function projectMysteronDir(projectRoot: string): string {
  return path.join(projectRoot, ".mysteron");
}

export function projectConfigPath(projectRoot: string): string {
  return path.join(projectMysteronDir(projectRoot), "config.json");
}

export function boardDir(projectRoot: string): string {
  return path.join(projectMysteronDir(projectRoot), "board");
}

export function docsDir(projectRoot: string): string {
  return path.join(projectMysteronDir(projectRoot), "docs");
}

/** Where a ticket's image attachments live, e.g. <project>/.mysteron/board/attachments/<id> */
export function attachmentsDir(projectRoot: string, ticketId: string): string {
  return path.join(projectMysteronDir(projectRoot), "board", "attachments", ticketId);
}

export function memoryDir(projectRoot: string): string {
  return path.join(projectMysteronDir(projectRoot), "memory");
}

/** Where agent-run history is persisted, e.g. <project>/.mysteron/runs */
export function runsDir(projectRoot: string): string {
  return path.join(projectMysteronDir(projectRoot), "runs");
}

/** Companion role-spec docs, e.g. <project>/.mysteron/companions/<id>.md */
export function companionsDir(projectRoot: string): string {
  return path.join(projectMysteronDir(projectRoot), "companions");
}

export const ETIQUETTE_DOC = "ETIQUETTE.md";
export const SPEC_DOC = "SPEC.md";
