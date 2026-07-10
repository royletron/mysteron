import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { listTickets } from "../core/board.js";
import { readDoc } from "../core/docs.js";
import { bus } from "../core/events.js";
import { dreamMemoryPath, dreamStatePath, DREAM_SPEC_DOC } from "../core/paths.js";
import type { DreamConfig } from "../core/types.js";

export interface DreamState {
  lastRunAt?: string;
  runCount: number;
  lastTicketsCreated: number;
}

export interface DreamMemoryEntry {
  id: string;
  title: string;
  createdAt: string;
}

export interface DreamMemory {
  tickets: DreamMemoryEntry[];
}

const DEFAULT_DREAM_SPEC = `# Dream Mode

You are in dream mode. Analyze this project and create concrete, actionable backlog tickets.

## What to analyze
- The codebase: read key source files to understand architecture and code quality
- All tickets: use list_tickets to see what's done, in-progress, and planned
- Opportunities: bugs, missing features, tech debt, UX improvements, general ideas

## What to create
- 3-5 new backlog tickets per run (quality over quantity)
- Mix of: bug fixes, feature additions, improvements, general ideas
- Each ticket should have a clear title and a body specific enough for an AI agent to implement
- All tickets MUST include the label "dream" — this is mandatory

## Constraints
- Do NOT duplicate tickets already on the board
- Do NOT recreate tickets you have previously created (your memory will list them)
- Be realistic: prefer actionable, scoped tickets over vague aspirational ones
- Set priority honestly: most ideas are "medium", reserve "high" for clear bugs or blockers

## Process
1. Call list_tickets to read the current board
2. Read key source files with the Read tool to understand the codebase
3. Think about gaps, improvements, and ideas
4. Call create_ticket for each new ticket (include label "dream")
`;

function mysteronMcpConfig(projectRoot: string): string {
  const entry = process.argv[1];
  const launcher =
    process.env.MYSTERON_MCP_BIN
      ? { command: process.env.MYSTERON_MCP_BIN, args: ["mcp", projectRoot] }
      : entry && entry.endsWith("cli.js")
        ? { command: process.execPath, args: [entry, "mcp", projectRoot] }
        : { command: "mysteron", args: ["mcp", projectRoot] };
  return JSON.stringify({ mcpServers: { mysteron: launcher } });
}

async function readDreamState(projectRoot: string): Promise<DreamState> {
  try {
    return JSON.parse(await fs.readFile(dreamStatePath(projectRoot), "utf8")) as DreamState;
  } catch {
    return { runCount: 0, lastTicketsCreated: 0 };
  }
}

async function saveDreamState(projectRoot: string, state: DreamState): Promise<void> {
  await fs.writeFile(dreamStatePath(projectRoot), JSON.stringify(state, null, 2) + "\n", "utf8");
}

async function readDreamMemory(projectRoot: string): Promise<DreamMemory> {
  try {
    return JSON.parse(await fs.readFile(dreamMemoryPath(projectRoot), "utf8")) as DreamMemory;
  } catch {
    return { tickets: [] };
  }
}

async function saveDreamMemory(projectRoot: string, memory: DreamMemory): Promise<void> {
  await fs.writeFile(dreamMemoryPath(projectRoot), JSON.stringify(memory, null, 2) + "\n", "utf8");
}

function isDue(state: DreamState, scheduleHours: number): boolean {
  if (!state.lastRunAt) return true;
  return Date.now() - Date.parse(state.lastRunAt) >= scheduleHours * 3_600_000;
}

async function runDream(projectRoot: string, projectId: string, config: DreamConfig, verbose: boolean): Promise<void> {
  const spec = (await readDoc(projectRoot, DREAM_SPEC_DOC)) ?? DEFAULT_DREAM_SPEC;
  const memory = await readDreamMemory(projectRoot);

  // Snapshot ticket IDs before the run to detect newly created ones.
  const before = new Set((await listTickets(projectRoot)).map((t) => t.id));

  const previousList =
    memory.tickets.length === 0
      ? "None yet — this is the first dream run."
      : memory.tickets.map((t) => `- ${t.id}: ${t.title}`).join("\n");

  const prompt = [
    spec,
    "",
    `## Project root\n${projectRoot}`,
    "",
    `## Previously created dream tickets (do NOT recreate these)\n${previousList}`,
    "",
    "Now analyze the project and create new backlog tickets. Remember to include the label \"dream\" on every ticket you create.",
  ].join("\n");

  const mcpConfig = mysteronMcpConfig(projectRoot);
  const args = [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "bypassPermissions",
    "--mcp-config", mcpConfig,
    "--strict-mcp-config",
    "--allowedTools", "mcp__mysteron", "Read",
    "--disallowedTools", "Write", "Edit", "Bash", "NotebookEdit", "MultiEdit", "WebSearch", "WebFetch",
  ];

  if (verbose) console.log(`[dream] starting dream run for ${path.basename(projectRoot)}`);

  await new Promise<void>((resolve) => {
    const child = spawn("claude", args, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...(process.env.MYSTERON_RATELIMIT_PROXY_URL
          ? { ANTHROPIC_BASE_URL: process.env.MYSTERON_RATELIMIT_PROXY_URL }
          : {}),
      },
    });

    child.stdout.on("data", () => undefined); // consume stdout (streaming JSON)
    child.stderr.on("data", (d: Buffer) => { if (verbose) process.stderr.write(d); });
    child.on("close", () => resolve());
    child.on("error", (err) => {
      if (verbose) console.error(`[dream] claude launch error: ${err.message}`);
      resolve();
    });
  });

  // Detect newly created tickets and add them to memory.
  const after = await listTickets(projectRoot);
  const newTickets = after.filter((t) => !before.has(t.id));

  if (newTickets.length > 0) {
    memory.tickets.push(
      ...newTickets.map((t) => ({ id: t.id, title: t.title, createdAt: new Date().toISOString() })),
    );
    await saveDreamMemory(projectRoot, memory);
    if (verbose) console.log(`[dream] created ${newTickets.length} ticket(s): ${newTickets.map((t) => t.title).join(", ")}`);
  }

  const state = await readDreamState(projectRoot);
  await saveDreamState(projectRoot, {
    lastRunAt: new Date().toISOString(),
    runCount: (state.runCount || 0) + 1,
    lastTicketsCreated: newTickets.length,
  });

  bus.emitEvent({ type: "board-changed", projectId });
}

/**
 * Drives dream mode for all registered projects. Call check() periodically
 * (e.g. hourly) and it fires a dream run when the schedule is due and no run
 * is already in progress for that project.
 */
export class DreamRunner {
  private running = new Set<string>();

  async check(projectRoot: string, projectId: string, config: DreamConfig, verbose = false): Promise<void> {
    if (!config.enabled) return;
    if (this.running.has(projectRoot)) return;
    const state = await readDreamState(projectRoot);
    if (!isDue(state, config.scheduleHours ?? 24)) return;

    this.running.add(projectRoot);
    try {
      await runDream(projectRoot, projectId, config, verbose);
    } catch (err) {
      if (verbose) console.error(`[dream] error: ${(err as Error).message}`);
    } finally {
      this.running.delete(projectRoot);
    }
  }

  /** Read the current state for a project (last run, ticket count). */
  state(projectRoot: string): Promise<DreamState> {
    return readDreamState(projectRoot);
  }

  /** Read dream memory for a project. */
  memory(projectRoot: string): Promise<DreamMemory> {
    return readDreamMemory(projectRoot);
  }
}
