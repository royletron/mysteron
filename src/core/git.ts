import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface Commit {
  hash: string;
  shortHash: string;
  author: string;
  date: string; // ISO
  subject: string;
  /** Companion name parsed from a `Mysteron-Companion:` trailer, if present. */
  companion?: string;
}

const UNIT = "\x1f"; // field separator
const REC = "\x1e"; // record separator

/**
 * Recent git commits in a project, with the `Mysteron-Companion:` trailer parsed
 * out so the app can attribute commits to companions. Returns [] for a non-git
 * directory (or if git isn't available) rather than throwing.
 */
export async function recentCommits(projectRoot: string, limit = 50): Promise<Commit[]> {
  try {
    const { stdout } = await exec(
      "git",
      ["log", `-n${limit}`, `--pretty=format:%H${UNIT}%h${UNIT}%an${UNIT}%aI${UNIT}%s${UNIT}%b${REC}`],
      { cwd: projectRoot, maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout
      .split(REC)
      .map((s) => s.replace(/^\n/, ""))
      .filter((s) => s.trim())
      .map((chunk) => {
        const [hash, shortHash, author, date, subject, body = ""] = chunk.split(UNIT);
        // Accept the legacy `Henson-Companion:` trailer too, so commits made
        // before the rename keep their attribution.
        const trailer = body.match(/^(?:Mysteron|Henson)-Companion:\s*(.+?)\s*$/im);
        return { hash, shortHash, author, date, subject, companion: trailer?.[1] };
      });
  } catch {
    return [];
  }
}
