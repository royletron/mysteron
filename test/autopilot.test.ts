import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tmp = path.join(os.tmpdir(), `mysteron-autopilot-${process.pid}`);
process.env.MYSTERON_HOME = path.join(tmp, "home");
// Empty Claude dir → zero usage → budget always safe for the test.
process.env.CLAUDE_PROJECTS_DIR = path.join(tmp, "no-claude");
process.env.MYSTERON_AGENT_CMD = "true"; // instant, exit 0
process.env.MYSTERON_AUTOPILOT_IDLE_MS = "300";
process.env.MYSTERON_AUTOPILOT_BUDGET_MS = "300";
process.env.MYSTERON_AUTOPILOT_BREATHER_MS = "50";

const { initProject, loadProjectConfig, saveProjectConfig } = await import("../src/core/project.js");
const { createTicket, listTickets } = await import("../src/core/board.js");
const { RunManager } = await import("../src/runner/manager.js");
const { Autopilot } = await import("../src/runner/autopilot.js");
const { WorkerRegistry } = await import("../src/server/workers.js");

const projectRoot = path.join(tmp, "proj");

before(async () => {
  await fs.mkdir(projectRoot, { recursive: true });
});
after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timeout"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

test("autopilot drains ready tickets one at a time", async () => {
  const { config } = await initProject(projectRoot, { name: "Auto" });
  await createTicket(projectRoot, { title: "Ticket one", state: "ready" });
  await createTicket(projectRoot, { title: "Ticket two", state: "ready" });

  const ap = new Autopilot(new RunManager(), new WorkerRegistry());
  ap.start(config.id, projectRoot, config);

  // It should process both ready tickets, then go idle.
  await waitFor(() => (ap.status(config.id)?.completed ?? 0) >= 2);
  await waitFor(() => ap.status(config.id)?.status === "idle");

  assert.equal(ap.stop(config.id), true);
  assert.equal(ap.status(config.id)?.status, "stopped");

  // No tickets left in "ready"; both were claimed/run.
  assert.equal((await listTickets(projectRoot, { state: "ready" })).length, 0);
  assert.ok((ap.status(config.id)?.completed ?? 0) >= 2);
});

test("autopilot never runs a guest-pinned companion on the local host", async () => {
  const root = path.join(tmp, "guest-pinned");
  await fs.mkdir(root, { recursive: true });
  const { config } = await initProject(root, { name: "Pinned" });

  // Pin the soloist to a guest that isn't connected, so it can't run locally.
  config.companions[0].runsOn = ["a-guest-that-is-offline"];
  await saveProjectConfig(root, config);

  const reloaded = (await loadProjectConfig(root))!;
  const ticket = await createTicket(root, {
    title: "Guest-only work",
    state: "ready",
    companionId: reloaded.companions[0].id,
  });

  const ap = new Autopilot(new RunManager(), new WorkerRegistry());
  ap.start(config.id, root);

  // Let several ticks pass; with no connected guest the ticket can run nowhere.
  await waitFor(() => ap.status(config.id)?.status === "idle");
  await new Promise((r) => setTimeout(r, 400));

  ap.stop(config.id);
  assert.equal(ap.status(config.id)?.completed ?? 0, 0, "nothing ran locally");
  const still = await listTickets(root, { state: "ready" });
  assert.equal(still.length, 1, "the ticket stays ready, waiting for its guest");
  assert.equal(still[0].id, ticket.id);
});
