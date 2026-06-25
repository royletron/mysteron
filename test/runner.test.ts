import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tmp = path.join(os.tmpdir(), `mysteron-runner-${process.pid}`);
process.env.MYSTERON_HOME = path.join(tmp, "home");
// Fake agent: echoes the ticket it was handed (via env) and exits cleanly.
process.env.MYSTERON_AGENT_CMD = 'echo "handling: $MYSTERON_TICKET_TITLE"; echo "oops" 1>&2';

const { initProject } = await import("../src/core/project.js");
const { createTicket, getTicket } = await import("../src/core/board.js");
const { RunManager, renderStreamEvent, runResultStats, resolveCommand, buildPrompt, agentBinary, agentAvailable, agentUnavailableMessage, guestLandMessage } = await import("../src/runner/manager.js");
const { runsDir } = await import("../src/core/paths.js");

const promptConfig = (recipe?: string) =>
  ({
    id: "x",
    name: "P",
    recipe: recipe ?? "solo",
    companions: [{ id: "c1", name: "Bo", role: "soloist", avatarSeed: "Bo" }],
    plugins: [],
    yolo: false,
    createdAt: "",
  }) as any;
const promptTicket = { id: "T1", title: "Do the thing", body: "details", state: "ready", priority: "medium", labels: [], created: "", updated: "" } as any;

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
  assert.equal(claimed?.assignee, config.companions[0].name);

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

  // Tool result — formatting (newlines) is preserved so code stays readable in the log.
  const res = renderStreamEvent({
    type: "user",
    message: { content: [{ type: "tool_result", content: "ok\n done" }] },
  });
  assert.match(res[0].text, /← ok\n done/);

  // Final result with cost.
  const fin = renderStreamEvent({ type: "result", subtype: "success", num_turns: 4, total_cost_usd: 0.1234 });
  assert.match(fin[0].text, /✓ success · 4 turns · \$0\.1234/);

  // Unknown event shape never throws.
  assert.deepEqual(renderStreamEvent({ type: "mystery" }), []);
  assert.deepEqual(renderStreamEvent(null), []);
});

test("resolveCommand maps yolo + allowed/disallowed tools to claude flags", () => {
  const saved = process.env.MYSTERON_AGENT_CMD;
  delete process.env.MYSTERON_AGENT_CMD; // force the default claude path
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
    // The Mysteron MCP is attached and its tools auto-allowed.
    assert.ok(off.args.includes("--mcp-config") && off.args.includes("--strict-mcp-config"));
    assert.ok(off.args.includes("mcp__mysteron"));
    const mcpJson = off.args[off.args.indexOf("--mcp-config") + 1];
    assert.match(mcpJson, /"mcpServers".*"mysteron".*"\/tmp\/proj"/);

    const on = resolveCommand({ ...base, yolo: true } as any, "/tmp/proj", "PROMPT");
    assert.ok(on.args.includes("bypassPermissions"));

    // A companion pins a stable session id for conversation continuity.
    const comp = { id: "11111111-1111-1111-1111-111111111111", name: "Bo", role: "soloist", avatarSeed: "Bo" };
    // First run creates the session…
    const first = resolveCommand({ ...base, yolo: false } as any, "/tmp/proj", "PROMPT", comp as any, false);
    assert.ok(first.args.includes("--session-id") && first.args.includes(comp.id));
    // …subsequent runs resume it (or Claude errors "session already in use").
    const next = resolveCommand({ ...base, yolo: false } as any, "/tmp/proj", "PROMPT", comp as any, true);
    assert.ok(next.args.includes("--resume") && next.args.includes(comp.id));
    assert.ok(!next.args.includes("--session-id"));
  } finally {
    if (saved !== undefined) process.env.MYSTERON_AGENT_CMD = saved;
  }
});

