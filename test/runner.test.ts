import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tmp = path.join(os.tmpdir(), `henson-runner-${process.pid}`);
process.env.HENSON_HOME = path.join(tmp, "home");
// Fake agent: echoes the ticket it was handed (via env) and exits cleanly.
process.env.HENSON_AGENT_CMD = 'echo "handling: $HENSON_TICKET_TITLE"; echo "oops" 1>&2';

const { initProject } = await import("../src/core/project.js");
const { createTicket, getTicket } = await import("../src/core/board.js");
const { RunManager, renderStreamEvent, resolveCommand } = await import("../src/runner/manager.js");
const { runsDir } = await import("../src/core/paths.js");

const projectRoot = path.join(tmp, "proj");

before(async () => {
  await fs.mkdir(projectRoot, { recursive: true });
});
after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timeout"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

test("RunManager runs an agent, claims the ticket and captures output", async () => {
  const { config } = await initProject(projectRoot, { name: "Runner" });
  const ticket = await createTicket(projectRoot, { title: "Wire the widget", state: "ready" });

  const rm = new RunManager();
  const run = await rm.start({ projectId: config.id, projectRoot, config, ticket });

  // Ticket is claimed immediately for the companion.
  const claimed = await getTicket(projectRoot, ticket.id);
  assert.equal(claimed?.state, "in-progress");
  assert.equal(claimed?.assignee, config.companion.name);

  await waitFor(() => rm.get(run.id)?.status !== "running");
  const finished = rm.get(run.id)!;
  assert.equal(finished.status, "done");
  assert.equal(finished.exitCode, 0);

  const stdout = finished.lines.filter((l) => l.stream === "stdout").map((l) => l.text);
  const stderr = finished.lines.filter((l) => l.stream === "stderr").map((l) => l.text);
  assert.ok(stdout.includes("handling: Wire the widget"), "agent received the ticket via env");
  assert.ok(stderr.includes("oops"), "stderr is captured separately");
});

test("renderStreamEvent turns Claude stream-json into readable lines", () => {
  // Session init.
  assert.match(
    renderStreamEvent({ type: "system", subtype: "init", model: "claude-x", tools: [1, 2, 3] })[0].text,
    /session started · model claude-x · 3 tools/,
  );

  // Assistant text + a tool call.
  const asst = renderStreamEvent({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Making the container full width." },
        { type: "tool_use", name: "Edit", input: { file_path: "web/src/App.tsx" } },
      ],
    },
  });
  assert.equal(asst[0].stream, "stdout");
  assert.equal(asst[0].text, "Making the container full width.");
  assert.equal(asst[1].stream, "system");
  assert.match(asst[1].text, /→ Edit web\/src\/App\.tsx/);

  // Tool result.
  const res = renderStreamEvent({
    type: "user",
    message: { content: [{ type: "tool_result", content: "ok\n done" }] },
  });
  assert.match(res[0].text, /← ok done/);

  // Final result with cost.
  const fin = renderStreamEvent({ type: "result", subtype: "success", num_turns: 4, total_cost_usd: 0.1234 });
  assert.match(fin[0].text, /✓ success · 4 turns · \$0\.1234/);

  // Unknown event shape never throws.
  assert.deepEqual(renderStreamEvent({ type: "mystery" }), []);
  assert.deepEqual(renderStreamEvent(null), []);
});

