import { spawn, execFile } from "node:child_process";
import { promises as fs, createWriteStream } from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import type { DispatchMsg, HostMsg } from "../core/worker-protocol.js";
import { renderStreamEvent, runResultStats } from "../runner/manager.js";

const pexec = promisify(execFile);

export interface GuestOptions {
  hostUrl: string;
  token: string;
  label?: string;
  /** Offer duration in ms (default 2h). */
  forMs?: number;
  capacity?: number;
}

export interface GuestStatus {
  offering: boolean;
  state: "connecting" | "offered" | "rejected" | "stopped";
  hostUrl: string;
  label: string;
  hostLabel?: string;
  expiresAt?: string;
  message?: string;
  activeRuns: number;
}

/** http(s)://host → ws(s)://host/worker */
function workerWsUrl(hostUrl: string): string {
  const u = new URL(hostUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/worker";
  u.search = "";
  return u.toString();
}

/**
 * A managed connection that offers this machine to a host as a guest worker:
 * registers a time-boxed offer, heartbeats, reconnects, and runs dispatched
 * tickets locally. Used both by the `join` CLI and by the running server (so a
 * guest can offer from their own web app).
 */
export class GuestConnection {
  private socket?: WebSocket;
  private heartbeat?: ReturnType<typeof setInterval>;
  private endTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private deadline = 0;
  private state: GuestStatus["state"] = "connecting";
  private message?: string;
  private hostLabel?: string;
  private expiresAt?: string;
  private active = 0;

  readonly hostUrl: string;
  readonly token: string;
  readonly label: string;
  readonly forMs: number;
  readonly capacity: number;

  /** Called whenever the status changes (for live UI / logging). */
  onChange?: (status: GuestStatus) => void;

  constructor(opts: GuestOptions) {
    if (!opts.token) throw new Error("a guest token is required (get it from the host's Settings)");
    this.hostUrl = opts.hostUrl;
    this.token = opts.token;
    this.label = opts.label || os.hostname();
    this.forMs = opts.forMs ?? 2 * 60 * 60 * 1000;
    this.capacity = Math.max(1, opts.capacity ?? 1);
  }

  status(): GuestStatus {
    return {
      offering: !this.stopped,
      state: this.state,
      hostUrl: this.hostUrl,
      label: this.label,
      hostLabel: this.hostLabel,
      expiresAt: this.expiresAt,
      message: this.message,
      activeRuns: this.active,
    };
  }

  private set(state: GuestStatus["state"], message?: string): void {
    this.state = state;
    this.message = message;
    this.onChange?.(this.status());
  }

  start(): void {
    this.deadline = Date.now() + this.forMs;
    this.connect();
    this.endTimer = setTimeout(() => this.stop("Offer window elapsed."), this.forMs);
    this.endTimer.unref?.();
  }

  stop(reason = "Offer withdrawn."): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.endTimer) clearTimeout(this.endTimer);
    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
    this.set("stopped", reason);
  }

  private connect(): void {
    if (this.stopped) return;
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) return this.stop("Offer window elapsed.");

    this.set("connecting", `Connecting to ${this.hostUrl}…`);
    const socket = new WebSocket(workerWsUrl(this.hostUrl));
    this.socket = socket;

    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          t: "register",
          token: this.token,
          label: this.label,
          capacity: this.capacity,
          expiresInMs: this.deadline - Date.now(),
        }),
      );
      this.heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: "heartbeat" }));
      }, 15_000);
    });

    socket.on("message", (raw) => {
      let msg: HostMsg;
      try {
        msg = JSON.parse(raw.toString()) as HostMsg;
      } catch {
        return;
      }
      if (msg.t === "registered") {
        this.hostLabel = msg.hostLabel;
        this.expiresAt = msg.expiresAt;
        this.set("offered", `Offered to host "${msg.hostLabel}" until ${new Date(msg.expiresAt).toLocaleString()}.`);
      } else if (msg.t === "rejected") {
        this.set("rejected", msg.reason);
        this.stop(`Rejected: ${msg.reason}`);
      } else if (msg.t === "expired") {
        this.stop("Offer expired on the host.");
      } else if (msg.t === "dispatch") {
        void this.runDispatch(socket, msg);
      }
    });

    socket.on("close", () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (this.stopped) return;
      if (this.deadline - Date.now() > 0) {
        this.set("connecting", "Disconnected — retrying in 3s…");
        setTimeout(() => this.connect(), 3000);
      } else {
        this.stop("Offer window elapsed.");
      }
    });

    socket.on("error", () => {
      /* 'close' fires next and handles retry */
    });
  }

  private async runDispatch(socket: WebSocket, msg: DispatchMsg): Promise<void> {
    this.active++;
    this.onChange?.(this.status());
    try {
      await handleDispatch(socket, msg, this.hostUrl, this.token);
    } finally {
      this.active = Math.max(0, this.active - 1);
      this.onChange?.(this.status());
    }
  }
}

