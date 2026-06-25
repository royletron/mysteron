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

const snapRef = (runId: string) => `refs/mysteron/snap/${runId}`;

/**
 * Snapshot the host's *full* working tree as a commit and pin it under a ref. The
 * guest diffs against this exact state (the host serves it as the snapshot tar)
 * and `git apply --3way` later needs its blobs present to merge — the ref keeps
 * them reachable until the result lands.
 *
 * Unlike `git stash create` (tracked files only), this includes **untracked but
 * not git-ignored** files, so a guest sees source the host hasn't committed yet
 * rather than a tree with files missing. Built via a throwaway index so the
 * host's real index/working tree are never touched. Returns the commit SHA, or
 * "HEAD" if nothing could be captured.
 */
export async function captureSnapshotRef(root: string, runId: string): Promise<string> {
  const tmpIndex = path.join(os.tmpdir(), `mysteron-snap-index-${runId}`);
  const env = {
    ...process.env,
    GIT_INDEX_FILE: tmpIndex,
    GIT_AUTHOR_NAME: "Mysteron",
    GIT_AUTHOR_EMAIL: "mysteron@local",
    GIT_COMMITTER_NAME: "Mysteron",
    GIT_COMMITTER_EMAIL: "mysteron@local",
  };
  const g = (args: string[]) => exec("git", ["-C", root, ...args], { env, maxBuffer: 256 << 20 });
  try {
    await g(["read-tree", "HEAD"]).catch(() => undefined); // seed from HEAD if it exists (captures deletions too)
    await g(["add", "-A"]); // stage tracked + untracked, honouring .gitignore
    const tree = (await g(["write-tree"])).stdout.trim();
    const head = await g(["rev-parse", "--verify", "-q", "HEAD"]).then((r) => r.stdout.trim()).catch(() => "");
    const commit = (await g(head ? ["commit-tree", tree, "-p", head, "-m", "mysteron snapshot"] : ["commit-tree", tree, "-m", "mysteron snapshot"])).stdout.trim();
    if (!commit) return "HEAD";
    await exec("git", ["-C", root, "update-ref", snapRef(runId), commit]).catch(() => undefined);
    return commit;
  } catch {
    // Fall back to tracked-only state rather than failing the dispatch entirely.
    return workingTreeRef(root);
  } finally {
    await fs.rm(tmpIndex, { force: true }).catch(() => undefined);
  }
}

/** Drop the pinned snapshot ref from captureSnapshotRef (best-effort). */
export async function releaseSnapshotRef(root: string, runId: string): Promise<void> {
  await exec("git", ["-C", root, "update-ref", "-d", snapRef(runId)]).catch(() => undefined);
}

export interface LandResult {
  ok: boolean;
  /** How the work landed: on the checked-out branch, on a dedicated branch, or not at all. */
  mode: "current-branch" | "branch" | "failed";
  branch?: string;
  commit?: string;
  /** Where the raw patch was saved — always written, so work is never lost even on a failed apply. */
  patchPath: string;
  error?: string;
}

async function refExists(root: string, ref: string): Promise<boolean> {
  return exec("git", ["-C", root, "rev-parse", "--verify", "--quiet", ref])
    .then(() => true)
    .catch(() => false);
}

/**
 * Land a guest's returned diff on the host, mirroring how a local run commits
 * under the project's git strategy:
 *  - "current-branch": fast-forward the checked-out branch onto the guest's
 *    commit, so the work lands in the host's working tree — but only when that
 *    tree is clean, so in-progress edits are never disturbed.
 *  - "new-branch" (or a current-branch fallback when the tree is dirty / can't
 *    fast-forward): leave the commit on a dedicated <prefix><ticket> branch for
 *    review.
 *
 * The commit is always built in a throwaway worktree off HEAD (the checkout is
 * never touched while building it), and `git apply --3way` merges the guest's
 * delta even when the host has moved on since dispatch. The raw patch is saved
 * first, so a failed apply still leaves the work recoverable.
 */
