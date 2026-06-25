import os from "node:os";
import WebSocket from "ws";
import type { HostMsg } from "../core/worker-protocol.js";

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
