import { type ChildProcess, execFile, spawn } from "node:child_process";
import { promises as fs, accessSync, constants as FS } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { nanoid } from "nanoid";
import { bus, type RunLine } from "../core/events.js";
import { updateTicket } from "../core/board.js";
import { readDoc } from "../core/docs.js";
import { findRecipe, gitInstruction, resolveProjectGit } from "../core/recipes.js";
import { loadProjectConfig } from "../core/project.js";
import {
  addRunWorktree,
  captureSnapshotRef,
  isGitRepo,
  landGuestPatch,
  lockfileChange,
  releaseSnapshotRef,
  removeRunWorktree,
  worktreeRunPatch,
  type PackageManager,
  type RunWorktree,
} from "../core/git.js";
import { defaultCompanion, getCompanion, readCompanionSpec } from "../core/companions.js";
import type { WorkerRegistry, GuestRunResult } from "../server/workers.js";
import { ETIQUETTE_DOC, SPEC_DOC, runsDir } from "../core/paths.js";
import type { Companion, ProjectConfig, Ticket } from "../core/types.js";

const execFileAsync = promisify(execFile);

export type RunStatus = "running" | "done" | "failed" | "stopped";

const MAX_LINES = 5000;

/** Install command per package manager, used to seed an isolated worktree's own
 *  node_modules when the run's lockfile differs from the host's installed tree.
 *  Offline-first so the common cached case is fast and works without a network. */
const INSTALL_ARGS: Record<PackageManager, string[]> = {
  pnpm: ["install", "--prefer-offline"],
  npm: ["install", "--no-audit", "--no-fund", "--prefer-offline"],
  yarn: ["install"],
  bun: ["install"],
};

/**
 * Phrases Claude (Code/API) emits when a usage/spend/rate limit is hit. Anchored
 * to clear "limit reached / hit your … limit" wording so ordinary mentions of
 * "spend limit" in a ticket's own output don't trip it.
 */