/** CLI entry: offer this machine and stay up until the window elapses or Ctrl-C. */
export async function joinHost(opts: GuestOptions): Promise<void> {
  const conn = new GuestConnection(opts);
  conn.onChange = (s) => {
    if (s.message) console.log(`[guest] ${s.message}`);
    if (s.state === "offered") console.log("[guest] Waiting for work… (Ctrl-C to withdraw)");
  };
  process.on("SIGINT", () => conn.stop("Stopped — offer withdrawn."));
  conn.start();

  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (conn.status().state === "stopped") {
        clearInterval(check);
        resolve();
      }
    }, 500);
    check.unref?.();
  });
}

// --- dispatched-ticket execution -------------------------------------------

type LineFn = (stream: "stdout" | "stderr" | "system", text: string) => void;

/** Download an authenticated URL to a file. */
function downloadTo(url: string, token: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { headers: { "x-mysteron-guest-token": token } }, (res) => {
      if ((res.statusCode ?? 0) >= 400) {
        res.resume();
        return reject(new Error(`snapshot fetch failed (${res.statusCode})`));
      }
      const out = createWriteStream(dest);
      res.pipe(out);
      out.on("finish", () => out.close(() => resolve()));
      out.on("error", reject);
    });
    req.on("error", reject);
  });
}

/** Run Claude headless in the workspace, forwarding rendered output. Resolves with the exit code. */
function runClaude(
  workdir: string,
  msg: DispatchMsg,
  line: LineFn,
  onStats: (costUsd?: number, numTurns?: number) => void,
  mcpUrl?: string,
  token?: string,
): Promise<number | null> {
  return new Promise((resolve) => {
    const mode = msg.yolo ? "bypassPermissions" : "acceptEdits";
    const args = ["-p", msg.prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", mode];
    if (msg.disallowedTools.length) args.push("--disallowedTools", ...msg.disallowedTools);
    const allowed = [...msg.allowedTools];
    // Point Claude at the host's live MCP (board/docs/memory) over HTTP, so the
    // guest works against the real board rather than its tracked-files snapshot.
    if (mcpUrl) {
      const cfg = JSON.stringify({
        mcpServers: { mysteron: { type: "http", url: mcpUrl, headers: { "x-mysteron-guest-token": token ?? "" } } },
      });
      args.push("--mcp-config", cfg, "--strict-mcp-config");
      if (!allowed.includes("mcp__mysteron")) allowed.push("mcp__mysteron");
    }
    if (allowed.length) args.push("--allowedTools", ...allowed);

    const child = spawn("claude", args, { cwd: workdir, stdio: ["ignore", "pipe", "pipe"] });
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const raw = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!raw.trim()) continue;
        try {
          const obj = JSON.parse(raw);
          const stats = runResultStats(obj);
          if (stats.costUsd != null || stats.numTurns != null) onStats(stats.costUsd, stats.numTurns);
          for (const r of renderStreamEvent(obj)) line(r.stream, r.text);
        } catch {
          line("stdout", raw);
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => line("stderr", d.trimEnd()));
    child.on("error", (err) => {
      line("system", `✖ failed to launch claude: ${err.message} (is the Claude CLI on PATH?)`);
      resolve(null);
    });
    child.on("close", (code) => resolve(code));
  });
}

