import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";

const exec = promisify(execFile);
const { captureSnapshotRef, releaseSnapshotRef, landGuestPatch, listBranches, mergeBranch, deleteBranch } =
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

  const merged = await mergeBranch(root, "mysteron/t1");
  assert.equal(merged.ok, true);
  assert.equal(await read(root, "feature.txt"), "feature\n"); // landed on the current branch

  assert.equal((await listBranches(root))[0].ahead, 0); // now fully merged

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
