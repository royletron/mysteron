import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";

const exec = promisify(execFile);
const { captureSnapshotRef, releaseSnapshotRef, landGuestPatch, listBranches, mergeBranch, deleteBranch, commitBoardChanges, unmergedBranchTicketIds, recentCommits, originStatus, pushCurrentBranch, isGitRepo, addRunWorktree, removeRunWorktree, worktreeRunPatch, lockfileChange } =
  await import("../src/core/git.js");

const roots: string[] = [];
const git = (root: string, ...a: string[]) => exec("git", ["-C", root, ...a]);
const read = (root: string, f: string) => fs.readFile(path.join(root, f), "utf8");

async function makeRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mysteron-git-test-"));
  roots.push(root);
  await git(root, "init", "-q");
  await git(root, "config", "user.name", "Test");
  await git(root, "config", "user.email", "test@local");
  await fs.writeFile(path.join(root, "a.txt"), "hello\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "base");
  return root;
}

/** A patch like the guest's `git diff base HEAD`: modify a.txt, add b.txt. */
async function guestPatch(root: string): Promise<string> {
  await fs.writeFile(path.join(root, "a.txt"), "hello world\n");
  await fs.writeFile(path.join(root, "b.txt"), "new file\n");
  await git(root, "add", "-A");
  const { stdout } = await git(root, "diff", "--binary", "--cached");
  await git(root, "reset", "-q", "--hard");
  await git(root, "clean", "-fdq");
  return stdout;
}

const refExists = (root: string, ref: string) =>
  git(root, "rev-parse", "--verify", "--quiet", ref).then(() => true).catch(() => false);

after(async () => {
  for (const r of roots) await fs.rm(r, { recursive: true, force: true }).catch(() => undefined);
});

test("landGuestPatch (current-branch) commits onto the checked-out branch when clean", async () => {
  const root = await makeRepo();
  const patch = await guestPatch(root);
  const head0 = (await git(root, "rev-parse", "HEAD")).stdout.trim();

  const res = await landGuestPatch(root, { runId: "r1", ticketId: "t1", patch, message: "Add stuff", strategy: "current-branch" });

  assert.equal(res.ok, true);
  assert.equal(res.mode, "current-branch");
  assert.equal(await read(root, "a.txt"), "hello world\n"); // landed in the working tree
  assert.equal(await read(root, "b.txt"), "new file\n");
  assert.notEqual((await git(root, "rev-parse", "HEAD")).stdout.trim(), head0); // branch advanced
});

test("landGuestPatch (new-branch) leaves the checkout untouched and creates a named branch", async () => {
  const root = await makeRepo();
  const patch = await guestPatch(root);
  const head0 = (await git(root, "rev-parse", "HEAD")).stdout.trim();

  const res = await landGuestPatch(root, {
    runId: "r2", ticketId: "t2", patch, message: "Add stuff", strategy: "new-branch", branchPrefix: "spike/",
  });

  assert.equal(res.ok, true);
  assert.equal(res.mode, "branch");
  assert.equal(res.branch, "spike/t2");
  // working tree + current branch are untouched...
  assert.equal((await git(root, "rev-parse", "HEAD")).stdout.trim(), head0);
  assert.equal(await read(root, "a.txt"), "hello\n");
  // ...but the work is on the branch.
  assert.equal((await git(root, "show", "spike/t2:b.txt")).stdout, "new file\n");
  // and no temp branch is left behind.
  assert.equal(await refExists(root, "mysteron/_apply-r2"), false);
});

test("landGuestPatch (current-branch) falls back to a dedicated branch when the tree is dirty", async () => {
  const root = await makeRepo();
  const patch = await guestPatch(root);
  await fs.writeFile(path.join(root, "a.txt"), "locally edited\n"); // uncommitted tracked change

  const res = await landGuestPatch(root, { runId: "r3", ticketId: "t3", patch, message: "Add stuff", strategy: "current-branch" });

  assert.equal(res.ok, true);
  assert.equal(res.mode, "branch");
  assert.equal(res.branch, "mysteron/t3");
  assert.equal(await read(root, "a.txt"), "locally edited\n"); // local work preserved
  assert.equal((await git(root, "show", "mysteron/t3:b.txt")).stdout, "new file\n");
});