test("buildPrompt embeds the recipe's git behaviour and team", () => {
  // Default (no recipe) → solo → discrete commits on the current branch, no team section.
  const solo = buildPrompt(promptConfig(), promptTicket, "the spec", "always commit");
  assert.match(solo, /# Git/);
  assert.match(solo, /do NOT create or switch branches/i);
  assert.ok(!solo.includes("# Team"), "solo has no team section");

  // A multi-role recipe lists its roles for delegation.
  const team = buildPrompt(promptConfig("fullstack"), promptTicket, "", "");
  assert.match(team, /# Team \(Full-stack team\)/);
  assert.match(team, /- \*\*designer\*\*/);
  assert.match(team, /do NOT create or switch branches/i, "fullstack still works on the current branch");

  // The research recipe opts into a throwaway branch instead.
  const research = buildPrompt(promptConfig("research"), promptTicket, "", "");
  assert.match(research, /Create a dedicated git branch/);
  assert.match(research, /spike\//);

  // An unknown recipe id falls back to solo rather than throwing.
  assert.match(buildPrompt(promptConfig("bogus"), promptTicket, "", ""), /do NOT create or switch branches/i);

  // Attached images are listed (by in-repo path) so the agent reads them first.
  const withImg = { ...promptTicket, attachments: ["bug.png"] };
  const imgPrompt = buildPrompt(promptConfig(), withImg, "", "");
  assert.match(imgPrompt, /# Attached images/);
  assert.match(imgPrompt, /\.mysteron\/board\/attachments\/T1\/bug\.png/);
  assert.ok(!buildPrompt(promptConfig(), promptTicket, "", "").includes("# Attached images"));
});

test("agentAvailable reports whether a ticket can actually be run locally", () => {
  const saved = process.env.MYSTERON_AGENT_CMD;
  const savedPath = process.env.PATH;
  try {
    // A shell command (MYSTERON_AGENT_CMD) can't be introspected → assumed available.
    process.env.MYSTERON_AGENT_CMD = 'echo "hi"';
    assert.equal(agentBinary(promptConfig()), null);
    assert.equal(agentAvailable(promptConfig()), true);

    delete process.env.MYSTERON_AGENT_CMD;
    // Default agent is the `claude` binary…
    assert.equal(agentBinary(promptConfig()), "claude");
    // …which is not found on an empty PATH, so nothing is available to run.
    process.env.PATH = "";
    assert.equal(agentAvailable(promptConfig()), false);
    assert.match(agentUnavailableMessage(promptConfig()), /claude/i);

    // A configured agent command is checked by name, and named in its message.
    const missing = { ...promptConfig(), agent: { command: "definitely-not-a-real-binary-xyz" } } as any;
    assert.equal(agentBinary(missing), "definitely-not-a-real-binary-xyz");
    assert.equal(agentAvailable(missing), false);
    assert.match(agentUnavailableMessage(missing), /definitely-not-a-real-binary-xyz/);

    // An explicit path that exists (node itself) is available regardless of PATH.
    const byPath = { ...promptConfig(), agent: { command: process.execPath } } as any;
    assert.equal(agentAvailable(byPath), true);
  } finally {
    if (saved !== undefined) process.env.MYSTERON_AGENT_CMD = saved;
    else delete process.env.MYSTERON_AGENT_CMD;
    if (savedPath !== undefined) process.env.PATH = savedPath;
  }
});

test("runResultStats reads cost + turns from a result event", () => {
  assert.deepEqual(runResultStats({ type: "result", total_cost_usd: 0.1234, num_turns: 5 }), {
    costUsd: 0.1234,
    numTurns: 5,
  });
  // Non-result events carry no stats.
  assert.deepEqual(runResultStats({ type: "assistant" }), {});
  // A result event missing the numbers yields undefineds, not NaN/0.
  assert.deepEqual(runResultStats({ type: "result" }), { costUsd: undefined, numTurns: undefined });
});

test("a second run for the same active ticket returns the existing run", async () => {
  process.env.MYSTERON_AGENT_CMD = "sleep 1";
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

test("a companion runs one ticket at a time (busy lock)", async () => {
  process.env.MYSTERON_AGENT_CMD = "sleep 1";
  const proj = path.join(tmp, "lock");
  const { config } = await initProject(proj, { name: "Lock" }); // solo → one soloist
  const a = await createTicket(proj, { title: "A", state: "ready" });
  const b = await createTicket(proj, { title: "B", state: "ready" });
  const rm = new RunManager();
  const runA = await rm.start({ projectId: config.id, projectRoot: proj, config, ticket: a });
  assert.equal(runA.companionId, config.companions[0].id, "run carries the companion id");
  // The soloist is busy with A, so starting B (a different ticket) is refused.
  await assert.rejects(
    () => rm.start({ projectId: config.id, projectRoot: proj, config, ticket: b }),
    /busy/i,
  );
  assert.deepEqual(rm.busyCompanionIds(config.id), [config.companions[0].id]);
  // A prior run on this machine means the companion's session exists → resume next time.
  assert.equal(rm.companionHasLocalSession(config.companions[0].id), true);
  assert.equal(rm.companionHasLocalSession("never-ran"), false);
  rm.stop(runA.id);
  await waitFor(() => rm.get(runA.id)?.status !== "running");
});

test("a finished run is persisted to disk and survives a restart", async () => {
  process.env.MYSTERON_AGENT_CMD = 'echo "did the work"';
  const proj = path.join(tmp, "persist");
  const { config } = await initProject(proj, { name: "Persist" });
  const ticket = await createTicket(proj, { title: "Keep history", state: "ready" });

  const rm = new RunManager();
  const run = await rm.start({ projectId: config.id, projectRoot: proj, config, ticket });
  await waitFor(() => rm.get(run.id)?.status !== "running");

  // Metadata (committed) is written without the verbose output…
  const meta = JSON.parse(await fs.readFile(path.join(runsDir(proj), `${run.id}.json`), "utf8"));
  assert.equal(meta.status, "done");
  assert.equal(meta.ticketId, ticket.id);
  assert.ok(meta.hostname, "metadata records the hostname");
  assert.equal(meta.lines, undefined, "metadata is committed without output");
  // …and the output lives in a separate, gitignored log file.
  const log = await fs.readFile(path.join(runsDir(proj), `${run.id}.log`), "utf8");
  assert.ok(log.includes("did the work"));

  // A fresh manager (simulating a server restart) loads the history back, with logs.
  const fresh = new RunManager();
  const loaded = await fresh.hydrate([{ projectId: config.id, projectRoot: proj }]);
  assert.equal(loaded, 1);
  const restored = fresh.get(run.id);
  assert.equal(restored?.status, "done");
  assert.equal(restored?.logAvailable, true);
  assert.ok(restored?.lines.some((l) => l.text.includes("did the work")));
  assert.equal(fresh.listByProject(config.id)[0]?.id, run.id);
});

test("guestLandMessage keeps the agent's own commit message (with emoji/conventional style)", () => {
  const agentMsg = "feat: add cloud companions ✨\n\nWire it all up.\n\nMysteron-Companion: Waldorf the Compiler";
  const { message, trailer } = guestLandMessage(agentMsg, "Cloud Companions", "Waldorf the Compiler");
  assert.equal(message, agentMsg);
  // The agent already wrote the attribution trailer — don't duplicate it.
  assert.equal(trailer, undefined);
});

test("guestLandMessage appends the trailer when the agent omitted it", () => {
  const { message, trailer } = guestLandMessage("fix: tidy up 🐛", "Cloud Companions", "Waldorf the Compiler");
  assert.equal(message, "fix: tidy up 🐛");
  assert.equal(trailer, "Mysteron-Companion: Waldorf the Compiler");
});

test("guestLandMessage falls back to the ticket title when the agent committed nothing", () => {
  for (const empty of [undefined, "", "   "]) {
    const { message, trailer } = guestLandMessage(empty, "Cloud Companions", "Waldorf the Compiler");
    assert.equal(message, "Cloud Companions");
    assert.equal(trailer, "Mysteron-Companion: Waldorf the Compiler");
  }
});

test("hydrate marks runs orphaned by a crashed process as stopped", async () => {
  const proj = path.join(tmp, "orphan");
  await fs.mkdir(runsDir(proj), { recursive: true });
  const orphan = {
    id: "orphan123",
    ticketId: "t1",
    ticketTitle: "Interrupted",
    companion: "Test",
    hostname: os.hostname(), // ran on THIS machine, so it's genuinely orphaned
    status: "running",
    command: "claude",
    startedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(runsDir(proj), "orphan123.json"), JSON.stringify(orphan), "utf8");

  const rm = new RunManager();
  await rm.hydrate([{ projectId: "p1", projectRoot: proj }]);
  const run = rm.get("orphan123");
  assert.equal(run?.status, "stopped");
  assert.ok(run?.endedAt);
  assert.ok(run?.lines.some((l) => l.text.includes("interrupted by a server restart")));
});