export async function landGuestPatch(
  root: string,
  opts: {
    runId: string;
    ticketId: string;
    patch: string;
    message: string;
    trailer?: string;
    strategy: "current-branch" | "new-branch";
    branchPrefix?: string;
  },
): Promise<LandResult> {
  const git = (args: string[]) => exec("git", args, { maxBuffer: 64 << 20 });
  const ident = ["-c", "user.name=Mysteron", "-c", "user.email=mysteron@local"];
  const msg = opts.trailer ? `${opts.message}\n\n${opts.trailer}` : opts.message;

  // Always persist the raw patch first — nothing is ever silently dropped.
  const patchDir = path.join(root, ".git", "mysteron-patches");
  const patchPath = path.join(patchDir, `${opts.runId}.diff`);
  await fs.mkdir(patchDir, { recursive: true });
  await fs.writeFile(patchPath, opts.patch, "utf8");

  // Build the commit in an isolated worktree off HEAD — never touches the checkout.
  const wt = path.join(os.tmpdir(), `mysteron-apply-${opts.runId}`);
  const tmpBranch = `mysteron/_apply-${opts.runId}`;
  let commit: string;
  try {
    await git(["-C", root, "worktree", "add", "-q", "-b", tmpBranch, wt, "HEAD"]);
    await git(["-C", wt, "apply", "--3way", "--binary", "--whitespace=nowarn", patchPath]);
    await git(["-C", wt, "add", "-A"]);
    await git(["-C", wt, ...ident, "commit", "-q", "-m", msg]);
    commit = (await git(["-C", wt, "rev-parse", "HEAD"])).stdout.trim();
  } catch (e) {
    await exec("git", ["-C", root, "worktree", "remove", "--force", wt]).catch(() => undefined);
    await git(["-C", root, "branch", "-D", tmpBranch]).catch(() => undefined);
    return { ok: false, mode: "failed", patchPath, error: (e as Error).message };
  }
  // The commit now lives in the object db on tmpBranch; the worktree is done.
  await exec("git", ["-C", root, "worktree", "remove", "--force", wt]).catch(() => undefined);

  // current-branch: fast-forward the checked-out branch onto the commit, but only
  // when its tracked files are clean (a dirty tree / collision means we fall back
  // to a named branch rather than risk the user's work).
  if (opts.strategy === "current-branch") {
    const dirty = (await git(["-C", root, "status", "--porcelain", "--untracked-files=no"])).stdout.trim().length > 0;
    if (!dirty) {
      try {
        await git(["-C", root, "merge", "--ff-only", commit]);
        await git(["-C", root, "branch", "-D", tmpBranch]).catch(() => undefined);
        return { ok: true, mode: "current-branch", commit, patchPath };
      } catch {
        /* fall through to leaving it on a dedicated branch */
      }
    }
  }

  // new-branch, or current-branch fallback: keep the commit on a dedicated branch.
  const prefix = (opts.branchPrefix ?? "mysteron/").replace(/\/?$/, "/");
  let branch = `${prefix}${opts.ticketId}`;
  if (await refExists(root, branch)) branch = `${prefix}${opts.ticketId}-${opts.runId}`;
  const named = await git(["-C", root, "branch", "-f", branch, commit])
    .then(() => true)
    .catch(() => false);
  if (named) {
    await git(["-C", root, "branch", "-D", tmpBranch]).catch(() => undefined);
  } else {
    branch = tmpBranch; // couldn't create the nice name — keep the work on tmpBranch
  }
  return { ok: true, mode: "branch", branch, commit, patchPath };
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

export interface BranchInfo {
  name: string;
  /** Tip commit short hash. */
  shortHash: string;
  subject: string;
  date: string; // ISO of the tip commit
  /** Companion name from the tip's `Mysteron-Companion:` trailer, if any. */
  companion?: string;
  /** Commits this branch has that the checked-out branch doesn't. */
  ahead: number;
  /** Commits the checked-out branch has that this one doesn't. */
  behind: number;
  /** Files this branch changes relative to its merge-base with the current branch. */
  filesChanged: number;
  /** Fully merged into the checked-out branch (its tip is an ancestor) — safe to delete. */
  merged: boolean;
}

/** A branch name safe to pass to git as an argument (no leading dash, no spaces/control, no `..`). */
export function isValidBranchName(name: string): boolean {
  return /^(?!-)[\w./-]+$/.test(name) && !name.includes("..");
}

/** The currently checked-out branch ("" if detached / not a repo). */
export async function currentBranch(root: string): Promise<string> {
  return exec("git", ["-C", root, "symbolic-ref", "--quiet", "--short", "HEAD"])
    .then(({ stdout }) => stdout.trim())
    .catch(() => "");
}

/**
 * Local branches other than the checked-out one, with PR-style metadata: how far
 * ahead/behind the current branch they are, what they touch, and the companion
 * that produced them. Guest work lands on these branches (see landGuestPatch), so
 * this powers the "open branches" review list. Returns [] for a non-git dir.
 */
export async function listBranches(root: string): Promise<BranchInfo[]> {
  const current = await currentBranch(root);
  let raw: string;
  try {
    const fmt = `%(refname:short)${UNIT}%(objectname:short)${UNIT}%(committerdate:iso-strict)${UNIT}%(contents:subject)${UNIT}%(trailers:key=Mysteron-Companion,valueonly)${REC}`;
    raw = (await exec("git", ["-C", root, "for-each-ref", `--format=${fmt}`, "refs/heads"], { maxBuffer: 16 << 20 })).stdout;
  } catch {
    return [];
  }
  const rows = raw
    .split(REC)
    .map((s) => s.replace(/^\n/, ""))
    .filter((s) => s.trim())
    .map((chunk) => chunk.split(UNIT))
    .filter(([name]) => name && name !== current);

  return Promise.all(
    rows.map(async ([name, shortHash, date, subject, companion]) => {
      let ahead = 0;
      let behind = 0;
      let filesChanged = 0;
      if (current) {
        const counts = await exec("git", ["-C", root, "rev-list", "--left-right", "--count", `${current}...${name}`])
          .then(({ stdout }) => stdout.trim().split(/\s+/).map(Number))
          .catch(() => [0, 0]);
        behind = counts[0] || 0;
        ahead = counts[1] || 0;
        filesChanged = await exec("git", ["-C", root, "diff", "--name-only", `${current}...${name}`])
          .then(({ stdout }) => stdout.split("\n").filter(Boolean).length)
          .catch(() => 0);
      }
      return { name, shortHash, date, subject, companion: companion?.trim() || undefined, ahead, behind, filesChanged, merged: !!current && ahead === 0 };
    }),
  );
}

/**
 * Of the given ticket ids, the ones that still have an *unmerged* open branch —
 * i.e. work that landed on a dedicated branch (see {@link landGuestPatch}, which
 * names branches `<prefix><ticketId>[-<runId>]`) but isn't in the checked-out
 * branch yet. Used by the dependency logic to tell "done" apart from "in main":
 * a ticket can be marked done while its branch is still open for review.
 */
export async function unmergedBranchTicketIds(
  root: string,
  ticketIds: Iterable<string>,
): Promise<Set<string>> {
  const blocked = new Set<string>();
  const open = (await listBranches(root)).filter((b) => !b.merged);
  if (open.length === 0) return blocked;
  for (const id of ticketIds) {
    if (open.some((b) => b.name.includes(id))) blocked.add(id);
  }
  return blocked;
}

/** Everything under the `.mysteron/` board lives in-tree but the app writes it without committing. */
const MYSTERON_DIR = ".mysteron/";
const isBoardPath = (p: string) => p === ".mysteron" || p.startsWith(MYSTERON_DIR);

/** A path touched in `git status --porcelain`, tagged tracked vs. untracked (`??`). */
interface StatusEntry {
  path: string;
  untracked: boolean;
}

/** Parse `git status --porcelain` (handles untracked `??` and rename `old -> new`). */
function statusEntries(porcelain: string): StatusEntry[] {
  return porcelain
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.length > 3)
    .flatMap((l) => {
      const untracked = l.startsWith("??");
      const rest = l.slice(3);
      const arrow = rest.indexOf(" -> ");
      const paths = arrow >= 0 ? [rest.slice(0, arrow), rest.slice(arrow + 4)] : [rest];
      return paths.map((p) => ({ path: p.replace(/^"(.*)"$/, "$1"), untracked }));
    });
}

