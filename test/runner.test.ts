import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";

const exec = promisify(execFile);

const tmp = path.join(os.tmpdir(), `mysteron-runner-${process.pid}`);
process.env.MYSTERON_HOME = path.join(tmp, "home");
// Fake agent: echoes the ticket it was handed (via env) and exits cleanly.
process.env.MYSTERON_AGENT_CMD = 'echo "handling: $MYSTERON_TICKET_TITLE"; echo "oops" 1>&2';

const { initProject } = await import("../src/core/project.js");
const { createTicket, getTicket } = await import("../src/core/board.js");
const { RunManager, renderStreamEvent, runResultStats, resolveCommand, buildPrompt, agentBinary, agentAvailable, agentUnavailableMessage, guestLandMessage } = await import("../src/runner/manager.js");
const { runsDir } = await import("../src/core/paths.js");
const { resolveProjectGit } = await import("../src/core/recipes.js");

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

test("resolveProjectGit maps the project commit strategy, overriding the recipe default", () => {
  // No explicit strategy → recipe default.
  assert.deepEqual(resolveProjectGit({ recipe: "solo" }), { strategy: "current-branch", branchPrefix: undefined });
  assert.deepEqual(resolveProjectGit({ recipe: "research" }), { strategy: "new-branch", branchPrefix: "spike/" });

  // The three explicit options, applied to local + guest alike.
  assert.deepEqual(resolveProjectGit({ recipe: "solo", commit: { mode: "main" } }), {
    strategy: "target-branch",
    targetBranch: "main",
  });
  assert.deepEqual(resolveProjectGit({ recipe: "solo", commit: { mode: "branch", branch: "develop" } }), {
    strategy: "target-branch",
    targetBranch: "develop",
  });
  // An explicit strategy wins even over a new-branch recipe.
  assert.deepEqual(resolveProjectGit({ recipe: "research", commit: { mode: "per-ticket" } }), {
    strategy: "new-branch",
    branchPrefix: "mysteron/",
  });
});