test("landGuestPatch ignores board-only changes and still lands on the checked-out branch", async () => {
  const root = await makeRepo();
  // Board files are tracked but the app rewrites them on every ticket move
  // (this run moved its own ticket to in-progress) — they must not count as "dirty".
  await fs.mkdir(path.join(root, ".mysteron", "board"), { recursive: true });
  await fs.writeFile(path.join(root, ".mysteron", "board", "t.md"), "state: ready\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "seed board");
  await fs.writeFile(path.join(root, ".mysteron", "board", "t.md"), "state: in-progress\n"); // uncommitted board edit
  const patch = await guestPatch(root);

  const res = await landGuestPatch(root, { runId: "r5", ticketId: "t5", patch, message: "Add stuff", strategy: "current-branch" });

  assert.equal(res.ok, true);
  assert.equal(res.mode, "current-branch"); // landed in the working tree, not a dedicated branch
  assert.equal(await read(root, "b.txt"), "new file\n");
  assert.equal(await read(root, ".mysteron/board/t.md"), "state: in-progress\n"); // board edit preserved
  assert.equal(await refExists(root, "mysteron/t5"), false);
});

test("landGuestPatch 3-way merges when the host moved on after dispatch", async () => {
  const root = await makeRepo();
  await fs.writeFile(path.join(root, "a.txt"), "l1\nl2\nl3\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "multiline base");
  // Guest patch edits the FIRST line (its hunk context reaches l3).
  await fs.writeFile(path.join(root, "a.txt"), "L1\nl2\nl3\n");
  await git(root, "add", "-A");
  const patch = (await git(root, "diff", "--binary", "--cached")).stdout;
  await git(root, "reset", "-q", "--hard");
  // Host edits the LAST line and commits — that changed context makes a plain
  // apply fail, so --3way must merge the two non-overlapping edits.
  await fs.writeFile(path.join(root, "a.txt"), "l1\nl2\nL3\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "host moved on");

  const res = await landGuestPatch(root, { runId: "r4", ticketId: "t4", patch, message: "m", strategy: "current-branch" });

  assert.equal(res.ok, true);
  assert.equal(res.mode, "current-branch");
  assert.equal(await read(root, "a.txt"), "L1\nl2\nL3\n");
});

test("landGuestPatch reports a no-op when the patch's changes are already present", async () => {
  const root = await makeRepo();
  const patch = await guestPatch(root); // edits a.txt, adds b.txt
  // Host already contains exactly those changes (a resumed run re-emits its diff).
  await fs.writeFile(path.join(root, "a.txt"), "hello world\n");
  await fs.writeFile(path.join(root, "b.txt"), "new file\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "already there");
  const head0 = (await git(root, "rev-parse", "HEAD")).stdout.trim();

  const res = await landGuestPatch(root, { runId: "noop1", ticketId: "tn", patch, message: "Fail on resume", strategy: "current-branch" });

  assert.equal(res.ok, true);
  assert.equal(res.mode, "noop");
  assert.equal((await git(root, "rev-parse", "HEAD")).stdout.trim(), head0); // nothing committed
  assert.equal(await refExists(root, "mysteron/_apply-noop1"), false); // tmp branch cleaned up
});

test("landGuestPatch (target-branch) commits onto the named branch when it's the checkout", async () => {
  const root = await makeRepo();
  const patch = await guestPatch(root);
  const cur = (await git(root, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();

  const res = await landGuestPatch(root, { runId: "tb1", ticketId: "t1", patch, message: "m", strategy: "target-branch", targetBranch: cur });

  assert.equal(res.ok, true);
  assert.equal(res.mode, "current-branch"); // target IS the checkout → lands in the working tree
  assert.equal(await read(root, "b.txt"), "new file\n");
});

test("landGuestPatch (target-branch) lands on a non-checked-out branch and leaves the checkout alone", async () => {
  const root = await makeRepo();
  await git(root, "branch", "develop"); // target exists, but we stay on the default branch
  const patch = await guestPatch(root);
  const head0 = (await git(root, "rev-parse", "HEAD")).stdout.trim();

  const res = await landGuestPatch(root, { runId: "tb2", ticketId: "t2", patch, message: "m", strategy: "target-branch", targetBranch: "develop" });

  assert.equal(res.ok, true);
  assert.equal(res.mode, "branch");
  assert.equal(res.branch, "develop");
  // checkout + working tree untouched...
  assert.equal((await git(root, "rev-parse", "HEAD")).stdout.trim(), head0);
  assert.equal(await read(root, "a.txt"), "hello\n");
  // ...but the work waits on develop, fast-forwarded from the base it was built on.
  assert.equal((await git(root, "show", "develop:b.txt")).stdout, "new file\n");
  assert.equal((await git(root, "rev-list", "--count", `${head0}..develop`)).stdout.trim(), "1");
});

test("landGuestPatch (target-branch) creates the target branch when it doesn't exist", async () => {
  const root = await makeRepo();
  const patch = await guestPatch(root);

  const res = await landGuestPatch(root, { runId: "tb3", ticketId: "t3", patch, message: "m", strategy: "target-branch", targetBranch: "release" });

  assert.equal(res.ok, true);
  assert.equal(res.mode, "branch");
  assert.equal(res.branch, "release");
  assert.equal((await git(root, "show", "release:b.txt")).stdout, "new file\n");
});

test("isGitRepo distinguishes a repo from a plain directory", async () => {
  const root = await makeRepo();
  assert.equal(await isGitRepo(root), true);
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), "mysteron-nogit-"));
  roots.push(plain);
  assert.equal(await isGitRepo(plain), false);
});

test("addRunWorktree + worktreeRunPatch isolate a run and produce a landable patch", async () => {
  const root = await makeRepo();
  const baseRef = await captureSnapshotRef(root, "wrun1");
  const wt = await addRunWorktree(root, baseRef, "wrun1");

  // The agent works in its own checkout, never the shared one.
  await fs.writeFile(path.join(wt.dir, "b.txt"), "from worktree\n"); // new file
  await fs.writeFile(path.join(wt.dir, "a.txt"), "edited in worktree\n"); // tracked edit
  const { patch } = await worktreeRunPatch(wt.dir, wt.baseSha);
  assert.match(patch, /b\.txt/);

  // Landing it on the host mirrors the guest path exactly.
  const res = await landGuestPatch(root, { runId: "wrun1", ticketId: "t1", patch, message: "m", strategy: "current-branch" });
  assert.equal(res.ok, true);
  assert.equal(await read(root, "b.txt"), "from worktree\n");
  assert.equal(await read(root, "a.txt"), "edited in worktree\n");

  await removeRunWorktree(root, wt.dir, wt.branch);
  await releaseSnapshotRef(root, "wrun1");
  assert.equal((await git(root, "worktree", "list")).stdout.includes(wt.dir), false);
  assert.equal((await listBranches(root)).some((b) => b.name === wt.branch), false);
});

test("landGuestPatch always saves the raw patch for recovery", async () => {
  const root = await makeRepo();
  const patch = await guestPatch(root);
  const res = await landGuestPatch(root, { runId: "r6", ticketId: "t6", patch, message: "m", strategy: "current-branch" });
  assert.equal(await fs.readFile(res.patchPath, "utf8"), patch);
});

/** Commit `content` to `file` on a new `branch`, then return to the prior branch. */
async function commitOnBranch(root: string, branch: string, file: string, content: string, msg: string, trailer?: string) {
  await git(root, "checkout", "-q", "-b", branch);
  await fs.writeFile(path.join(root, file), content);
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", trailer ? `${msg}\n\n${trailer}` : msg);
  await git(root, "checkout", "-q", "-");
}

test("listBranches / mergeBranch / deleteBranch round-trip", async () => {
  const root = await makeRepo();
  await commitOnBranch(root, "mysteron/t1", "feature.txt", "feature\n", "Add feature", "Mysteron-Companion: Onyx");

  let branches = await listBranches(root);
  assert.equal(branches.length, 1);
  assert.equal(branches[0].name, "mysteron/t1");
  assert.equal(branches[0].companion, "Onyx");
  assert.equal(branches[0].ahead, 1);
  assert.equal(branches[0].behind, 0);
  assert.equal(branches[0].filesChanged, 1);
  assert.equal(branches[0].merged, false);

  const merged = await mergeBranch(root, "mysteron/t1");
  assert.equal(merged.ok, true);
  assert.equal(await read(root, "feature.txt"), "feature\n"); // landed on the current branch

  assert.equal((await listBranches(root))[0].ahead, 0); // now fully merged
  assert.equal((await listBranches(root))[0].merged, true); // and flagged as such for the UI

  assert.equal((await deleteBranch(root, "mysteron/t1")).ok, true);
  assert.equal((await listBranches(root)).length, 0);
});

test("mergeBranch refuses a dirty working tree", async () => {
  const root = await makeRepo();
  await commitOnBranch(root, "mysteron/t2", "f.txt", "x\n", "m");
  await fs.writeFile(path.join(root, "a.txt"), "dirty\n");
  const res = await mergeBranch(root, "mysteron/t2");
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /uncommitted/);
});

test("mergeBranch auto-commits .mysteron board changes then merges", async () => {
  const root = await makeRepo();
  await fs.mkdir(path.join(root, ".mysteron", "board"), { recursive: true });
  await fs.writeFile(path.join(root, ".mysteron", "board", "t1.md"), "ticket\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "seed board");
  await commitOnBranch(root, "mysteron/t9", "feature.txt", "feature\n", "Add feature");

  // The app left the board dirty: an edited ticket and a brand-new untracked one.
  await fs.writeFile(path.join(root, ".mysteron", "board", "t1.md"), "ticket edited\n");
  await fs.writeFile(path.join(root, ".mysteron", "board", "t2.md"), "new ticket\n");

  const res = await mergeBranch(root, "mysteron/t9");
  assert.equal(res.ok, true);
  assert.equal(res.boardCommitted, true);
  assert.equal((await git(root, "status", "--porcelain")).stdout.trim(), ""); // tree is clean
  assert.equal(await read(root, "feature.txt"), "feature\n"); // branch merged
  assert.equal(await read(root, ".mysteron/board/t2.md"), "new ticket\n"); // new ticket committed
});

test("mergeBranch still refuses when non-board changes are dirty", async () => {
  const root = await makeRepo();
  await fs.mkdir(path.join(root, ".mysteron", "board"), { recursive: true });
  await commitOnBranch(root, "mysteron/t10", "f.txt", "x\n", "m");
  await fs.writeFile(path.join(root, ".mysteron", "board", "t1.md"), "ticket\n"); // board change (ok)
  await fs.writeFile(path.join(root, "a.txt"), "real local edit\n"); // user's own work (not ok)

  const res = await mergeBranch(root, "mysteron/t10");
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /uncommitted/);
  assert.equal(await read(root, "a.txt"), "real local edit\n"); // untouched, nothing committed
});

test("commitBoardChanges leaves a user's staged work alone", async () => {
  const root = await makeRepo();
  await fs.mkdir(path.join(root, ".mysteron", "board"), { recursive: true });
  await fs.writeFile(path.join(root, ".mysteron", "board", "t1.md"), "ticket\n");
  await fs.writeFile(path.join(root, "a.txt"), "staged work\n");
  await git(root, "add", "a.txt"); // user staged their own change

  const res = await commitBoardChanges(root, { trailer: "Mysteron-Companion: Onyx" });
  assert.equal(res.committed, true);
  assert.equal((await git(root, "log", "-1", "--pretty=%b")).stdout.trim(), "Mysteron-Companion: Onyx");
  assert.equal((await git(root, "diff", "--cached", "--name-only")).stdout.trim(), "a.txt"); // still staged
  assert.equal((await git(root, "show", "HEAD:a.txt")).stdout, "hello\n"); // staged change not committed

  assert.equal((await commitBoardChanges(root)).committed, false); // nothing left to commit
});

test("mergeBranch reports conflicts and aborts cleanly", async () => {
  const root = await makeRepo();
  await commitOnBranch(root, "mysteron/t3", "a.txt", "branch change\n", "m");
  await fs.writeFile(path.join(root, "a.txt"), "current change\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "current edit");

  const res = await mergeBranch(root, "mysteron/t3");
  assert.equal(res.ok, false);
  assert.equal(res.conflicted, true);
  assert.equal(await read(root, "a.txt"), "current change\n"); // aborted — tree restored
  assert.equal((await git(root, "status", "--porcelain")).stdout.trim(), "");
});

test("unmergedBranchTicketIds flags tickets whose work isn't in main yet", async () => {
  const root = await makeRepo();
  await commitOnBranch(root, "mysteron/abc12345", "f.txt", "x\n", "Add feature");

  // The ticket with an open branch is flagged; an unrelated id isn't.
  const open = await unmergedBranchTicketIds(root, ["abc12345", "other678"]);
  assert.equal(open.has("abc12345"), true);
  assert.equal(open.has("other678"), false);

  // Once merged, its work is in main, so it no longer counts as unlanded.
  await mergeBranch(root, "mysteron/abc12345");
  assert.equal((await unmergedBranchTicketIds(root, ["abc12345"])).has("abc12345"), false);
});

test("invalid branch names are rejected (no git invocation)", async () => {
  const root = await makeRepo();
  assert.equal((await mergeBranch(root, "--force")).ok, false);
  assert.equal((await deleteBranch(root, "a b")).ok, false);
});

test("captureSnapshotRef captures the full working tree (incl. untracked, excl. ignored)", async () => {
  const root = await makeRepo();
  await fs.writeFile(path.join(root, "a.txt"), "uncommitted edit\n"); // modified tracked file
  await fs.writeFile(path.join(root, "new.txt"), "brand new\n"); // untracked source the host hasn't added yet
  await fs.writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
  await fs.writeFile(path.join(root, "ignored.txt"), "secret\n"); // git-ignored — must NOT leak to the guest

  const sha = await captureSnapshotRef(root, "r5");
  assert.notEqual(sha, "HEAD");
  assert.equal((await git(root, "show", `${sha}:a.txt`)).stdout, "uncommitted edit\n");
  assert.equal((await git(root, "show", `${sha}:new.txt`)).stdout, "brand new\n"); // untracked included
  await assert.rejects(() => git(root, "show", `${sha}:ignored.txt`)); // ignored excluded
  assert.equal(await refExists(root, "refs/mysteron/snap/r5"), true);

  // The host's real index/HEAD are untouched by the snapshot.
  assert.equal((await git(root, "status", "--porcelain")).stdout.includes("new.txt"), true);

  await releaseSnapshotRef(root, "r5");
  assert.equal(await refExists(root, "refs/mysteron/snap/r5"), false);
});

/** Give `root` a bare `origin` remote with its current branch pushed + tracked. */
async function makeOrigin(root: string): Promise<{ bare: string; branch: string }> {
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), "mysteron-origin-"));
  roots.push(bare);
  await git(bare, "init", "--bare", "-q");
  await git(root, "remote", "add", "origin", bare);
  const branch = (await git(root, "symbolic-ref", "--short", "HEAD")).stdout.trim();
  await git(root, "push", "-u", "-q", "origin", branch);
  return { bare, branch };
}