/**
 * Stage and commit any pending changes under `.mysteron/` (new tickets and ticket
 * edits the app writes in-tree but never commits). Scoped to `.mysteron/` via a
 * pathspec commit, so a user's own staged work is left exactly as it was. Returns
 * `committed: false` when there was nothing to commit.
 */
export async function commitBoardChanges(
  root: string,
  opts?: { trailer?: string },
): Promise<{ ok: boolean; committed: boolean; commit?: string; error?: string }> {
  const git = (args: string[]) => exec("git", ["-C", root, ...args], { maxBuffer: 64 << 20 });
  try {
    await git(["add", "-A", "--", ".mysteron"]);
    const staged = (await git(["diff", "--cached", "--name-only", "--", ".mysteron"])).stdout.trim();
    if (!staged) return { ok: true, committed: false };
    const message = "chore: commit board changes";
    const msg = opts?.trailer ? `${message}\n\n${opts.trailer}` : message;
    await git(["-c", "user.name=Mysteron", "-c", "user.email=mysteron@local", "commit", "-q", "-m", msg, "--", ".mysteron"]);
    const commit = (await git(["rev-parse", "HEAD"])).stdout.trim();
    return { ok: true, committed: true, commit };
  } catch (e) {
    return { ok: false, committed: false, error: (e as Error).message };
  }
}