const LIMIT_HIT_RE =
  /(?:you'?ve\s+)?hit your (?:usage|spend|rate) limit|(?:usage|spend|rate) limit reached|reached your (?:usage|spend|rate) limit|credit balance is too low/i;

/**
 * Phrases Claude Code emits when the session id is invalid for this account —
 * either the session was created on another machine (same account) and we tried
 * --session-id when we should have used --resume, or it was created on a
 * different account entirely. Detected so we can drop all session flags and
 * restart fresh rather than looping on an unrecoverable error.
 */
const SESSION_ERROR_RE =
  /invalid session id|session.*?not found|does not belong.*?account|session.*?already exists/i;

export interface Run {
  id: string;
  projectId: string;
  projectRoot: string;
  ticketId: string;
  ticketTitle: string;
  /** Id of the companion that ran this (see ProjectConfig.companions). */
  companionId?: string;
  /** Companion's name at run time (for display). */
  companion: string;
  /** Machine the run executed on (os.hostname()); committed so other machines can attribute it. */
  hostname: string;
  /** For guest runs: the guest machine's label. Set only when executing on a guest, so the host UI/terminal can show work is offloaded to another computer. */
  guestLabel?: string;
  status: RunStatus;
  command: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  /** Total cost in USD, from Claude Code's final result event (when reported). */
  costUsd?: number;
  /** Number of agent turns the run took (from the result event). */
  numTurns?: number;
  /** Whether the verbose log is available on this machine (logs are local-only). */
  logAvailable: boolean;
  /** Set when the agent reported hitting a usage/spend/rate limit (see LIMIT_HIT_RE). */
  limitHit?: boolean;
  /** Set when Claude rejected the session id (wrong account / already exists elsewhere). */
  sessionError?: boolean;
  /** For guest runs: the branch the returned patch was committed to (only when it landed on a dedicated branch, not the current one). */
  branch?: string;
  /** For guest runs: the working-tree snapshot the guest diffed against (pinned so `git apply --3way` can merge the result). */
  baseRef?: string;
  /** For guest runs: where the returned patch was saved on disk (so the work is recoverable even if applying it failed). */
  patchPath?: string;
  lines: RunLine[];
}

/** Thrown when a companion already has a run in flight (one task at a time). */
export class CompanionBusyError extends Error {
  constructor(public companionName: string) {
    super(`${companionName} is busy with another ticket`);
    this.name = "CompanionBusyError";
  }
}

interface StartArgs {
  projectId: string;
  projectRoot: string;
  config: ProjectConfig;
  ticket: Ticket;
}

type OutputFormat = "text" | "claude-stream-json";

/**
 * How to launch `mysteron mcp <root>` so the companion gets this project's board /
 * docs / memory tools. Prefers the exact CLI the server is running from (no PATH
 * dependency in production); falls back to the linked `mysteron` binary.
 */
function mysteronMcpLauncher(
  projectRoot: string,
  companionId?: string,
): { command: string; args: string[]; env?: Record<string, string> } {
  // Tell the MCP which companion is calling so tickets it raises are attributed.
  const env = companionId ? { MYSTERON_COMPANION_ID: companionId } : undefined;
  if (process.env.MYSTERON_MCP_BIN) {
    return { command: process.env.MYSTERON_MCP_BIN, args: ["mcp", projectRoot], env };
  }
  const entry = process.argv[1];
  if (entry && entry.endsWith("cli.js")) {
    return { command: process.execPath, args: [entry, "mcp", projectRoot], env };
  }
  return { command: "mysteron", args: ["mcp", projectRoot], env };
}

/** Resolve how to launch the agent. Fully overridable so any agent CLI works. Exported for testing. */
export function resolveCommand(
  config: ProjectConfig,
  projectRoot: string,
  prompt: string,
  companion?: Companion,
  resumeSession = false,
  noSession = false,
): {
  cmd: string;
  args: string[];
  shell: boolean;
  display: string;
  format: OutputFormat;
} {
  // Custom commands default to plain text, but can opt into the Claude
  // stream-json renderer if they emit that format.
  const customFormat: OutputFormat =
    process.env.MYSTERON_AGENT_FORMAT === "claude-stream-json" ? "claude-stream-json" : "text";

  // 1) Explicit shell command (env) — prompt arrives on stdin + env.
  const envCmd = process.env.MYSTERON_AGENT_CMD;
  if (envCmd) return { cmd: envCmd, args: [], shell: true, display: envCmd, format: customFormat };

  // 2) Per-project configured command.
  if (config.agent?.command) {
    const args = config.agent.args ?? [];
    return {
      cmd: config.agent.command,
      args,
      shell: false,
      display: `${config.agent.command} ${args.join(" ")}`.trim(),
      format: customFormat,
    };
  }

  // 3) Default: Claude Code, headless, streaming. `claude -p` alone buffers all
  // output until the end (looks frozen while it works), so we use stream-json to
  // get live events and render them readably. Yolo skips permission prompts.
  const mode = config.yolo ? "bypassPermissions" : "acceptEdits";
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", mode];

  // Give the companion this project's Mysteron MCP (board/docs/memory) so it can
  // read the spec, save memory, and move its ticket to "review". --strict-mcp-config
  // keeps the run deterministic (only this server, not the user's global ones).
  const attachMcp = process.env.MYSTERON_AGENT_MCP !== "0";
  const allowed = (config.allowedTools ?? []).filter((t) => t.trim());
  const disallowed = (config.disallowedTools ?? []).filter((t) => t.trim());
  if (attachMcp) {
    const launcher = mysteronMcpLauncher(projectRoot, companion?.id);
    const mcpConfig = JSON.stringify({ mcpServers: { mysteron: launcher } });
    args.push("--mcp-config", mcpConfig, "--strict-mcp-config");
    // Auto-allow Mysteron's own tools so the companion can use them without yolo.
    if (!allowed.includes("mcp__mysteron")) allowed.push("mcp__mysteron");
  }

  // Pin the companion to a stable session so it keeps one conversation across
  // tickets (continuity). `--session-id` *creates* the session (first run);
  // later runs must `--resume` it, or Claude errors "session already in use".
  // The per-companion lock guarantees no concurrent use of the same session.
  // MYSTERON_AGENT_SESSION=0 opts out (fresh context each run).
  const useSession = !noSession && companion && process.env.MYSTERON_AGENT_SESSION !== "0";
  const sessionFlag = resumeSession ? "--resume" : "--session-id";
  if (useSession) args.push(sessionFlag, companion.id);

  // Variadic flags go at the end.
  if (disallowed.length) args.push("--disallowedTools", ...disallowed);
  if (allowed.length) args.push("--allowedTools", ...allowed);

  return {
    cmd: "claude",
    args,
    shell: false,
    display:
      `claude -p <ticket> --output-format stream-json --permission-mode ${mode}` +
      (useSession ? ` ${sessionFlag} ${companion.id}` : "") +
      (attachMcp ? " --mcp-config <mysteron> --strict-mcp-config" : "") +
      (allowed.length ? ` --allowedTools ${allowed.join(" ")}` : "") +
      (disallowed.length ? ` --disallowedTools ${disallowed.join(" ")}` : ""),
    format: "claude-stream-json",
  };
}

/**
 * The agent binary a local run would launch, or null when the launch goes via a
 * shell (MYSTERON_AGENT_CMD) and so can't be introspected. Exported for testing.
 */
export function agentBinary(config: ProjectConfig): string | null {
  if (process.env.MYSTERON_AGENT_CMD) return null; // shell command — assume the user knows it works
  if (config.agent?.command) return config.agent.command;
  return "claude";
}

/** Whether `bin` resolves to an executable — an explicit path that exists, or a name found on PATH. */
function isExecutableAvailable(bin: string): boolean {
  if (bin.includes("/") || bin.includes("\\")) {
    try {
      accessSync(bin, FS.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      try {
        accessSync(path.join(dir, bin + ext), FS.X_OK);
        return true;
      } catch {
        /* keep looking */
      }
    }
  }
  return false;
}

/** Whether a ticket could actually be run locally — i.e. its agent program is installed. Exported for testing. */
export function agentAvailable(config: ProjectConfig): boolean {
  const bin = agentBinary(config);
  return bin === null ? true : isExecutableAvailable(bin);
}

/** A user-facing explanation for why no local agent is available to run a ticket. Exported for testing. */
export function agentUnavailableMessage(config: ProjectConfig): string {
  if (config.agent?.command) {
    return `No agent is available to run this ticket: the configured agent command \`${config.agent.command}\` isn't installed or on PATH. Check the project's agent config.`;
  }
  return "No agent is available to run this ticket: Claude Code (`claude`) isn't installed or on your PATH. Install Claude Code, or point Mysteron at another agent via config.agent.command or the MYSTERON_AGENT_CMD env var.";
}

interface RenderedLine {
  stream: "stdout" | "system";
  text: string;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** Strip the absolute project root from logged text so paths read as
 *  repo-relative (/path/to/project/src/x.ts → /src/x.ts). Split/join avoids
 *  regex-escaping the path's special characters. */
function stripProjectPath(s: string, projectRoot?: string): string {
  return projectRoot ? s.split(projectRoot).join("") : s;
}

function summarizeToolInput(input: unknown, projectRoot?: string): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "url", "query", "description"]) {
    if (typeof o[key] === "string") return stripProjectPath(truncate((o[key] as string).replace(/\s+/g, " "), 140), projectRoot);
  }
  return stripProjectPath(truncate(JSON.stringify(o), 140), projectRoot);
}