test("resolveCommand maps yolo + allowed/disallowed tools to claude flags", () => {
  const saved = process.env.HENSON_AGENT_CMD;
  delete process.env.HENSON_AGENT_CMD; // force the default claude path
  try {
    const base = { id: "x", name: "P", companion: { name: "n", avatar: "x" }, plugins: [], createdAt: "" };
    const off = resolveCommand(
      { ...base, yolo: false, allowedTools: ["Edit", "Bash(npm test:*)"], disallowedTools: ["Bash(rm *)"] } as any,
      "/tmp/proj",
      "PROMPT",
    );
    assert.equal(off.cmd, "claude");
    assert.ok(off.args.includes("acceptEdits"));
    assert.ok(off.args.join(" ").includes("--allowedTools Edit Bash(npm test:*)"));
    assert.ok(off.args.includes("--disallowedTools") && off.args.includes("Bash(rm *)"));
    // The Henson MCP is attached and its tools auto-allowed.
    assert.ok(off.args.includes("--mcp-config") && off.args.includes("--strict-mcp-config"));
    assert.ok(off.args.includes("mcp__henson"));
    const mcpJson = off.args[off.args.indexOf("--mcp-config") + 1];
    assert.match(mcpJson, /"mcpServers".*"henson".*"\/tmp\/proj"/);

    const on = resolveCommand({ ...base, yolo: true } as any, "/tmp/proj", "PROMPT");
    assert.ok(on.args.includes("bypassPermissions"));
  } finally {
    if (saved !== undefined) process.env.HENSON_AGENT_CMD = saved;
  }
});

test("a second run for the same active ticket returns the existing run", async () => {
  process.env.HENSON_AGENT_CMD = "sleep 1";
  const { config } = await initProject(projectRoot);
  const ticket = await createTicket(projectRoot, { title: "Long task", state: "ready" });
  const rm = new RunManager();
  const a = await rm.start({ projectId: config.id, projectRoot, config, ticket });
  const b = await rm.start({ projectId: config.id, projectRoot, config, ticket });
  assert.equal(a.id, b.id, "should not start a duplicate run while one is active");
  rm.stop(a.id);
  await waitFor(() => rm.get(a.id)?.status !== "running");
  assert.equal(rm.get(a.id)?.status, "stopped");
});

test("a finished run is persisted to disk and survives a restart", async () => {
  process.env.HENSON_AGENT_CMD = 'echo "did the work"';
  const proj = path.join(tmp, "persist");
  const { config } = await initProject(proj, { name: "Persist" });
  const ticket = await createTicket(proj, { title: "Keep history", state: "ready" });

  const rm = new RunManager();
  const run = await rm.start({ projectId: config.id, projectRoot: proj, config, ticket });
  await waitFor(() => rm.get(run.id)?.status !== "running");

  // It was written to .henson/runs/<id>.json with its captured output.
  const file = path.join(runsDir(proj), `${run.id}.json`);
  const onDisk = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(onDisk.status, "done");
  assert.equal(onDisk.ticketId, ticket.id);
  assert.ok(onDisk.lines.some((l: { text: string }) => l.text.includes("did the work")));

  // A fresh manager (simulating a server restart) loads the history back.
  const fresh = new RunManager();
  const loaded = await fresh.hydrate([proj]);
  assert.equal(loaded, 1);
  const restored = fresh.get(run.id);
  assert.equal(restored?.status, "done");
  assert.equal(fresh.listByProject(config.id)[0]?.id, run.id);
});

test("hydrate marks runs orphaned by a crashed process as stopped", async () => {
  const proj = path.join(tmp, "orphan");
  await fs.mkdir(runsDir(proj), { recursive: true });
  const orphan = {
    id: "orphan123",
    projectId: "p1",
    projectRoot: proj,
    ticketId: "t1",
    ticketTitle: "Interrupted",
    companion: "Test",
    status: "running",
    command: "claude",
    startedAt: new Date().toISOString(),
    lines: [{ stream: "system", text: "▶ started", at: new Date().toISOString() }],
  };
  await fs.writeFile(path.join(runsDir(proj), "orphan123.json"), JSON.stringify(orphan), "utf8");

  const rm = new RunManager();
  await rm.hydrate([proj]);
  const run = rm.get("orphan123");
  assert.equal(run?.status, "stopped");
  assert.ok(run?.endedAt);
  assert.ok(run?.lines.some((l) => l.text.includes("interrupted by a server restart")));
});
