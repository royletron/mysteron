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

export interface JoinOptions {
  hostUrl: string;
  token?: string;
  label?: string;
  /** Offer duration in ms (default 2h). */
  forMs?: number;
  capacity?: number;
}

/** http(s)://host  →  ws(s)://host/worker */
function workerWsUrl(hostUrl: string): string {
  const u = new URL(hostUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/worker";
  u.search = "";
  return u.toString();
}

/**
 * Offer this machine to a host as a guest worker. Phase 1: connect, register a
 * time-boxed offer, and hold the connection open (heartbeating) until the offer
 * expires or the user quits. Reconnects on a dropped socket.
 */
export async function joinHost(opts: JoinOptions): Promise<void> {
  if (!opts.token) throw new Error("join requires --token <guest-token> (get it from the host's Settings)");
  const wsUrl = workerWsUrl(opts.hostUrl);
  const label = opts.label || os.hostname();
  const capacity = Math.max(1, opts.capacity ?? 1);
  const forMs = opts.forMs ?? 2 * 60 * 60 * 1000;
  const deadline = Date.now() + forMs;

  let stopped = false;
  let socket: WebSocket | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const log = (s: string) => console.log(`[guest] ${s}`);

  const stop = (msg: string, code = 0) => {
    if (stopped) return;
    stopped = true;
    if (heartbeat) clearInterval(heartbeat);
    try {
      socket?.close();
    } catch {
      /* already closed */
    }
    log(msg);
    process.exitCode = code;
  };

  process.on("SIGINT", () => stop("Stopped — offer withdrawn.", 0));

  const connect = () => {
    if (stopped) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return stop("Offer window elapsed — disconnected.");

    socket = new WebSocket(wsUrl);

    socket.on("open", () => {
      socket!.send(
        JSON.stringify({ t: "register", token: opts.token, label, capacity, expiresInMs: remaining }),
      );
      heartbeat = setInterval(() => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: "heartbeat" }));
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
        log(`offered to "${msg.projectName}" as "${label}" (×${capacity}) until ${new Date(msg.expiresAt).toLocaleString()}.`);
        log("Waiting for work… (Ctrl-C to withdraw)");
      } else if (msg.t === "rejected") {
        stop(`Rejected: ${msg.reason}`, 1);
      } else if (msg.t === "expired") {
        stop("Offer expired on the host — disconnected.");
      } else if (msg.t === "dispatch" && socket) {
        log(`↘ ticket: ${msg.ticketTitle}`);
        void handleDispatch(socket, msg, opts.hostUrl, opts.token!);
      }
    });

    socket.on("close", () => {
      if (heartbeat) clearInterval(heartbeat);
      if (stopped) return;
      // Reconnect after a short delay until the offer window elapses.
      if (deadline - Date.now() > 0) {
        log("Disconnected — retrying in 3s…");
        setTimeout(connect, 3000);
      } else {
        stop("Offer window elapsed — disconnected.");
      }
    });

    socket.on("error", (err) => {
      log(`connection error: ${(err as Error).message}`);
      // 'close' fires next and handles retry.
    });
  };

  log(`Connecting to ${opts.hostUrl} …`);
  connect();

  // Hard stop when the window elapses even if idle.
  const endTimer = setTimeout(() => stop("Offer window elapsed — disconnected."), forMs);
  endTimer.unref?.();

  // Keep the process alive until stopped.
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (stopped) {
        clearInterval(check);
        resolve();
      }
    }, 500);
    check.unref?.();
  });
}

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
): Promise<number | null> {
  return new Promise((resolve) => {
    const mode = msg.yolo ? "bypassPermissions" : "acceptEdits";
    const args = ["-p", msg.prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", mode];
    if (msg.disallowedTools.length) args.push("--disallowedTools", ...msg.disallowedTools);
    if (msg.allowedTools.length) args.push("--allowedTools", ...msg.allowedTools);

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
  let costUsd: number | undefined;
  let numTurns: number | undefined;

  try {
    await fs.mkdir(workdir, { recursive: true });
    line("system", "⤓ fetching workspace snapshot…");
    const tar = path.join(workdir, "_snapshot.tar");
    await downloadTo(new URL(msg.snapshotPath, hostUrl).toString(), token, tar);
    await pexec("tar", ["-xf", tar, "-C", workdir]);
    await fs.rm(tar, { force: true });

    // A base commit so we can diff what the agent changes.
    await git(["init", "-q"]);
    await git(["add", "-A"]);
    await git([...id, "commit", "-q", "-m", "base", "--allow-empty"]);
    const base = (await git(["rev-parse", "HEAD"])).stdout.trim();

    line("system", `▶ running locally for "${msg.ticketTitle}"…`);
    exitCode = await runClaude(workdir, msg, line, (c, n) => {
      costUsd = c;
      numTurns = n;
    });

    await git(["add", "-A"]);
    await git([...id, "commit", "-q", "-m", "work", "--allow-empty"]);
    const { stdout: patch } = await git(["diff", "--binary", base, "HEAD"]);
    patchBase64 = Buffer.from(patch, "utf8").toString("base64");
    status = exitCode === 0 ? "done" : "failed";
    line("system", status === "done" ? "✓ done — returning patch" : "✖ run failed");
  } catch (e) {
    line("system", `✖ guest error: ${(e as Error).message}`);
    status = "failed";
  } finally {
    await fs.rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    socket.send(JSON.stringify({ t: "run-done", runId: msg.runId, status, exitCode, patchBase64, costUsd, numTurns }));
  }
}