/** Move `origin` on via a throwaway clone: commit `content` to `file` and push. */
async function pushFromClone(bare: string, branch: string, file: string, content: string, msg = "remote work") {
  const clone = await fs.mkdtemp(path.join(os.tmpdir(), "mysteron-clone-"));
  roots.push(clone);
  await git(clone, "clone", "-q", bare, ".");
  await git(clone, "config", "user.name", "Remote");
  await git(clone, "config", "user.email", "remote@local");
  await git(clone, "checkout", "-q", branch);
  await fs.writeFile(path.join(clone, file), content);
  await git(clone, "add", "-A");
  await git(clone, "commit", "-q", "-m", msg);
  await git(clone, "push", "-q", "origin", branch);
}

test("originStatus reports ahead/behind against origin", async () => {
  const root = await makeRepo();
  const { branch } = await makeOrigin(root);

  let s = await originStatus(root);
  assert.equal(s.hasRemote, true);
  assert.equal(s.remote, "origin");
  assert.equal(s.branch, branch);
  assert.equal(s.upstream, `origin/${branch}`);
  assert.equal(s.ahead, 0);
  assert.equal(s.behind, 0);

  await fs.writeFile(path.join(root, "a.txt"), "local\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "local work");
  s = await originStatus(root);
  assert.equal(s.ahead, 1);
  assert.equal(s.behind, 0);
});

test("originStatus({ fetch }) refreshes the behind-count from origin", async () => {
  const root = await makeRepo();
  const { bare, branch } = await makeOrigin(root);
  await pushFromClone(bare, branch, "remote.txt", "remote\n");

  assert.equal((await originStatus(root)).behind, 0); // stale local refs
  const s = await originStatus(root, { fetch: true });
  assert.equal(s.behind, 1);
  assert.equal(s.ahead, 0);
});

test("originStatus on a repo with no remote", async () => {
  const root = await makeRepo();
  const s = await originStatus(root);
  assert.equal(s.hasRemote, false);
  assert.equal(s.upstream, undefined);
  assert.equal(s.ahead, 0);
  assert.equal(s.behind, 0);
});

test("pushCurrentBranch pushes the branch to origin", async () => {
  const root = await makeRepo();
  const { bare, branch } = await makeOrigin(root);
  await fs.writeFile(path.join(root, "a.txt"), "local\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "local work");

  const res = await pushCurrentBranch(root);
  assert.equal(res.ok, true);
  assert.equal(res.rebased, false);
  assert.equal((await git(bare, "log", "-1", "--pretty=%s", branch)).stdout.trim(), "local work");
  assert.equal((await originStatus(root)).ahead, 0);
});

test("pushCurrentBranch rebases onto origin then pushes when rejected", async () => {
  const root = await makeRepo();
  const { bare, branch } = await makeOrigin(root);
  await pushFromClone(bare, branch, "remote.txt", "remote\n", "remote work"); // origin moves on (no conflict)
  await fs.writeFile(path.join(root, "a.txt"), "local\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "local work");

  const res = await pushCurrentBranch(root);
  assert.equal(res.ok, true);
  assert.equal(res.rebased, true);
  const log = (await git(bare, "log", "--pretty=%s", branch)).stdout;
  assert.match(log, /local work/);
  assert.match(log, /remote work/);
  assert.equal(await read(root, "remote.txt"), "remote\n"); // remote work pulled in locally too
});

test("pushCurrentBranch craps out (and aborts) when the rebase conflicts", async () => {
  const root = await makeRepo();
  const { bare, branch } = await makeOrigin(root);
  await pushFromClone(bare, branch, "a.txt", "remote edit\n", "remote edits a"); // same file...
  await fs.writeFile(path.join(root, "a.txt"), "local edit\n"); // ...same line → conflict
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "local edits a");

  const res = await pushCurrentBranch(root);
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /rebase/);
  assert.equal((await git(root, "status", "--porcelain")).stdout.trim(), ""); // failed rebase aborted
  assert.equal(await read(root, "a.txt"), "local edit\n"); // our commit intact
});

test("recentCommits flags Mysteron-authored commits and parses the companion trailer", async () => {
  const root = await makeRepo(); // base commit authored as test@local

  await fs.writeFile(path.join(root, "a.txt"), "companion work\n");
  await git(root, "add", "-A");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-q", "-m", "feat: companion change\n\nMysteron-Companion: Onyx");

  await fs.writeFile(path.join(root, "a.txt"), "mysteron work\n");
  await git(root, "add", "-A");
  await git(root, "-c", "user.name=Mysteron", "-c", "user.email=mysteron@local", "commit", "-q", "-m", "chore: commit board changes");

  const commits = await recentCommits(root);
  const [tip, companion, base] = commits;

  assert.equal(tip.mysteron, true); // mysteron@local author
  assert.equal(tip.companion, undefined);

  assert.equal(companion.companion, "Onyx");
  assert.equal(companion.mysteron, false); // test@local author

  assert.equal(base.mysteron, false);
});

test("lockfileChange detects an uncommitted lockfile edit and its package manager", async () => {
  const root = await makeRepo();
  await fs.writeFile(path.join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "add lockfile");

  // Clean tree: nothing to install for.
  assert.equal(await lockfileChange(root), null);

  // Tracked edit to the lockfile (e.g. the host bumped a dep but hasn't installed).
  await fs.writeFile(path.join(root, "package-lock.json"), '{"lockfileVersion":3,"x":1}\n');
  assert.deepEqual(await lockfileChange(root), { file: "package-lock.json", manager: "npm" });
});

test("lockfileChange spots a brand-new (untracked) lockfile and prefers pnpm", async () => {
  const root = await makeRepo();
  // A change to an ordinary file must not register as a lockfile change.
  await fs.writeFile(path.join(root, "a.txt"), "edited\n");
  assert.equal(await lockfileChange(root), null);

  // pnpm wins over npm when both are present (more specific manager).
  await fs.writeFile(path.join(root, "package-lock.json"), "{}\n");
  await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  assert.deepEqual(await lockfileChange(root), { file: "pnpm-lock.yaml", manager: "pnpm" });
});
