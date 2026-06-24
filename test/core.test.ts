import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// Point Mysteron at throwaway dirs before importing modules that read env at call time.
const tmp = path.join(os.tmpdir(), `mysteron-test-${process.pid}`);
process.env.MYSTERON_HOME = path.join(tmp, "home");
process.env.CLAUDE_PROJECTS_DIR = path.join(tmp, "claude");

const { initProject, loadProjectConfig } = await import("../src/core/project.js");
const { createTicket, listTickets, nextTicket, updateTicket, getTicket, deleteTicket, addAttachment, removeAttachment, readAttachment, binStaleDone } = await import("../src/core/board.js");
const { readDoc, writeDoc } = await import("../src/core/docs.js");
const { loadRegistry } = await import("../src/core/registry.js");
const { usageInWindow } = await import("../src/plugins/usage-monitor/usage.js");
const { RECIPES, findRecipe, gitInstruction } = await import("../src/core/recipes.js");
const { generateCompanion, regenerateCompanion } = await import("../src/core/names.js");

const projectRoot = path.join(tmp, "proj");

before(async () => {
  await fs.mkdir(projectRoot, { recursive: true });
});
after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

test("initProject scaffolds config, docs and registers", async () => {
  const { config, alreadyInitialised } = await initProject(projectRoot, { name: "Demo" });
  assert.equal(alreadyInitialised, false);
  assert.equal(config.name, "Demo");
  assert.equal(config.recipe, "solo");
  assert.equal(config.companions.length, 1);
  assert.equal(config.companions[0].role, "soloist");
  assert.ok(config.companions[0].name.length > 0);
  assert.ok(config.plugins.includes("usage-monitor"));

  const spec = await readDoc(projectRoot, "SPEC.md");
  assert.match(spec ?? "", /# Demo/);
  const etiquette = await readDoc(projectRoot, "ETIQUETTE.md");
  assert.match(etiquette ?? "", /Always commit/);

  const reg = await loadRegistry();
  assert.equal(reg.projects.filter((p) => p.path === projectRoot).length, 1);

  // Idempotent.
  const again = await initProject(projectRoot);
  assert.equal(again.alreadyInitialised, true);
  assert.equal(again.config.id, config.id);
  assert.deepEqual(await loadProjectConfig(projectRoot), config);
});

test("init imports existing project docs (README, SPEC, docs/*)", async () => {
  const root = path.join(tmp, "existing");
  await fs.mkdir(path.join(root, "docs"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules", "junk"), { recursive: true });
  await fs.writeFile(path.join(root, "README.md"), "# Existing app\nhello");
  await fs.writeFile(path.join(root, "SPECIFICATION.md"), "# Real spec\nthe truth");
  await fs.writeFile(path.join(root, "docs", "ARCHITECTURE.md"), "# arch");
  await fs.writeFile(path.join(root, "node_modules", "junk", "README.md"), "ignore me");

  const { importedDocs } = await initProject(root, { name: "Existing" });
  const names = importedDocs.map((d) => d.importName).sort();
  assert.deepEqual(names, ["ARCHITECTURE.md", "README.md", "SPEC.md"]);

  // SPECIFICATION.md should have seeded SPEC.md (not the placeholder).
  assert.match((await readDoc(root, "SPEC.md")) ?? "", /the truth/);
  assert.match((await readDoc(root, "README.md")) ?? "", /Existing app/);
  // node_modules must be ignored.
  assert.ok(!importedDocs.some((d) => d.from.includes("node_modules")));
});

test("init adopts an existing committed .mysteron (cloned-from-elsewhere)", async () => {
  // Simulate a repo cloned from another machine: .mysteron/ is already present.
  const root = path.join(tmp, "cloned");
  await fs.mkdir(path.join(root, ".mysteron", "memory"), { recursive: true });
  const sharedConfig = {
    id: "shared01",
    name: "Cloned App",
    companion: { name: "Gonzo the Bold", avatar: "🦅", recipe: "fullstack" },
    plugins: ["usage-monitor"],
    yolo: true,
    createdAt: "2025-01-01T00:00:00.000Z",
  };
  await fs.writeFile(path.join(root, ".mysteron", "config.json"), JSON.stringify(sharedConfig));
  await fs.writeFile(path.join(root, ".mysteron", "memory", "team-convention.md"), "shared fact");

  const res = await initProject(root, { name: "Ignored Name" });
  assert.equal(res.adopted, true);
  assert.equal(res.alreadyInitialised, true);
  // Companion identity is preserved, not regenerated.
  assert.equal(res.config.id, "shared01");
  // The pre-roster single companion is migrated to a soloist of the same name.
  assert.equal(res.config.companions[0].name, "Gonzo the Bold");
  assert.equal(res.config.companions[0].role, "soloist");
  assert.equal(res.config.recipe, "fullstack");
  assert.equal(res.config.yolo, true);

  // Registry entry reuses the committed id so identity is stable across machines.
  const reg = await loadRegistry();
  const entry = reg.projects.find((p) => p.path === root);
  assert.equal(entry?.id, "shared01");

  // Shared memory travels with the clone.
  const { listMemories } = await import("../src/core/memory.js");
  assert.ok((await listMemories(root)).some((m) => m.name === "team-convention"));
});

test("tickets: create, list (priority sorted), update, next", async () => {
  await createTicket(projectRoot, { title: "low one", priority: "low", state: "ready" });
  const hi = await createTicket(projectRoot, { title: "high one", priority: "high", state: "ready" });

  const ready = await listTickets(projectRoot, { state: "ready" });
  assert.equal(ready[0].id, hi.id, "high priority should sort first");

  const claimed = await nextTicket(projectRoot, { claim: true, assignee: "Kermit" });
  assert.equal(claimed?.id, hi.id);
  assert.equal(claimed?.state, "in-progress");
  assert.equal(claimed?.assignee, "Kermit");

  const moved = await updateTicket(projectRoot, hi.id, { state: "done" });
  assert.equal(moved?.state, "done");
  assert.equal((await listTickets(projectRoot, { state: "done" })).length, 1);
});

test("attachments: stored as bytes + frontmatter, de-duped, cleaned up on delete", async () => {
  const t = await createTicket(projectRoot, { title: "has an image" });
  const png = Buffer.from("89504e470d0a1a0a", "hex");

  const withImg = await addAttachment(projectRoot, t.id, "shot.png", png);
  assert.deepEqual(withImg?.attachments, ["shot.png"]);
  // Persisted to frontmatter (survives a fresh read).
  assert.deepEqual((await getTicket(projectRoot, t.id))?.attachments, ["shot.png"]);
  // Bytes are retrievable.
  assert.deepEqual(await readAttachment(projectRoot, t.id, "shot.png"), png);

  // A duplicate name is kept distinct rather than clobbered.
  const two = await addAttachment(projectRoot, t.id, "shot.png", png);
  assert.equal(two?.attachments?.length, 2);

  const removed = await removeAttachment(projectRoot, t.id, "shot.png");
  assert.ok(!removed?.attachments?.includes("shot.png"));
  assert.equal(await readAttachment(projectRoot, t.id, "shot.png"), undefined);

  // Deleting the ticket removes its attachment dir too.
  await addAttachment(projectRoot, t.id, "again.png", png);
  await deleteTicket(projectRoot, t.id);
  assert.equal(await readAttachment(projectRoot, t.id, "again.png"), undefined);
});

test("binStaleDone sweeps long-done tickets into the bin", async () => {
  const t = await createTicket(projectRoot, { title: "finished a while ago", state: "done" });
  // Nothing is 48h old yet, so the default sweep is a no-op for this ticket.
  await binStaleDone(projectRoot);
  assert.equal((await getTicket(projectRoot, t.id))?.state, "done");
  // A zero-age threshold treats any done ticket as stale → moved to the bin.
  const moved = await binStaleDone(projectRoot, 0);
  assert.ok(moved >= 1);
  assert.equal((await getTicket(projectRoot, t.id))?.state, "bin");
});

test("docs round-trip with path-traversal guard", async () => {
  await writeDoc(projectRoot, "DESIGN", "# design\nbody");
  assert.match((await readDoc(projectRoot, "DESIGN.md")) ?? "", /# design/);
  await assert.rejects(() => writeDoc(projectRoot, "../escape.md", "x"));
});

test("recipes declare git behaviour that drives the agent instructions", () => {
  // Every recipe has a git strategy.
  for (const r of RECIPES) assert.ok(["current-branch", "new-branch"].includes(r.git.strategy), `${r.id} has a git strategy`);

  // Solo (the common default) keeps work on the current branch.
  assert.equal(findRecipe("solo")?.git.strategy, "current-branch");
  assert.match(gitInstruction({ strategy: "current-branch" }), /do NOT create or switch branches/i);

  // new-branch produces branch-cutting instructions using the prefix.
  assert.match(gitInstruction({ strategy: "new-branch", branchPrefix: "spike/" }), /spike\//);
  assert.equal(findRecipe("nope"), undefined);
});

test("companion can be generated and regenerated to a fresh name", () => {
  const c = generateCompanion();
  assert.ok(c.name.includes(" "), "name has an epithet");
  assert.ok(c.avatar.length > 0, "has an avatar");

  // Regenerating never hands back the same name it was given.
  for (let i = 0; i < 50; i++) {
    assert.notEqual(regenerateCompanion(c).name, c.name);
  }
  // With no current companion it still produces a valid one.
  assert.ok(regenerateCompanion().name.includes(" "));
});

test("usage parser sums tokens within the window", async () => {
  const dir = path.join(tmp, "claude", "some-project");
  await fs.mkdir(dir, { recursive: true });
  const recent = new Date().toISOString();
  const old = new Date(Date.now() - 10 * 3600_000).toISOString();
  const lines = [
    JSON.stringify({ timestamp: recent, message: { usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 999 } } }),
    JSON.stringify({ timestamp: old, message: { usage: { input_tokens: 9999, output_tokens: 9999 } } }),
    "not json",
  ].join("\n");
  await fs.writeFile(path.join(dir, "session.jsonl"), lines);

  const w = await usageInWindow(5);
  assert.equal(w.inputTokens, 100);
  assert.equal(w.outputTokens, 50);
  assert.equal(w.billableTokens, 160, "input+output+cacheCreation, excluding the out-of-window entry");
  assert.equal(w.messages, 1);
});
