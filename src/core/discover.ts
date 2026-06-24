import { promises as fs } from "node:fs";
import path from "node:path";
import { projectMysteronDir } from "./paths.js";

/** Directories we never crawl when looking for existing docs. */
const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".mysteron", "dist", "build", "out", "coverage",
  "vendor", "target", ".next", ".cache", ".svelte-kit", "tmp", ".idea", ".vscode",
]);

/** Directories that are likely to *contain* docs and are worth recursing into. */
const DOC_DIRS = new Set(["docs", "doc", "documentation", ".github"]);

export type DiscoveredKind = "spec" | "readme" | "doc";

export interface DiscoveredDoc {
  /** Absolute path of the source file in the project. */
  sourcePath: string;
  /** Path relative to the project root (for display). */
  relPath: string;
  /** Unique name it will be imported as under .mysteron/docs. */
  importName: string;
  kind: DiscoveredKind;
  bytes: number;
}

function classify(fileName: string): DiscoveredKind {
  const lower = fileName.toLowerCase();
  if (/^(spec|specification|requirements)\.(md|markdown|txt)$/.test(lower)) return "spec";
  if (/^readme(\.|$)/.test(lower)) return "readme";
  return "doc";
}

function isDocFile(fileName: string): boolean {
  return /\.(md|markdown|mdx|txt|rst)$/i.test(fileName);
}

/**
 * Walk a directory collecting candidate doc files. Root level is always scanned;
 * known doc directories (docs/, doc/, .github/) are recursed up to `maxDepth`.
 */
async function walk(
  dir: string,
  root: string,
  depth: number,
  maxDepth: number,
  out: { sourcePath: string; relPath: string }[],
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && !DOC_DIRS.has(entry.name)) {
      // Skip dotfiles/dirs except whitelisted doc dirs like .github.
      if (!isDocFile(entry.name)) continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      // Only recurse into recognised doc directories (at any level once inside one).
      const insideDocDir = DOC_DIRS.has(entry.name) || depth > 0;
      if (insideDocDir && depth < maxDepth) {
        await walk(full, root, depth + 1, maxDepth, out);
      }
    } else if (entry.isFile() && isDocFile(entry.name)) {
      out.push({ sourcePath: full, relPath: path.relative(root, full) });
    }
  }
}

/**
 * Find markdown/text docs that already exist in a project, so `mysteron init` can
 * import them instead of starting from a blank slate. Scans the project root
 * plus any docs/ (and similar) directories, ignoring build/vendor dirs and the
 * .mysteron folder itself.
 */
export async function discoverProjectDocs(projectRoot: string): Promise<DiscoveredDoc[]> {
  const abs = path.resolve(projectRoot);
  const mysteronDir = projectMysteronDir(abs);
  const found: { sourcePath: string; relPath: string }[] = [];
  await walk(abs, abs, 0, 3, found);

  const usedNames = new Set<string>();
  const docs: DiscoveredDoc[] = [];
  for (const f of found) {
    // Never re-import anything already living under .mysteron.
    if (f.sourcePath.startsWith(mysteronDir + path.sep)) continue;

    const base = path.basename(f.sourcePath);
    let importName = base;
    // De-dupe collisions (e.g. README.md at root and docs/README.md) by prefixing.
    if (usedNames.has(importName.toLowerCase())) {
      const dirPart = path.dirname(f.relPath).replace(/[\\/]/g, "-");
      importName = dirPart && dirPart !== "." ? `${dirPart}-${base}` : `dup-${base}`;
    }
    usedNames.add(importName.toLowerCase());

    const stat = await fs.stat(f.sourcePath).catch(() => undefined);
    docs.push({
      sourcePath: f.sourcePath,
      relPath: f.relPath,
      importName,
      kind: classify(base),
      bytes: stat?.size ?? 0,
    });
  }

  // Spec first, then readme, then the rest — alphabetical within a kind.
  const rank: Record<DiscoveredKind, number> = { spec: 0, readme: 1, doc: 2 };
  return docs.sort(
    (a, b) => rank[a.kind] - rank[b.kind] || a.relPath.localeCompare(b.relPath),
  );
}