/**
 * Turn one Claude Code stream-json event into readable log line(s). Exported for
 * testing. Unknown shapes return [] so we never crash the run on a schema change.
 */
export function renderStreamEvent(obj: unknown, projectRoot?: string): RenderedLine[] {
  const out: RenderedLine[] = [];
  const push = (stream: "stdout" | "system", text: string) => {
    const t = text?.trimEnd?.();
    if (t) out.push({ stream, text: t });
  };
  const e = obj as Record<string, any>;
  switch (e?.type) {
    case "system":
      if (e.subtype === "init") {
        push("system", `⚙ session started · model ${e.model ?? "?"}${Array.isArray(e.tools) ? ` · ${e.tools.length} tools` : ""}`);
      }
      break;
    case "assistant":
      for (const b of e.message?.content ?? []) {
        if (b.type === "text") push("stdout", b.text);
        else if (b.type === "tool_use") push("system", `→ ${b.name} ${summarizeToolInput(b.input, projectRoot)}`.trimEnd());
      }
      break;
    case "user":
      for (const b of e.message?.content ?? []) {
        if (b.type === "tool_result") {
          const c = b.content;
          const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => x?.text ?? "").join("") : "";
          push("system", `  ← ${stripProjectPath(truncate(text.trim(), 1500), projectRoot)}`);
        }
      }
      break;
    case "result":
      push(
        "system",
        `✓ ${e.subtype ?? "done"}${typeof e.num_turns === "number" ? ` · ${e.num_turns} turns` : ""}${typeof e.total_cost_usd === "number" ? ` · $${e.total_cost_usd.toFixed(4)}` : ""}`,
      );
      if (typeof e.result === "string") push("stdout", truncate(e.result, 1000));
      break;
  }
  return out;
}

/** Pull cost (USD) and turn count from a Claude Code `result` event. Exported for testing. */
export function runResultStats(obj: unknown): { costUsd?: number; numTurns?: number } {
  const e = obj as Record<string, unknown>;
  if (e?.type !== "result") return {};
  return {
    costUsd: typeof e.total_cost_usd === "number" ? e.total_cost_usd : undefined,
    numTurns: typeof e.num_turns === "number" ? e.num_turns : undefined,
  };
}

/** Compose the agent prompt for a ticket, including the companion's recipe (team + git behaviour). Exported for testing. */
export function buildPrompt(
  config: ProjectConfig,
  ticket: Ticket,
  spec: string,
  etiquette: string,
  companion?: Companion,
  companionSpec?: string,
  resume = false,
): string {
  const recipe = findRecipe(config.recipe ?? "solo") ?? findRecipe("solo")!;
  const comp = companion ?? defaultCompanion(config);
  const images = ticket.attachments?.length
    ? [
        ``,
        `# Attached images`,
        `The reporter attached ${ticket.attachments.length} image(s) to this ticket. View each with the Read tool before starting — they show the problem or the desired result:`,
        ...ticket.attachments.map((name) => `- .mysteron/board/attachments/${ticket.id}/${name}`),
      ]
    : [];

  // On a resumed session the spec/etiquette/team/brief are already in the
  // companion's context window — send only the new ticket to avoid re-paying
  // those tokens on every run after the first.
  if (resume) {
    return [
      `You are continuing as ${comp?.name ?? "the companion"} on the project "${config.name}".`,
      `Work on the following ticket end-to-end, following the project etiquette. If a Mysteron MCP server is configured, use it to read docs/memory and to move this ticket to "review" when the work is complete and tests pass.`,
      `First, read this ticket's current state — call \`mcp__mysteron__get_ticket\` with id \`${ticket.id}\` if the Mysteron MCP is available, or fall back to reading \`.mysteron/board/${ticket.id}.md\` directly. If the state is already "review", "done" or "bin", the work is finished — stop immediately and exit without making any changes.`,
      ``,
      `# Ticket ${ticket.id}: ${ticket.title}`,
      ticket.body || "(no description)",
      ...images,
      ``,
      `# Git`,
      gitInstruction(resolveProjectGit(config)),
      comp ? `When you commit, add a trailer line \`Mysteron-Companion: ${comp.name}\` so the work is attributed to you in Mysteron.` : "",
    ].join("\n");
  }

  const team =
    recipe.roles.length > 1
      ? [
          ``,
          `# Team (${recipe.name})`,
          `You may delegate to sub-agents in these roles; coordinate their work and own the final result:`,
          ...recipe.roles.map((r) => `- **${r.role}** — ${r.description}`),
        ]
      : [];
  const brief = companionSpec?.trim() ? [``, `# Your brief`, companionSpec.trim()] : [];
  return [
    `You are ${comp?.name ?? "the companion"} (role: ${comp?.role ?? "soloist"}), working on the project "${config.name}".`,
    `Work on the following ticket end-to-end, following the project etiquette. If a Mysteron MCP server is configured, use it to read docs/memory and to move this ticket to "review" when the work is complete and tests pass.`,
    `First, read this ticket's current state — call \`mcp__mysteron__get_ticket\` with id \`${ticket.id}\` if the Mysteron MCP is available, or fall back to reading \`.mysteron/board/${ticket.id}.md\` directly. If it is already in "review", "done" or "bin", the work is finished — stop immediately and exit without making any changes. Do NOT try to reconstruct the work from the git history or commit log; those commits are often absent from the snapshot you were given, and trusting the ticket's state is correct.`,
    ...brief,
    ``,
    `# Ticket ${ticket.id}: ${ticket.title}`,
    ticket.body || "(no description)",
    ...images,
    ``,
    `# Git`,
    gitInstruction(resolveProjectGit(config)),
    comp ? `When you commit, add a trailer line \`Mysteron-Companion: ${comp.name}\` so the work is attributed to you in Mysteron.` : "",
    ...team,
    ``,
    `# Project etiquette`,
    etiquette || "(none specified)",
    ``,
    `# Specification (excerpt)`,
    (spec || "(none)").slice(0, 4000),
  ].join("\n");
}

