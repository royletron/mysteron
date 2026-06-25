import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * A git ref naming the current *working-tree* state (tracked files incl.
 * uncommitted edits), suitable for `git archive`. `git stash create` builds a
 * commit object without touching the working tree; with no changes it returns
 * empty, so we fall back to HEAD.
 */
export async function workingTreeRef(root: string): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-C", root, "stash", "create"], { maxBuffer: 1 << 20 });
    return stdout.trim() || "HEAD";
  } catch {
    return "HEAD";
  }
}

export interface ApplyResult {
  ok: boolean;
  branch: string;
  commit?: string;
  error?: string;
}

/**
 * Apply a guest's diff onto a fresh branch in an isolated worktree, so the
 * host's own working tree/checkout is never disturbed. The branch is left
 * behind for review; the temp worktree is always cleaned up.
 */
export async function applyGuestPatch(
  root: string,
  opts: { runId: string; branch: string; patch: string; message: string; trailer?: string },
): Promise<ApplyResult> {
  const wt = path.join(os.tmpdir(), `mysteron-apply-${opts.runId}`);
  const patchFile = path.join(os.tmpdir(), `mysteron-patch-${opts.runId}.diff`);
  const git = (args: string[]) => exec("git", args, { maxBuffer: 64 << 20 });
  try {
    await fs.writeFile(patchFile, opts.patch, "utf8");
    await git(["-C", root, "worktree", "add", "-q", "-b", opts.branch, wt, "HEAD"]);
    await git(["-C", wt, "apply", "--binary", "--whitespace=nowarn", patchFile]);
    await git(["-C", wt, "add", "-A"]);
    const msg = opts.trailer ? `${opts.message}\n\n${opts.trailer}` : opts.message;
    await git(["-C", wt, "-c", "user.name=Mysteron", "-c", "user.email=mysteron@local", "commit", "-q", "-m", msg]);
    const { stdout } = await git(["-C", wt, "rev-parse", "HEAD"]);
    return { ok: true, branch: opts.branch, commit: stdout.trim() };
  } catch (e) {
    return { ok: false, branch: opts.branch, error: (e as Error).message };
  } finally {
    await exec("git", ["-C", root, "worktree", "remove", "--force", wt]).catch(() => undefined);
    await fs.rm(patchFile, { force: true }).catch(() => undefined);
  }
}

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
