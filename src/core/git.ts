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

/** Whether `root` is inside a git work tree (so we can isolate runs in a worktree). */
export async function isGitRepo(root: string): Promise<boolean> {
  return exec("git", ["-C", root, "rev-parse", "--is-inside-work-tree"])
    .then(({ stdout }) => stdout.trim() === "true")
    .catch(() => false);
}

export interface RunWorktree {
  /** The isolated checkout directory the agent runs in. */
  dir: string;
  /** The throwaway branch the worktree is checked out on. */
  branch: string;
  /** The commit the worktree started at — the base the run's diff is taken against. */
  baseSha: string;
}

/**
 * Create an isolated git worktree at `ref` for a local run, so an agent works in
 * its own checkout rather than the shared one. Mirrors the guest's throwaway
 * repo: the run's changes are diffed against `baseSha` and landed via
 * {@link landGuestPatch}. Tear it down with {@link removeRunWorktree}.
 */
export async function addRunWorktree(root: string, ref: string, runId: string): Promise<RunWorktree> {
  const dir = path.join(os.tmpdir(), `mysteron-run-${runId}`);
  const branch = `mysteron/_run-${runId}`;
  await exec("git", ["-C", root, "worktree", "add", "-q", "-b", branch, dir, ref], { maxBuffer: 64 << 20 });
  const baseSha = (await exec("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
  return { dir, branch, baseSha };
}

/** Remove a run worktree and its throwaway branch (best-effort, idempotent). */
export async function removeRunWorktree(root: string, dir: string, branch: string): Promise<void> {
  await exec("git", ["-C", root, "worktree", "remove", "--force", dir]).catch(() => undefined);
  await exec("git", ["-C", root, "branch", "-D", branch]).catch(() => undefined);
}

/**
 * Diff an isolated run worktree against its base, returning a binary patch (like
 * the guest's `git diff base HEAD`) plus the agent's own commit message(s) for
 * landing. Uncommitted work is committed first so nothing is lost. Returns an
 * empty patch when the run produced no file changes.
 */
export async function worktreeRunPatch(
  dir: string,
  baseSha: string,
): Promise<{ patch: string; commitMessage?: string }> {
  const g = (args: string[]) => exec("git", ["-C", dir, ...args], { maxBuffer: 256 << 20 });
  const ident = ["-c", "user.name=Mysteron", "-c", "user.email=mysteron@local"];

  // Preserve the agent's own commit message(s) before flattening to a diff.
  const agentCommits = Number((await g(["rev-list", "--count", `${baseSha}..HEAD`])).stdout.trim()) || 0;
  let commitMessage: string | undefined;
  if (agentCommits > 0) {
    commitMessage = (await g(["log", "--format=%B", "--reverse", `${baseSha}..HEAD`])).stdout.trim() || undefined;
  }

  // Capture anything left uncommitted so the returned diff is complete.
  await g(["add", "-A"]);
  const pending = (await g(["diff", "--cached", "--name-only"])).stdout.trim();
  if (pending) {
    await g([...ident, "commit", "-q", "-m", agentCommits > 0 ? "chore: capture uncommitted changes" : "work"]);
  }
  const patch = (await g(["diff", "--binary", baseSha, "HEAD"])).stdout;
  return { patch, commitMessage };
}

/** Package managers we know how to install for in an isolated worktree. */
export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

/** Lockfile → package manager, in detection order (most specific first). */
const LOCKFILES: { file: string; manager: PackageManager }[] = [
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "npm-shrinkwrap.json", manager: "npm" },
  { file: "package-lock.json", manager: "npm" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "bun.lockb", manager: "bun" },
];

/**
 * Whether the host's *working tree* carries an uncommitted change to a lockfile
 * (modified, staged or brand-new). A run's snapshot includes such a change, so
 * the worktree starts from a lockfile the host's node_modules wasn't installed
 * from — meaning a symlink to that node_modules would be stale. Returns the
 * changed lockfile and its package manager, or null when no lockfile moved.
 */
export async function lockfileChange(
  root: string,
): Promise<{ file: string; manager: PackageManager } | null> {
  const files = LOCKFILES.map((l) => l.file);
  let porcelain: string;
  try {
    porcelain = (await exec("git", ["-C", root, "status", "--porcelain", "--untracked-files=all", "--", ...files])).stdout;
  } catch {
    return null;
  }
  const changed = new Set(statusEntries(porcelain).map((e) => e.path));
  return LOCKFILES.find((l) => changed.has(l.file)) ?? null;
}

export interface LandResult {
  ok: boolean;
  /** How the work landed: into the checked-out branch's working tree, on a (dedicated or named) branch, applied to nothing (already present), or not at all. */
  mode: "current-branch" | "branch" | "noop" | "failed";
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
 * Land a guest's or local run's returned diff on the host, under the project's
 * git strategy:
 *  - "current-branch": fast-forward the checked-out branch onto the commit, so
 *    the work lands in the host's working tree — but only when that tree is
 *    clean, so in-progress edits are never disturbed.
 *  - "target-branch": land on a specific named branch (e.g. `main`). When that
 *    branch is the one checked out, this behaves like "current-branch"; when it
 *    isn't, the commit is built on top of that branch and its ref advanced, so
 *    the work waits there for the user — the checkout is untouched either way.
 *  - "new-branch" (or a fallback when the target/current branch is dirty or
 *    can't fast-forward): leave the commit on a dedicated <prefix><ticket>
 *    branch for review.
 *
 * The commit is built in a throwaway worktree (the checkout is never touched
 * while building it), and `git apply --3way` merges the delta even when the host
 * has moved on since dispatch. The raw patch is saved first, so a failed apply
 * still leaves the work recoverable.
 */
export async function landGuestPatch(
  root: string,
  opts: {
    runId: string;
    ticketId: string;
    patch: string;
    message: string;
    trailer?: string;
    strategy: "current-branch" | "new-branch" | "target-branch";
    /** Named branch to land on when strategy is "target-branch". */
    targetBranch?: string;
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

  // Build the commit on top of the right base: for "target-branch" that's the
  // named branch (so advancing its ref is a clean fast-forward); otherwise HEAD.
  const current = await currentBranch(root);
  const target = opts.strategy === "target-branch" ? (opts.targetBranch || "main") : undefined;
  const buildBase = target && target !== current && (await refExists(root, target)) ? target : "HEAD";

  // Build the commit in an isolated worktree — never touches the checkout.
  const wt = path.join(os.tmpdir(), `mysteron-apply-${opts.runId}`);
  const tmpBranch = `mysteron/_apply-${opts.runId}`;
  let commit: string;
  try {
    await git(["-C", root, "worktree", "add", "-q", "-b", tmpBranch, wt, buildBase]);
    await git(["-C", wt, "apply", "--3way", "--binary", "--whitespace=nowarn", patchPath]);
    await git(["-C", wt, "add", "-A"]);
    // The patch can apply to nothing — e.g. a resumed run re-emits a diff whose
    // changes are already in the base. `git commit` errors on an empty tree, so
    // treat that as a no-op rather than a failed landing.
    const nothingStaged = await git(["-C", wt, "diff", "--cached", "--quiet"]).then(() => true).catch(() => false);
    if (nothingStaged) {
      await exec("git", ["-C", root, "worktree", "remove", "--force", wt]).catch(() => undefined);
      await git(["-C", root, "branch", "-D", tmpBranch]).catch(() => undefined);
      return { ok: true, mode: "noop", patchPath };
    }
    await git(["-C", wt, ...ident, "commit", "-q", "-m", msg]);
    commit = (await git(["-C", wt, "rev-parse", "HEAD"])).stdout.trim();
  } catch (e) {
    await exec("git", ["-C", root, "worktree", "remove", "--force", wt]).catch(() => undefined);
    await git(["-C", root, "branch", "-D", tmpBranch]).catch(() => undefined);
    return { ok: false, mode: "failed", patchPath, error: (e as Error).message };
  }
  // The commit now lives in the object db on tmpBranch; the worktree is done.
  await exec("git", ["-C", root, "worktree", "remove", "--force", wt]).catch(() => undefined);

  // target-branch onto a branch that ISN'T checked out: advance its ref to the
  // commit (built on top of it, so this is a fast-forward) and leave the checkout
  // alone. The work waits on `target` for the user to merge.
  if (target && target !== current) {
    const moved = await git(["-C", root, "branch", "-f", target, commit]).then(() => true).catch(() => false);
    if (moved) {
      await git(["-C", root, "branch", "-D", tmpBranch]).catch(() => undefined);
      return { ok: true, mode: "branch", branch: target, commit, patchPath };
    }
    // couldn't move it — fall through to a dedicated review branch.
  }

  // current-branch (or target-branch where target IS the checkout): fast-forward
  // the checked-out branch onto the commit, but only when its tracked files are
  // clean (a dirty tree / collision falls back to a named branch instead).
  if (opts.strategy === "current-branch" || (target && target === current)) {
    // Board files (.mysteron/) live in-tree and the app rewrites them on every
    // ticket move — dispatching this very run flipped the ticket to "in-progress" —
    // so they're nearly always "dirty". Ignore them here (as mergeBranch does), or
    // that board write alone would force the work onto a dedicated branch.
    const dirty = statusEntries(
      (await git(["-C", root, "status", "--porcelain", "--untracked-files=no"])).stdout,
    ).some((e) => !isBoardPath(e.path));
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

  // new-branch, or a fallback: keep the commit on a dedicated branch.
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

/** Identity Mysteron uses when it authors commits itself (snapshots, merges, board commits). */
export const MYSTERON_EMAIL = "mysteron@local";

export interface Commit {
  hash: string;
  shortHash: string;
  author: string;
  date: string; // ISO
  subject: string;
  /** Companion name parsed from a `Mysteron-Companion:` trailer, if present. */
  companion?: string;
  /** True when Mysteron itself authored the commit (no companion behind it). */
  mysteron?: boolean;
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
      ["log", `-n${limit}`, `--pretty=format:%H${UNIT}%h${UNIT}%an${UNIT}%ae${UNIT}%aI${UNIT}%s${UNIT}%b${REC}`],
      { cwd: projectRoot, maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout
      .split(REC)
      .map((s) => s.replace(/^\n/, ""))
      .filter((s) => s.trim())
      .map((chunk) => {
        const [hash, shortHash, author, email, date, subject, body = ""] = chunk.split(UNIT);
        // Accept the legacy `Henson-Companion:` trailer too, so commits made
        // before the rename keep their attribution.
        const trailer = body.match(/^(?:Mysteron|Henson)-Companion:\s*(.+?)\s*$/im);
        return { hash, shortHash, author, date, subject, companion: trailer?.[1], mysteron: email === MYSTERON_EMAIL };
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

export interface OriginStatus {
  /** True when the repo has at least one remote configured. */
  hasRemote: boolean;
  /** The remote used for the comparison (`origin` if present, else the first remote). */
  remote?: string;
  /** The checked-out branch ("" if detached / not a repo). */
  branch: string;
  /** The upstream ref this branch tracks (e.g. `origin/main`), if any. */
  upstream?: string;
  /** Local commits not on the upstream — i.e. what a push would send. */
  ahead: number;
  /** Upstream commits not held locally — i.e. what a pull would bring in. */
  behind: number;
}

/** Best-effort stderr/stdout from a failed git invocation, for surfacing to the user. */
function gitErrorText(e: unknown): string {
  const x = e as { stderr?: string; stdout?: string; message?: string };
  return (x.stderr || x.stdout || x.message || String(e)).trim();
}

/**
 * How far the checked-out branch is ahead/behind its origin tracking branch —
 * the "out of whack with origin" reading. By default this uses the local refs
 * (fast, offline-safe); pass `{ fetch: true }` to refresh from the remote first
 * (best-effort: never prompts for credentials and is bounded by a timeout, so an
 * offline/unauthenticated remote just leaves the last-known numbers in place).
 */
export async function originStatus(root: string, opts?: { fetch?: boolean }): Promise<OriginStatus> {
  const branch = await currentBranch(root);
  const git = (args: string[]) => exec("git", ["-C", root, ...args]);
  const remotes = await git(["remote"])
    .then(({ stdout }) => stdout.split("\n").map((s) => s.trim()).filter(Boolean))
    .catch(() => [] as string[]);
  const hasRemote = remotes.length > 0;
  const remote = remotes.includes("origin") ? "origin" : remotes[0];
  if (!branch || !hasRemote) return { hasRemote, remote, branch, ahead: 0, behind: 0 };

  if (opts?.fetch) {
    await exec("git", ["-C", root, "fetch", "--quiet", remote!], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      timeout: 10_000,
    }).catch(() => undefined);
  }

  let upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
    .then(({ stdout }) => stdout.trim())
    .catch(() => "");
  if (!upstream && (await refExists(root, `${remote}/${branch}`))) upstream = `${remote}/${branch}`;
  if (!upstream) return { hasRemote, remote, branch, ahead: 0, behind: 0 };

  const counts = await git(["rev-list", "--left-right", "--count", `${upstream}...HEAD`])
    .then(({ stdout }) => stdout.trim().split(/\s+/).map(Number))
    .catch(() => [0, 0]);
  return { hasRemote, remote, branch, upstream, behind: counts[0] || 0, ahead: counts[1] || 0 };
}

export interface PushResult {
  ok: boolean;
  /** Whether we had to `pull --rebase` onto origin before the push went through. */
  rebased: boolean;
  branch: string;
  error?: string;
  /** Raw git output from the failing step, for display. */
  output?: string;
}

/**
 * Push the checked-out branch to origin. If the straight push is rejected (the
 * branch is behind origin), rebase onto `origin/<branch>` and try once more —
 * otherwise crap out, leaving the tree as it was (a failed rebase is aborted).
 */
export async function pushCurrentBranch(root: string): Promise<PushResult> {
  const branch = await currentBranch(root);
  if (!branch) return { ok: false, rebased: false, branch: "", error: "not on a branch (detached HEAD) — can't push" };
  const git = (args: string[]) => exec("git", ["-C", root, ...args], { maxBuffer: 16 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

  try {
    await git(["push"]);
    return { ok: true, rebased: false, branch };
  } catch {
    // Out of sync with origin — rebase our work on top of theirs, then retry.
  }
  try {
    await git(["pull", "--rebase", "origin", branch]);
  } catch (e) {
    await git(["rebase", "--abort"]).catch(() => undefined);
    return { ok: false, rebased: false, branch, error: `couldn't rebase ${branch} onto origin — resolve it locally`, output: gitErrorText(e) };
  }
  try {
    await git(["push"]);
    return { ok: true, rebased: true, branch };
  } catch (e) {
    return { ok: false, rebased: true, branch, error: `push of ${branch} failed even after rebasing onto origin`, output: gitErrorText(e) };
  }
}