/**
 * Choose how a guest's returned work should be committed on the host. Prefers the
 * commit message the agent wrote itself (it ran under the companion role, so it
 * already follows the project's commit conventions — wording, emoji, trailers);
 * falls back to the ticket title only when the guest agent committed nothing of
 * its own. The attribution trailer is omitted when the agent already included it,
 * so it's never duplicated. Exported for testing.
 */
export function guestLandMessage(
  agentMessage: string | undefined,
  ticketTitle: string,
  companion: string,
): { message: string; trailer?: string } {
  const agentMsg = agentMessage?.trim();
  const trailer = `Mysteron-Companion: ${companion}`;
  if (!agentMsg) return { message: ticketTitle, trailer };
  return { message: agentMsg, trailer: /Mysteron-Companion:/i.test(agentMsg) ? undefined : trailer };
}

/**
 * Spawns and supervises agent runs, buffering their output and broadcasting it
 * over the event bus so the web UI can show a live view of an agent working a
 * ticket. Runs are kept in memory for the life of the server process.
 */
export class RunManager {
  private runs = new Map<string, Run>();
  private procs = new Map<string, ChildProcess>();
  private waiters = new Map<string, ((run: Run) => void)[]>();
  /** runId -> last incremental-persist time (ms), to throttle disk writes. */
  private lastPersist = new Map<string, number>();
  /** runId -> isolated worktree a local run executes in (when the project is a git repo). */
  private isolation = new Map<string, RunWorktree>();

  get(id: string): Run | undefined {
    return this.runs.get(id);
  }

  /**
   * Load run history persisted by earlier server processes so a ticket's agent
   * history survives restarts. Runs left "running" by a crashed/killed process
   * are orphaned — there's no live process to attach to — so we mark them
   * stopped. In-memory runs always win over a stale file of the same id.
   */
  async hydrate(projects: { projectId: string; projectRoot: string }[]): Promise<number> {
    let loaded = 0;
    const host = os.hostname();
    for (const { projectId, projectRoot } of projects) {
      const dir = runsDir(projectRoot);
      let files: string[] = [];
      try {
        files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
      } catch {
        continue; // no runs dir yet
      }
      for (const f of files) {
        try {
          const meta = JSON.parse(await fs.readFile(path.join(dir, f), "utf8")) as Run;
          if (!meta?.id || this.runs.has(meta.id)) continue;
          // Reattach machine-local context (committed metadata omits it).
          meta.projectId = projectId;
          meta.projectRoot = projectRoot;
          // Load the verbose log if it's on this machine; otherwise the run came
          // from another machine — we only know that it happened.
          const logFile = path.join(dir, `${meta.id}.log`);
          try {
            const log = await fs.readFile(logFile, "utf8");
            meta.lines = log
              .split("\n")
              .filter((l) => l.trim())
              .map((l) => JSON.parse(l) as RunLine);
            meta.logAvailable = true;
          } catch {
            meta.lines = [];
            meta.logAvailable = false;
          }
          // Only a run that was ours and left "running" is genuinely orphaned.
          if (meta.status === "running" && meta.hostname === host) {
            meta.status = "stopped";
            meta.endedAt ??= meta.startedAt;
            meta.lines.push({
              stream: "system",
              text: "■ run was interrupted by a server restart",
              at: new Date().toISOString(),
            });
          }
          this.runs.set(meta.id, meta);
          loaded++;
        } catch {
          /* skip an unreadable run file rather than fail the whole load */
        }
      }
    }
    return loaded;
  }

  /** Resolve once the run leaves the "running" state (done/failed/stopped). */
  waitFor(id: string): Promise<Run> {
    const run = this.runs.get(id);
    if (!run) return Promise.reject(new Error(`unknown run: ${id}`));
    if (run.status !== "running") return Promise.resolve(run);
    return new Promise((resolve) => {
      const arr = this.waiters.get(id) ?? [];
      arr.push(resolve);
      this.waiters.set(id, arr);
    });
  }