/**
 * Run one dispatched ticket: fetch the host's working-tree snapshot, run Claude
 * on it, and return a git diff of the result. A throwaway local git repo is the
 * diff engine — no shared remote needed.
 */
async function handleDispatch(socket: WebSocket, msg: DispatchMsg, hostUrl: string, token: string): Promise<void> {
  const line: LineFn = (stream, text) =>
    socket.send(JSON.stringify({ t: "run-line", runId: msg.runId, stream, text }));
  const workdir = path.join(os.tmpdir(), `mysteron-guest-${msg.runId}`);
  const git = (args: string[]) => pexec("git", ["-C", workdir, ...args], { maxBuffer: 64 << 20 });
  const id = ["-c", "user.name=Mysteron Guest", "-c", "user.email=guest@local"];

  let status: "done" | "failed" = "failed";
  let exitCode: number | null = null;
  let patchBase64: string | undefined;
  let commitMessage: string | undefined;
  let costUsd: number | undefined;
  let numTurns: number | undefined;

  try {
    await fs.mkdir(workdir, { recursive: true });
    line("system", "⤓ fetching workspace snapshot…");
    const tar = path.join(workdir, "_snapshot.tar");
    await downloadTo(new URL(msg.snapshotPath, hostUrl).toString(), token, tar);
    await pexec("tar", ["-xf", tar, "-C", workdir]);
    await fs.rm(tar, { force: true });

    await git(["init", "-q"]);
    await git(["add", "-A"]);
    await git([...id, "commit", "-q", "-m", "base", "--allow-empty"]);
    const base = (await git(["rev-parse", "HEAD"])).stdout.trim();

    line("system", `▶ running locally for "${msg.ticketTitle}"…`);
    const mcpUrl = msg.mcpPath ? new URL(msg.mcpPath, hostUrl).toString() : undefined;
    exitCode = await runClaude(
      workdir,
      msg,
      line,
      (c, n) => {
        costUsd = c;
        numTurns = n;
      },
      mcpUrl,
      token,
    );

    // Preserve the agent's own commit message(s) before flattening to a diff, so
    // the host can land the work under the wording the companion role asked for
    // (conventional commits, emoji, trailers) rather than a generic ticket title.
    const agentCommits = Number((await git(["rev-list", "--count", `${base}..HEAD`])).stdout.trim()) || 0;
    if (agentCommits > 0) {
      commitMessage = (await git(["log", "--format=%B", "--reverse", `${base}..HEAD`])).stdout.trim() || undefined;
    }

    // Capture anything the agent left uncommitted so the returned diff is complete.
    await git(["add", "-A"]);
    const pending = (await git(["diff", "--cached", "--name-only"])).stdout.trim();
    if (pending) await git([...id, "commit", "-q", "-m", agentCommits > 0 ? "chore: capture uncommitted changes" : "work"]);
    const { stdout: patch } = await git(["diff", "--binary", base, "HEAD"]);
    patchBase64 = Buffer.from(patch, "utf8").toString("base64");
    status = exitCode === 0 ? "done" : "failed";
    line("system", status === "done" ? "✓ done — returning patch" : "✖ run failed");
  } catch (e) {
    line("system", `✖ guest error: ${(e as Error).message}`);
    status = "failed";
  } finally {
    await fs.rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    socket.send(JSON.stringify({ t: "run-done", runId: msg.runId, status, exitCode, patchBase64, commitMessage, costUsd, numTurns }));
  }
}
