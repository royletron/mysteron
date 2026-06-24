import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { memoryDir } from "./paths.js";
import type { MemorySummary } from "./types.js";

/**
 * Project memory mirrors the Claude Code memory format: one markdown file per
 * fact, with frontmatter (name, description, metadata.type). Stored under
 * <project>/.mysteron/memory so it travels with the git repo.
 */

function safeName(name: string): string {
  const base = path.basename(name);
  if (base !== name || name.includes("..")) {
    throw new Error(`Invalid memory name: ${name}`);
  }
  return name.endsWith(".md") ? name : `${name}.md`;
}

export async function listMemories(projectRoot: string): Promise<MemorySummary[]> {
  const dir = memoryDir(projectRoot);
  let files: string[] = [];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
  } catch {
    return [];
  }
  const out: MemorySummary[] = [];
  for (const f of files) {
    const raw = await fs.readFile(path.join(dir, f), "utf8");
    const { data } = matter(raw);
    out.push({
      name: f.replace(/\.md$/, ""),
      description: data.description as string | undefined,
      type: (data.metadata as { type?: string } | undefined)?.type,
    });
  }
  return out;
}

export async function readMemory(
  projectRoot: string,
  name: string,
): Promise<string | undefined> {
  try {
    return await fs.readFile(path.join(memoryDir(projectRoot), safeName(name)), "utf8");
  } catch {
    return undefined;
  }
}

export async function writeMemory(
  projectRoot: string,
  name: string,
  content: string,
): Promise<string> {
  const dir = memoryDir(projectRoot);
  await fs.mkdir(dir, { recursive: true });
  const safe = safeName(name);
  await fs.writeFile(path.join(dir, safe), content, "utf8");
  return safe;
}