test("a local run is isolated in a worktree and its changes land on the current branch", async () => {
  const proj = path.join(tmp, "isolated");
  const { config } = await initProject(proj, { name: "Isolated" });
  // Make it a real git repo so the run is isolated in a per-run worktree.
  await exec("git", ["-C", proj, "init", "-q"]);
  await exec("git", ["-C", proj, "config", "user.name", "Test"]);
  await exec("git", ["-C", proj, "config", "user.email", "test@local"]);
  await fs.writeFile(path.join(proj, "seed.txt"), "seed\n");
  await exec("git", ["-C", proj, "add", "-A"]);
  await exec("git", ["-C", proj, "commit", "-q", "-m", "base"]);

  const ticket = await createTicket(proj, { title: "Make a file", state: "ready" });

  const saved = process.env.MYSTERON_AGENT_CMD;
  // The agent writes a file into its cwd — which must be the isolated worktree.
  process.env.MYSTERON_AGENT_CMD = 'echo "isolated work" > made-by-agent.txt';
  try {
    const rm = new RunManager();
    const run = await rm.start({ projectId: config.id, projectRoot: proj, config, ticket });
    await waitFor(() => rm.get(run.id)?.status !== "running", 15000);
    assert.equal(rm.get(run.id)?.status, "done");

    // The agent's change landed in the REAL project, via the strategy-aware path.
    assert.equal(await fs.readFile(path.join(proj, "made-by-agent.txt"), "utf8"), "isolated work\n");
    // ...and the ticket was moved to review on success.
    assert.equal((await getTicket(proj, ticket.id))?.state, "review");
    // The per-run worktree is torn down (no orphaned checkout left behind).
    let cleaned = false;
    for (let i = 0; i < 100 && !cleaned; i++) {
      cleaned = !(await exec("git", ["-C", proj, "worktree", "list"])).stdout.includes("mysteron-run-");
      if (!cleaned) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(cleaned, "the per-run worktree was cleaned up");
  } finally {
    if (saved !== undefined) process.env.MYSTERON_AGENT_CMD = saved;
    else delete process.env.MYSTERON_AGENT_CMD;
  }
});

test("an isolated run with an unchanged lockfile symlinks the host's node_modules", async () => {
  const proj = path.join(tmp, "nm-link");
  const { config } = await initProject(proj, { name: "NmLink" });
  await exec("git", ["-C", proj, "init", "-q"]);
  await exec("git", ["-C", proj, "config", "user.name", "Test"]);
  await exec("git", ["-C", proj, "config", "user.email", "test@local"]);
  await fs.writeFile(path.join(proj, ".gitignore"), "node_modules\n");
  await fs.writeFile(path.join(proj, "package.json"), '{"name":"nm-link","version":"1.0.0"}\n');
  await fs.writeFile(path.join(proj, "package-lock.json"), '{"lockfileVersion":3}\n');
  await exec("git", ["-C", proj, "add", "-A"]);
  await exec("git", ["-C", proj, "commit", "-q", "-m", "base"]);
  // Host has an installed tree the worktree can share.
  await fs.mkdir(path.join(proj, "node_modules"), { recursive: true });
  await fs.writeFile(path.join(proj, "node_modules", ".host-marker"), "host\n");

  const ticket = await createTicket(proj, { title: "Touch deps", state: "ready" });
  const saved = process.env.MYSTERON_AGENT_CMD;
  // The agent records whether its cwd's node_modules is a symlink (the host's).
  process.env.MYSTERON_AGENT_CMD = 'if [ -L node_modules ]; then echo LINKED > nm-kind.txt; else echo OWN > nm-kind.txt; fi';
  try {
    const rm = new RunManager();
    const run = await rm.start({ projectId: config.id, projectRoot: proj, config, ticket });
    await waitFor(() => rm.get(run.id)?.status !== "running", 15000);
    assert.equal(rm.get(run.id)?.status, "done");
    assert.equal((await fs.readFile(path.join(proj, "nm-kind.txt"), "utf8")).trim(), "LINKED");
  } finally {
    if (saved !== undefined) process.env.MYSTERON_AGENT_CMD = saved;
    else delete process.env.MYSTERON_AGENT_CMD;
  }
});

test("an isolated run with a changed lockfile installs into its own node_modules", async () => {
  const proj = path.join(tmp, "nm-install");
  const { config } = await initProject(proj, { name: "NmInstall" });
  await exec("git", ["-C", proj, "init", "-q"]);
  await exec("git", ["-C", proj, "config", "user.name", "Test"]);
  await exec("git", ["-C", proj, "config", "user.email", "test@local"]);
  await fs.writeFile(path.join(proj, ".gitignore"), "node_modules\n");
  await fs.writeFile(path.join(proj, "package.json"), '{"name":"nm-install","version":"1.0.0"}\n');
  await fs.writeFile(path.join(proj, "package-lock.json"), '{"lockfileVersion":3}\n');
  await exec("git", ["-C", proj, "add", "-A"]);
  await exec("git", ["-C", proj, "commit", "-q", "-m", "base"]);
  // Host has an installed tree, but the snapshot's lockfile has moved on — a
  // symlink would be stale, so the run must install into its own node_modules.
  await fs.mkdir(path.join(proj, "node_modules"), { recursive: true });
  await fs.writeFile(path.join(proj, "node_modules", ".host-marker"), "host\n");
  await fs.writeFile(path.join(proj, "package-lock.json"), '{"lockfileVersion":3,"bumped":true}\n');

  // Stub the package manager so the install is hermetic (no registry, no network):
  // a fake `npm` on PATH just materialises a real node_modules in its cwd.
  const fakeBin = path.join(proj, ".fakebin");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(path.join(fakeBin, "npm"), "#!/bin/sh\nmkdir -p node_modules\necho fake > node_modules/.installed\n", { mode: 0o755 });
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${savedPath ?? ""}`;

  const ticket = await createTicket(proj, { title: "Bump deps", state: "ready" });
  const saved = process.env.MYSTERON_AGENT_CMD;
  process.env.MYSTERON_AGENT_CMD = "true";
  try {
    const rm = new RunManager();
    const run = await rm.start({ projectId: config.id, projectRoot: proj, config, ticket });
    await waitFor(() => rm.get(run.id)?.status !== "running", 15000);
    assert.equal(rm.get(run.id)?.status, "done");
    const sys = rm.get(run.id)!.lines.filter((l) => l.stream === "system").map((l) => l.text);
    // It chose the install path up front (not the symlink) and the install stuck.
    assert.ok(sys.some((t) => t.includes("installing deps in the isolated tree (npm)")), "install branch was taken");
    assert.ok(!sys.some((t) => t.includes("isolated install failed")), "install did not fall back to the host symlink");
  } finally {
    process.env.PATH = savedPath;
    if (saved !== undefined) process.env.MYSTERON_AGENT_CMD = saved;
    else delete process.env.MYSTERON_AGENT_CMD;
  }
});

test("a run that finished is left in place even if its output mentioned a limit", async () => {
  // Ticket q18zz3xH: a finished ticket was bouncing back to Ready (and printing a
  // second 'limit reached' summary) because limit detection tripped on the agent's
  // output mentioning a limit — even when the run completed successfully.
  const proj = path.join(tmp, "limit-done");
  const { config } = await initProject(proj, { name: "LimitDone" });
  const ticket = await createTicket(proj, { title: "Mentions a limit", state: "ready" });

  const saved = process.env.MYSTERON_AGENT_CMD;
  process.env.MYSTERON_AGENT_CMD = 'echo "note: usage limit reached earlier, but I finished"';
  try {
    const rm = new RunManager();
    const run = await rm.start({ projectId: config.id, projectRoot: proj, config, ticket });
    await waitFor(() => rm.get(run.id)?.status !== "running");
    assert.equal(rm.get(run.id)?.status, "done");

    // The run finished, so the ticket is NOT bounced back to Ready…
    assert.notEqual((await getTicket(proj, ticket.id))?.state, "ready");
    // …and no spurious 'moving the ticket back to Ready' summary was appended.
    assert.ok(
      !rm.get(run.id)!.lines.some((l) => /moving the ticket back to Ready/.test(l.text)),
      "no second, contradictory limit summary on a finished run",
    );
  } finally {
    if (saved !== undefined) process.env.MYSTERON_AGENT_CMD = saved;
    else delete process.env.MYSTERON_AGENT_CMD;
  }
});

test("limit detection ignores tool-result echoes (reading a ticket that mentions a limit)", async () => {
  // The agent reading this very ticket — whose body says 'usage limit reached' —
  // must not trip the limit flag. Such text arrives as a 'system' tool-result line.
  const proj = path.join(tmp, "limit-echo");
  const { config } = await initProject(proj, { name: "LimitEcho" });
  const ticket = await createTicket(proj, { title: "Reads a limit", state: "ready" });

  const savedCmd = process.env.MYSTERON_AGENT_CMD;
  const savedFmt = process.env.MYSTERON_AGENT_FORMAT;
  // Emit a Claude stream-json tool_result event echoing limit wording → rendered
  // as a 'system' line, which must be excluded from limit detection.
  process.env.MYSTERON_AGENT_FORMAT = "claude-stream-json";
  process.env.MYSTERON_AGENT_CMD =
    `echo '{"type":"user","message":{"content":[{"type":"tool_result","content":"ticket body: usage limit reached"}]}}'`;
  try {
    const rm = new RunManager();
    const run = await rm.start({ projectId: config.id, projectRoot: proj, config, ticket });
    await waitFor(() => rm.get(run.id)?.status !== "running");
    assert.equal(rm.get(run.id)?.status, "done");
    assert.ok(!rm.get(run.id)!.limitHit, "a tool-result echo must not set limitHit");
    assert.notEqual((await getTicket(proj, ticket.id))?.state, "ready");
  } finally {
    if (savedCmd !== undefined) process.env.MYSTERON_AGENT_CMD = savedCmd;
    else delete process.env.MYSTERON_AGENT_CMD;
    if (savedFmt !== undefined) process.env.MYSTERON_AGENT_FORMAT = savedFmt;
    else delete process.env.MYSTERON_AGENT_FORMAT;
  }
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

test("renderStreamEvent strips the project root from logged paths", () => {
  const root = "/home/me/projects/widget";

  // Tool call arg: the absolute project path is reduced to a repo-relative one.
  const call = renderStreamEvent(
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: { file_path: `${root}/src/file.ts` } }] },
    },
    root,
  );
  assert.equal(call[0].text, "→ Read /src/file.ts");

  // Tool result: paths in the output are stripped too.
  const result = renderStreamEvent(
    {
      type: "user",
      message: { content: [{ type: "tool_result", content: `edited ${root}/src/file.ts` }] },
    },
    root,
  );
  assert.match(result[0].text, /← edited \/src\/file\.ts/);

  // No project root supplied → text is left untouched.
  const untouched = renderStreamEvent(
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: { file_path: `${root}/src/file.ts` } }] },
    },
  );
  assert.equal(untouched[0].text, `→ Read ${root}/src/file.ts`);
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
    // After a session error, no session flags at all (fresh start, no continuity).
    const noSess = resolveCommand({ ...base, yolo: false } as any, "/tmp/proj", "PROMPT", comp as any, false, true);
    assert.ok(!noSess.args.includes("--session-id") && !noSess.args.includes("--resume") && !noSess.args.includes(comp.id));
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

test("buildPrompt emits a short resume prompt that skips spec/etiquette/team/brief", () => {
  const companion = { id: "c1", name: "Bo", role: "soloist", avatarSeed: "Bo" };
  const brief = "# Commits\n\nBe fun";

  const resumed = buildPrompt(promptConfig("fullstack"), promptTicket, "the spec", "always commit", companion as any, brief, true);
  // Ticket details are still present.
  assert.match(resumed, /# Ticket T1/);
  assert.match(resumed, /# Git/);
  assert.match(resumed, /continuing as Bo/);
  // Heavy context is omitted — already in the session's context window.
  assert.ok(!resumed.includes("the spec"), "spec omitted on resume");
  assert.ok(!resumed.includes("always commit"), "etiquette omitted on resume");
  assert.ok(!resumed.includes("# Team"), "team section omitted on resume");
  assert.ok(!resumed.includes("# Your brief"), "brief omitted on resume");

  // Full prompt (non-resume) still includes everything.
  const full = buildPrompt(promptConfig("fullstack"), promptTicket, "the spec", "always commit", companion as any, brief, false);
  assert.match(full, /the spec/);
  assert.match(full, /always commit/);
  assert.match(full, /# Team/);
  assert.match(full, /# Your brief/);
});

test("buildPrompt tells the agent to bail when the ticket is already review-or-greater", () => {
  const p = buildPrompt(promptConfig(), promptTicket, "spec", "etiquette");
  // It must check the live state first and stop without touching anything.
  assert.match(p, /read this ticket's current state/i);
  assert.match(p, /"review", "done" or "bin"/);
  assert.match(p, /stop immediately and exit/i);
  // And explicitly not second-guess via git history (snapshots often lack those commits).
  assert.match(p, /reconstruct the work from the git history or commit log/i);
});

test("buildPrompt includes the companion's brief so guest + local runs get the spec", () => {
  const companion = { id: "c1", name: "Bo", role: "soloist", avatarSeed: "Bo" };
  const brief = "# Commits\n\nBe fun, include emoji, use conventional commits";

  // With a brief, it surfaces under its own heading (this is the only place the
  // companion's commit conventions reach the agent — local and guest runs alike).
  const withBrief = buildPrompt(promptConfig(), promptTicket, "spec", "etiquette", companion as any, brief);
  assert.match(withBrief, /# Your brief/);
  assert.match(withBrief, /use conventional commits/);

  // Without one, no empty heading is emitted.
  assert.ok(!buildPrompt(promptConfig(), promptTicket, "spec", "etiquette", companion as any).includes("# Your brief"));
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

test("session error triggers a fresh retry without session flags", async () => {
  const saved = process.env.MYSTERON_AGENT_CMD;
  const proj = path.join(tmp, "session-err");
  const { config } = await initProject(proj, { name: "SessionErr" });
  const ticket = await createTicket(proj, { title: "Session retry", state: "ready" });

  // First invocation: emit a session-error phrase then exit non-zero.
  // Second invocation (retry): succeed normally.
  let attempt = 0;
  process.env.MYSTERON_AGENT_CMD = `
    if [ "$attempt_${process.pid}" = "" ]; then
      export attempt_${process.pid}=done
      echo "invalid session id" 1>&2
      exit 1
    fi
    echo "ok second time"
  `;
  // Simpler: use a counter file.
  const counter = path.join(proj, ".attempt");
  process.env.MYSTERON_AGENT_CMD =
    `if [ ! -f "${counter}" ]; then touch "${counter}"; echo "invalid session id" 1>&2; exit 1; fi; echo "ok second time"`;

  try {
    const rm = new RunManager();
    const run = await rm.start({ projectId: config.id, projectRoot: proj, config, ticket });

    // Wait for both the failed run and the retried run to settle.
    await waitFor(() => rm.get(run.id)?.status !== "running", 10000);
    assert.equal(rm.get(run.id)?.status, "failed");
    assert.ok(rm.get(run.id)?.lines.some((l) => l.text.includes("dropping session")));

    // The retry creates a second run for the same ticket — wait for it.
    await waitFor(
      () => rm.listByProject(config.id).some((r) => r.id !== run.id && r.ticketId === ticket.id && r.status !== "running"),
      10000,
    );
    const retry = rm.listByProject(config.id).find((r) => r.id !== run.id && r.ticketId === ticket.id);
    assert.ok(retry, "a retry run was created");
    assert.equal(retry?.status, "done");
    assert.ok(retry?.lines.some((l) => l.text.includes("ok second time")));
  } finally {
    if (saved !== undefined) process.env.MYSTERON_AGENT_CMD = saved;
    else delete process.env.MYSTERON_AGENT_CMD;
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