  listByProject(projectId: string): Run[] {
    return [...this.runs.values()]
      .filter((r) => r.projectId === projectId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Runs currently executing on a guest machine — for host-side status display. */
  activeGuestRuns(): { id: string; guestLabel: string; ticketTitle: string }[] {
    return [...this.runs.values()]
      .filter((r) => r.status === "running" && r.guestLabel)
      .map((r) => ({ id: r.id, guestLabel: r.guestLabel as string, ticketTitle: r.ticketTitle }));
  }

  activeForTicket(projectId: string, ticketId: string): Run | undefined {
    return [...this.runs.values()].find(
      (r) => r.projectId === projectId && r.ticketId === ticketId && r.status === "running",
    );
  }

  /** The active run for a companion, if any (a companion does one task at a time). */
  activeForCompanion(projectId: string, companionId: string): Run | undefined {
    return [...this.runs.values()].find(
      (r) => r.projectId === projectId && r.companionId === companionId && r.status === "running",
    );
  }

  /**
   * Whether a companion already has a Claude session on this machine — true if it
   * has any prior run recorded here (sessions are local, keyed by hostname).
   */
  companionHasLocalSession(companionId: string): boolean {
    const host = os.hostname();
    return [...this.runs.values()].some((r) => r.companionId === companionId && r.hostname === host);
  }

  /** Ids of companions currently running a task in a project. */
  busyCompanionIds(projectId: string): string[] {
    return [...this.runs.values()]
      .filter((r) => r.projectId === projectId && r.status === "running" && r.companionId)
      .map((r) => r.companionId as string);
  }

  async start(args: StartArgs, /** @internal */ _noSession = false): Promise<Run> {
    const active = this.activeForTicket(args.projectId, args.ticket.id);
    if (active) return active;

    // Run as the ticket's assigned companion (falling back to the soloist/first).
    const companion = getCompanion(args.config, args.ticket.companionId) ?? defaultCompanion(args.config);
    // One task per companion — refuse if it's already working something else.
    if (companion) {
      const busy = this.activeForCompanion(args.projectId, companion.id);
      if (busy && busy.ticketId !== args.ticket.id) throw new CompanionBusyError(companion.name);
    }

    const spec = (await readDoc(args.projectRoot, SPEC_DOC)) ?? "";
    const etiquette = (await readDoc(args.projectRoot, ETIQUETTE_DOC)) ?? "";
    const companionSpec = companion ? await readCompanionSpec(args.projectRoot, companion.id) : undefined;
    // If this companion has already run on this machine its Claude session
    // exists — resume it rather than trying to recreate the same session id.
    // _noSession skips all session flags (retry path after a session error).
    const resumeSession = !_noSession && companion ? this.companionHasLocalSession(companion.id) : false;
    const prompt = buildPrompt(args.config, args.ticket, spec, etiquette, companion, companionSpec ?? undefined, resumeSession);
    const { cmd, args: cmdArgs, shell, display, format } = resolveCommand(
      args.config,
      args.projectRoot,
      prompt,
      companion,
      resumeSession,
      _noSession,
    );

    const run: Run = {
      id: nanoid(10),
      projectId: args.projectId,
      projectRoot: args.projectRoot,
      ticketId: args.ticket.id,
      ticketTitle: args.ticket.title,
      companionId: companion?.id,
      companion: companion?.name ?? "companion",
      hostname: os.hostname(),
      status: "running",
      command: display,
      startedAt: new Date().toISOString(),
      logAvailable: true,
      lines: [],
    };
    this.runs.set(run.id, run);

    // Claim the ticket for the companion.
    await updateTicket(args.projectRoot, args.ticket.id, {
      state: "in-progress",
      assignee: companion?.name,
    }).catch(() => undefined);

    bus.emitRun({ kind: "started", runId: run.id, projectId: run.projectId, ticketId: run.ticketId });
    bus.emitEvent({ type: "board-changed", projectId: run.projectId, detail: run.ticketId });
    this.append(run, "system", `▶ ${display}`);

    // Isolate the run in its own worktree off a snapshot of the project, so
    // parallel companions don't see or commit each other's half-finished work.
    // The result is landed via landGuestPatch — the same strategy-aware path
    // guests use. Falls back to running in place when this isn't a git repo.
    const workdir = await this.setUpIsolation(run, args.projectRoot);
    this.append(run, "system", `cwd: ${workdir}`);
    void this.persist(run); // initial record, so even a crashed run leaves history

    const child = spawn(cmd, cmdArgs, {
      cwd: workdir,
      shell,
      env: {
        ...process.env,
        MYSTERON_PROJECT: args.config.name,
        MYSTERON_PROJECT_PATH: args.projectRoot,
        MYSTERON_TICKET_ID: args.ticket.id,
        MYSTERON_TICKET_TITLE: args.ticket.title,
        MYSTERON_TICKET_PROMPT: prompt,
        MYSTERON_YOLO: args.config.yolo ? "1" : "0",
        // Route the agent's Anthropic traffic through Mysteron's capture proxy so
        // we can read real usage limits off the response headers. The proxy
        // forwards to the original upstream (which it captured at startup), so
        // overriding the child's base URL here doesn't create a loop. Harmless
        // for non-Anthropic custom agents (they ignore it).
        ...(process.env.MYSTERON_RATELIMIT_PROXY_URL
          ? { ANTHROPIC_BASE_URL: process.env.MYSTERON_RATELIMIT_PROXY_URL }
          : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.procs.set(run.id, child);

    // For shell/custom commands, also provide the prompt on stdin.
    if (shell || args.config.agent?.command) {
      child.stdin?.write(prompt + "\n");
    }
    child.stdin?.end();

    this.pipe(run, child.stdout, "stdout", format);
    this.pipe(run, child.stderr, "stderr", "text");

    child.on("error", (err) => {
      this.append(run, "system", `✖ failed to launch: ${err.message}`);
      if (cmd === "claude") {
        this.append(run, "system", "Is Claude Code installed and on PATH? Override with MYSTERON_AGENT_CMD or config.agent.command.");
      }
      this.finish(run, "failed", null);
    });

    child.on("close", (code) => {
      if (run.status !== "running") return; // already stopped
      this.append(run, "system", `■ agent exited with code ${code}`);

      // The session id was rejected by Claude (wrong account or already exists
      // on another machine). Drop all session flags and restart fresh — once.
      if (run.sessionError && !_noSession) {
        this.append(
          run,
          "system",
          "⚠ Claude session belongs to a different account or machine — dropping session and restarting fresh",
        );
        this.finish(run, "failed", code);
        void this.start(args, true);
        return;
      }

      if (this.isolation.has(run.id)) {
        void this.landLocalRun(run, code);
      } else {
        this.finish(run, code === 0 ? "done" : "failed", code);
      }
    });

    return run;
  }

  /**
   * Prepare an isolated worktree for a local run and return the directory to run
   * the agent in. When the project is a git repo, snapshots the working tree and
   * checks it out in a per-run worktree (with the host's node_modules symlinked
   * in). Any failure falls back to running directly in the project root.
   */
  private async setUpIsolation(run: Run, projectRoot: string): Promise<string> {
    if (!(await isGitRepo(projectRoot))) return projectRoot;
    try {
      const baseRef = await captureSnapshotRef(projectRoot, run.id);
      const wt = await addRunWorktree(projectRoot, baseRef, run.id);
      this.isolation.set(run.id, wt);
      await this.prepareNodeModules(run, projectRoot, wt.dir);
      this.append(run, "system", "⎇ isolated in a worktree off a snapshot of the project");
      return wt.dir;
    } catch (e) {
      this.isolation.delete(run.id);
      await releaseSnapshotRef(projectRoot, run.id).catch(() => undefined);
      this.append(run, "system", `⚠ couldn't isolate the run (${(e as Error).message}); running in place`);
      return projectRoot;
    }
  }

  /**
   * Give an isolated worktree its dependencies (the snapshot excludes node_modules
   * — it's gitignored). The cheap default symlinks the host's tree: near-instant
   * and shares the build cache. But when the run's snapshot carries a changed
   * lockfile, the host's installed tree is stale *and* a shared symlink would leak
   * the run's own install back into it — so we install into the worktree's own
   * node_modules instead. Best-effort throughout: any failure just leaves the run
   * to install for itself.
   */
  private async prepareNodeModules(run: Run, projectRoot: string, workdir: string): Promise<void> {
    const changed = await lockfileChange(projectRoot).catch(() => null);
    if (changed) {
      this.append(run, "system", `⇣ ${changed.file} changed — installing deps in the isolated tree (${changed.manager})`);
      if (await this.installNodeModules(workdir, changed.manager)) return;
      this.append(run, "system", "⚠ isolated install failed; linking the host's node_modules instead");
    }
    const src = path.join(projectRoot, "node_modules");
    try {
      await fs.access(src);
    } catch {
      return; // host has no installed deps to share
    }
    await fs.symlink(src, path.join(workdir, "node_modules"), "dir").catch(() => undefined);
  }

  /** Run a package manager's install in an isolated worktree. Returns whether it
   *  succeeded; never throws (a failed install falls back to the host symlink). */
  private async installNodeModules(workdir: string, manager: PackageManager): Promise<boolean> {
    try {
      await execFileAsync(manager, INSTALL_ARGS[manager], {
        cwd: workdir,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        timeout: 5 * 60_000,
        maxBuffer: 64 << 20,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A local isolated run finished — land its diff via the same strategy-aware
   * path guests use, then tear the worktree down. On a clean exit with applied
   * work the ticket goes to review; a patch that won't apply returns it to ready.
   */
  private async landLocalRun(run: Run, code: number | null): Promise<void> {
    const wt = this.isolation.get(run.id);
    let applied = false;
    let landFailed = false;
    if (wt && code === 0) {
      try {
        const { patch, commitMessage } = await worktreeRunPatch(wt.dir, wt.baseSha);
        if (patch.trim()) {
          const config = await loadProjectConfig(run.projectRoot);
          const git = config ? resolveProjectGit(config) : { strategy: "current-branch" as const };
          const { message, trailer } = guestLandMessage(commitMessage, run.ticketTitle, run.companion);
          const res = await landGuestPatch(run.projectRoot, {
            runId: run.id,
            ticketId: run.ticketId,
            patch,
            message,
            trailer,
            strategy: git.strategy,
            targetBranch: git.targetBranch,
            branchPrefix: git.branchPrefix,
          });
          run.patchPath = res.patchPath;
          if (res.ok && res.mode === "noop") {
            this.append(run, "system", "ℹ the run's changes were already present — nothing to land.");
          } else if (res.ok && res.mode === "current-branch") {
            applied = true;
            this.append(run, "system", `✓ changes committed to the current branch (${res.commit?.slice(0, 8)})`);
          } else if (res.ok) {
            applied = true;
            run.branch = res.branch;
            this.append(
              run,
              "system",
              `✓ changes committed to branch ${res.branch} (${res.commit?.slice(0, 8)}) — \`git merge ${res.branch}\` to bring them into your branch`,
            );
          } else {
            landFailed = true;
            this.append(
              run,
              "system",
              `✖ could not apply the run's patch (${res.error}). The diff is saved at ${res.patchPath} — \`git apply --3way "${res.patchPath}"\` to apply it manually.`,
            );
          }
        } else {
          this.append(run, "system", "ℹ agent finished but made no file changes.");
        }
      } catch (e) {
        landFailed = true;
        this.append(run, "system", `✖ failed to land the run: ${(e as Error).message}`);
      }
    }

    // Mirror the guest path: applied work goes to review; a failed apply returns
    // the ticket to ready to retry. (A clean run with no changes leaves whatever
    // state the agent set via the board MCP.)
    if (applied) {
      await updateTicket(run.projectRoot, run.ticketId, { state: "review" }).catch(() => undefined);
    } else if (landFailed) {
      await updateTicket(run.projectRoot, run.ticketId, { state: "ready" }).catch(() => undefined);
    }
    this.finish(run, code === 0 ? "done" : "failed", code);
  }

  /** Tear down a run's isolated worktree and snapshot ref (best-effort, idempotent). */
  private async teardownIsolation(runId: string, projectRoot: string): Promise<void> {
    const wt = this.isolation.get(runId);
    if (!wt) return;
    this.isolation.delete(runId);
    await removeRunWorktree(projectRoot, wt.dir, wt.branch).catch(() => undefined);
    await releaseSnapshotRef(projectRoot, runId).catch(() => undefined);
  }

  stop(id: string): boolean {
    const run = this.runs.get(id);
    const proc = this.procs.get(id);
    if (!run || run.status !== "running") return false;
    proc?.kill("SIGTERM");
    this.append(run, "system", "■ stopped by user");
    this.finish(run, "stopped", null);
    return true;
  }

  /**
   * Dispatch a ticket to a connected guest worker instead of running it locally.
   * Creates a Run attributed to the guest, composes the prompt here (the guest
   * needs no board access), and asks the registry to hand it to the worker. The
   * guest streams output back (ingestWorkerLine) and returns a patch on finish
   * (applyGuestResult).
   */
  async startOnWorker(
    args: StartArgs,
    workers: WorkerRegistry,
    worker: { id: string; label: string },
  ): Promise<Run | undefined> {
    const active = this.activeForTicket(args.projectId, args.ticket.id);
    if (active) return active;

    const companion = getCompanion(args.config, args.ticket.companionId) ?? defaultCompanion(args.config);
    const spec = (await readDoc(args.projectRoot, SPEC_DOC)) ?? "";
    const etiquette = (await readDoc(args.projectRoot, ETIQUETTE_DOC)) ?? "";
    const companionSpec = companion ? await readCompanionSpec(args.projectRoot, companion.id) : undefined;
    const prompt = buildPrompt(args.config, args.ticket, spec, etiquette, companion, companionSpec ?? undefined);

    const id = nanoid(10);
    // Pin the working-tree state the guest will diff against, so we serve it as
    // the snapshot and can 3-way-merge the returned patch back even if the host
    // moves on. Released once the result lands (see applyGuestResult).
    const baseRef = await captureSnapshotRef(args.projectRoot, id);

    const run: Run = {
      id,
      projectId: args.projectId,
      projectRoot: args.projectRoot,
      ticketId: args.ticket.id,
      ticketTitle: args.ticket.title,
      companionId: companion?.id,
      companion: companion?.name ?? "companion",
      hostname: worker.label, // attribute the run to the guest machine
      guestLabel: worker.label,
      baseRef,
      status: "running",
      command: `guest:${worker.label} ▶ ${args.ticket.title}`,
      startedAt: new Date().toISOString(),
      logAvailable: true,
      lines: [],
    };
    this.runs.set(run.id, run);

    await updateTicket(args.projectRoot, args.ticket.id, {
      state: "in-progress",
      assignee: companion?.name,
    }).catch(() => undefined);

    bus.emitRun({ kind: "started", runId: run.id, projectId: run.projectId, ticketId: run.ticketId });
    bus.emitEvent({ type: "board-changed", projectId: run.projectId, detail: run.ticketId });
    this.append(run, "system", `▶ dispatched to guest "${worker.label}"`);
    void this.persist(run);

    const allowed = (args.config.allowedTools ?? []).filter((t) => t.trim());
    const disallowed = (args.config.disallowedTools ?? []).filter((t) => t.trim());
    const ok = workers.dispatch(worker.id, {
      t: "dispatch",
      runId: run.id,
      ticketId: args.ticket.id,
      ticketTitle: args.ticket.title,
      prompt,
      snapshotPath: `/api/worker/snapshot/${run.id}`,
      mcpPath: `/api/worker/mcp/${run.id}`,
      yolo: args.config.yolo,
      allowedTools: allowed,
      disallowedTools: disallowed,
    });
    if (!ok) {
      this.append(run, "system", "✖ guest is no longer available");
      await releaseSnapshotRef(args.projectRoot, run.id);
      this.finish(run, "failed", null);
    }
    return run;
  }

  /** A line of output streamed from a guest run. */
  ingestWorkerLine(runId: string, stream: RunLine["stream"], text: string): void {
    const run = this.runs.get(runId);
    if (!run || run.status !== "running") return;
    this.append(run, stream, text);
  }

  /** A guest run finished — apply its patch (if any) and finalize. */
  async applyGuestResult(runId: string, result: GuestRunResult): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || run.status !== "running") return;
    if (result.costUsd != null) run.costUsd = result.costUsd;
    if (result.numTurns != null) run.numTurns = result.numTurns;

    let applied = false;
    const patch = result.patchBase64 ? Buffer.from(result.patchBase64, "base64").toString("utf8") : "";
    if (result.status === "done" && patch.trim()) {
      // Land the work the same way a local run does, under this project's commit
      // strategy: onto the current/target branch, or a dedicated one (see landGuestPatch).
      const config = await loadProjectConfig(run.projectRoot);
      const git = config ? resolveProjectGit(config) : { strategy: "current-branch" as const };
      const { message, trailer } = guestLandMessage(result.commitMessage, run.ticketTitle, run.companion);
      const res = await landGuestPatch(run.projectRoot, {
        runId: run.id,
        ticketId: run.ticketId,
        patch,
        message,
        trailer,
        strategy: git.strategy,
        targetBranch: git.targetBranch,
        branchPrefix: git.branchPrefix,
      });
      run.patchPath = res.patchPath;
      if (res.ok && res.mode === "noop") {
        this.append(run, "system", "ℹ the guest's changes were already present — nothing to land.");
      } else if (res.ok && res.mode === "current-branch") {
        applied = true;
        this.append(run, "system", `✓ guest changes committed to the current branch (${res.commit?.slice(0, 8)})`);
      } else if (res.ok) {
        applied = true;
        run.branch = res.branch;
        this.append(
          run,
          "system",
          `✓ guest changes committed to branch ${res.branch} (${res.commit?.slice(0, 8)}) — \`git merge ${res.branch}\` to bring them into your branch`,
        );
      } else {
        this.append(
          run,
          "system",
          `✖ could not apply the guest's patch (${res.error}). The diff is saved at ${res.patchPath} — \`git apply --3way "${res.patchPath}"\` to apply it manually.`,
        );
      }
    } else if (result.status === "done") {
      this.append(run, "system", "ℹ guest finished but made no file changes.");
    }
    await releaseSnapshotRef(run.projectRoot, run.id);

    // Applied work goes to review; anything else returns to Ready for a retry.
    await updateTicket(run.projectRoot, run.ticketId, { state: applied ? "review" : "ready" }).catch(() => undefined);
    this.finish(run, result.status, result.exitCode);
  }

  private pipe(
    run: Run,
    stream: NodeJS.ReadableStream | null,
    kind: "stdout" | "stderr",
    format: OutputFormat,
  ): void {
    if (!stream) return;
    let buffer = "";
    const emit = (raw: string) => {
      if (format === "claude-stream-json" && kind === "stdout") {
        // Each line is a JSON event — render it into readable log line(s).
        if (!raw.trim()) return;
        let obj: unknown;
        try {
          obj = JSON.parse(raw);
        } catch {
          this.append(run, "stdout", raw); // not JSON — show as-is
          return;
        }
        const stats = runResultStats(obj);
        if (stats.costUsd != null) run.costUsd = stats.costUsd;
        if (stats.numTurns != null) run.numTurns = stats.numTurns;
        for (const r of renderStreamEvent(obj, run.projectRoot)) this.append(run, r.stream, r.text);
      } else {
        this.append(run, kind, raw);
      }
    };
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        emit(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    });
    stream.on("end", () => {
      if (buffer.length) emit(buffer);
    });
  }

  private append(run: Run, stream: RunLine["stream"], text: string): void {
    if (!run.limitHit && LIMIT_HIT_RE.test(text)) run.limitHit = true;
    if (!run.sessionError && SESSION_ERROR_RE.test(text)) run.sessionError = true;
    const line: RunLine = { stream, text, at: new Date().toISOString() };
    run.lines.push(line);
    if (run.lines.length > MAX_LINES) run.lines.splice(0, run.lines.length - MAX_LINES);
    bus.emitRun({ kind: "line", runId: run.id, projectId: run.projectId, ticketId: run.ticketId, line });
    // Persist partial output (throttled) so a run killed mid-flight — e.g. by a
    // dev-server restart — still shows what the agent managed to do.
    const now = Date.now();
    if (now - (this.lastPersist.get(run.id) ?? 0) > 1000) {
      this.lastPersist.set(run.id, now);
      void this.persist(run);
    }
  }

  /**
   * Persist a run as two files: committed metadata (`<id>.json`, no output, so
   * run history travels with the repo) and a gitignored local log (`<id>.log`,
   * the verbose output, which stays on the machine that ran it).
   */
  private async persist(run: Run): Promise<void> {
    try {
      const dir = runsDir(run.projectRoot);
      await fs.mkdir(dir, { recursive: true });
      // Keep the verbose log out of git.
      await fs.writeFile(path.join(dir, ".gitignore"), "*.log\n", "utf8").catch(() => undefined);
      const { lines, logAvailable, projectId, projectRoot, ...meta } = run;
      void logAvailable;
      void projectId;
      void projectRoot;
      await fs.writeFile(path.join(dir, `${run.id}.json`), JSON.stringify(meta, null, 2), "utf8");
      await fs.writeFile(
        path.join(dir, `${run.id}.log`),
        lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
        "utf8",
      );
    } catch {
      /* a disk hiccup must never take down a live run */
    }
  }

  private finish(run: Run, status: RunStatus, exitCode: number | null): void {
    run.status = status;
    run.exitCode = exitCode;
    run.endedAt = new Date().toISOString();
    this.procs.delete(run.id);
    this.lastPersist.delete(run.id);
    // Clean up any isolated worktree (landLocalRun has already read it by now;
    // stop()/launch failures land here without landing — either way it's gone).
    void this.teardownIsolation(run.id, run.projectRoot);

    // The agent hit a usage/spend/rate limit — it didn't finish, so put the
    // ticket back on Ready to be retried once the limit resets.
    if (run.limitHit && run.ticketId) {
      this.append(
        run,
        "system",
        "⚠ Claude usage/spend limit reached — moving the ticket back to Ready to retry after reset.",
      );
      void updateTicket(run.projectRoot, run.ticketId, { state: "ready" })
        .then(() => bus.emitEvent({ type: "board-changed", projectId: run.projectId, detail: run.ticketId }))
        .catch(() => undefined);
    }

    void this.persist(run); // final record with the complete output
    const waiters = this.waiters.get(run.id);
    if (waiters) {
      this.waiters.delete(run.id);
      for (const w of waiters) w(run);
    }
    bus.emitRun({ kind: "status", runId: run.id, projectId: run.projectId, ticketId: run.ticketId, status, exitCode });
    bus.emitEvent({ type: "board-changed", projectId: run.projectId, detail: run.ticketId });
  }
}

/** Strip the in-memory process buffers when serialising a run to JSON. */
export function runSummary(run: Run): Omit<Run, "lines"> & { lineCount: number } {
  const { lines, ...rest } = run;
  return { ...rest, lineCount: lines.length };
}