export interface MergeResult {
  ok: boolean;
  /** The merge hit conflicts and was aborted — the working tree is left untouched. */
  conflicted?: boolean;
  /** Pending `.mysteron/` board changes were auto-committed before the merge. */
  boardCommitted?: boolean;
  error?: string;
}

/**
 * Merge a branch into the checked-out branch (no-ff, so the branch reads as a unit
 * of work). Aborts cleanly on conflict rather than leaving the tree half-merged.
 *
 * The board (`.mysteron/`) lives in-tree but the app writes tickets without
 * committing, so the tree is almost always "dirty" with board-only changes that
 * would otherwise block (or collide with) the merge. By default those are
 * auto-committed first; any *non*-board change still refuses, so the user's own
 * work is never swept into a commit behind their back.
 */
export async function mergeBranch(
  root: string,
  branch: string,
  opts?: { autoCommitBoard?: boolean; trailer?: string },
): Promise<MergeResult> {
  if (!isValidBranchName(branch)) return { ok: false, error: "invalid branch name" };
  const git = (args: string[]) => exec("git", ["-C", root, ...args], { maxBuffer: 64 << 20 });
  let boardCommitted = false;
  const entries = await git(["status", "--porcelain"])
    .then(({ stdout }) => statusEntries(stdout))
    .catch(() => [] as StatusEntry[]);
  // Tracked edits to the user's own files block — never sweep their work into a commit.
  // (Untracked non-board files are left for git's merge to handle, as before.)
  if (entries.some((e) => !e.untracked && !isBoardPath(e.path))) {
    return { ok: false, error: "working tree has uncommitted changes — commit or stash them first" };
  }
  if (entries.some((e) => isBoardPath(e.path))) {
    if (opts?.autoCommitBoard === false) {
      return { ok: false, error: "uncommitted board changes — commit them first" };
    }
    const res = await commitBoardChanges(root, { trailer: opts?.trailer });
    if (!res.ok) return { ok: false, error: `couldn't auto-commit board changes: ${res.error}` };
    boardCommitted = res.committed;
  }
  try {
    await git(["-c", "user.name=Mysteron", "-c", "user.email=mysteron@local", "merge", "--no-ff", "-m", `Merge ${branch}`, branch]);
    return { ok: true, boardCommitted };
  } catch {
    await git(["merge", "--abort"]).catch(() => undefined);
    return { ok: false, conflicted: true, boardCommitted, error: `conflicts merging ${branch} — resolve locally with \`git merge ${branch}\`` };
  }
}

/** Delete a local branch (force; guest branches are disposable once reviewed). */
export async function deleteBranch(root: string, branch: string): Promise<{ ok: boolean; error?: string }> {
  if (!isValidBranchName(branch)) return { ok: false, error: "invalid branch name" };
  return exec("git", ["-C", root, "branch", "-D", branch])
    .then(() => ({ ok: true }))
    .catch((e) => ({ ok: false, error: (e as Error).message }));
}
