import { WebSocketServer, type WebSocket } from "ws";
import { nanoid } from "nanoid";
import { bus } from "../core/events.js";
import { loadSettings, verifyGuestToken } from "../core/settings.js";
import type { DispatchMsg, GuestMsg, GuestQuota, HostMsg } from "../core/worker-protocol.js";

export interface GuestRunResult {
  status: "done" | "failed" | "stopped";
  exitCode: number | null;
  patchBase64?: string;
  /** The commit message(s) the guest agent wrote, so the host lands under its own wording. */
  commitMessage?: string;
  costUsd?: number;
  numTurns?: number;
  /** True when the guest successfully pushed commits directly to the host via git-HTTP. */
  pushed?: boolean;
}

/** A connected guest worker, as exposed to the UI (no socket). */
export interface Worker {
  id: string;
  label: string;
  capacity: number;
  connectedAt: string;
  lastSeen: string;
  expiresAt: string;
  status: "idle" | "busy";
  /** The guest's latest Claude allowance, captured the same way the host captures its own. */
  quota?: GuestQuota;
  /** Mysteron version the guest is running (from its package.json). */
  version?: string;
  /** Short git sha of the guest's Mysteron checkout (absent for a packed install). */
  commitSha?: string;
}

const MAX_OFFER_MS = 24 * 60 * 60 * 1000; // cap an offer at a day
const STALE_MS = 60_000; // drop a worker we haven't heard from in a minute
const RECONNECT_GRACE_MS = 60_000; // how long to wait for a mid-run worker to reconnect

/**
 * Tracks guest workers that have dialled in to offer their machine + Claude
 * account. Phase 1: presence only (register, heartbeat, expiry). Dispatch of
 * actual ticket work lands in phase 2.
 */
export class WorkerRegistry {
  private workers = new Map<string, Worker & { socket: WebSocket; runId?: string }>();
  // Runs whose worker disconnected mid-run; values are grace-period timers that
  // fire onRunDone(failed) if no worker reconnects claiming the run in time.
  private pendingRuns = new Map<string, ReturnType<typeof setTimeout>>();

  /** Wired by the server to feed guest output/results into the RunManager. */
  onRunLine?: (runId: string, stream: "stdout" | "stderr" | "system", text: string) => void;
  onRunDone?: (runId: string, result: GuestRunResult) => void;

  list(): Worker[] {
    return [...this.workers.values()]
      .map(({ socket, runId, ...w }) => {
        void socket;
        void runId;
        return w;
      })
      .sort((a, b) => a.connectedAt.localeCompare(b.connectedAt));
  }

  /** Idle workers available to take a ticket. */
  idle(): Worker[] {
    return this.list().filter((w) => w.status === "idle");
  }

  /** Send a ticket to a worker; marks it busy. Returns false if it's gone/busy. */
  dispatch(workerId: string, msg: DispatchMsg): boolean {
    const w = this.workers.get(workerId);
    if (!w || w.status !== "idle") return false;
    w.status = "busy";
    w.runId = msg.runId;
    this.send(w.socket, msg);
    bus.emitWorkers();
    return true;
  }

  private remove(id: string, reason?: HostMsg): void {
    const w = this.workers.get(id);
    if (!w) return;
    if (reason) this.send(w.socket, reason);
    try {
      w.socket.close();
    } catch {
      /* already gone */
    }
    this.workers.delete(id);
    bus.emitWorkers();
  }

  private send(socket: WebSocket, msg: HostMsg): void {
    if (socket.readyState === socket.OPEN) {
      try {
        socket.send(JSON.stringify(msg));
      } catch {
        /* socket went away */
      }
    }
  }

  /** Periodically expire offers that have timed out or gone silent. */
  startSweeper(): () => void {
    const tick = () => {
      const now = Date.now();
      for (const w of [...this.workers.values()]) {
        const expired = Date.parse(w.expiresAt) <= now;
        const stale = now - Date.parse(w.lastSeen) > STALE_MS;
        if (expired) this.remove(w.id, { t: "expired" });
        else if (stale) this.remove(w.id);
      }
    };
    const timer = setInterval(tick, 15_000);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /**
   * The /worker WebSocketServer in `noServer` mode — index.ts routes the
   * upgrade to it by path (path-scoped servers sharing one HTTP server abort
   * each other's handshakes).
   */
  createWss(hostLabel: () => string, verbose = false): WebSocketServer {
    const wss = new WebSocketServer({ noServer: true });
    wss.on("connection", (socket: WebSocket) => {
      let id: string | undefined;

      socket.on("message", async (raw) => {
        let msg: GuestMsg;
        try {
          msg = JSON.parse(raw.toString()) as GuestMsg;
        } catch {
          return;
        }

        if (msg.t === "register") {
          const settings = await loadSettings();
          if (!verifyGuestToken(settings, msg.token)) {
            this.send(socket, { t: "rejected", reason: "Invalid or missing guest token." });
            socket.close();
            return;
          }
          id = nanoid(10);
          const now = new Date();
          const ttl = Math.min(Math.max(msg.expiresInMs || 0, 60_000), MAX_OFFER_MS);
          const expiresAt = new Date(now.getTime() + ttl).toISOString();
          // If reconnecting mid-run, cancel the grace timer and re-attach the run.
          const resumedRunId = msg.resumeRunId && this.pendingRuns.has(msg.resumeRunId) ? msg.resumeRunId : undefined;
          if (resumedRunId) {
            clearTimeout(this.pendingRuns.get(resumedRunId)!);
            this.pendingRuns.delete(resumedRunId);
            if (verbose) console.log(`[mysteron] guest reconnected mid-run: ${msg.label} (${id}), run ${resumedRunId}`);
          }
          this.workers.set(id, {
            id,
            socket,
            label: msg.label || "guest",
            capacity: Math.max(1, Math.floor(msg.capacity || 1)),
            connectedAt: now.toISOString(),
            lastSeen: now.toISOString(),
            expiresAt,
            status: resumedRunId ? "busy" : "idle",
            runId: resumedRunId,
            version: msg.version,
            commitSha: msg.commitSha,
          });
          this.send(socket, { t: "registered", workerId: id, hostLabel: hostLabel(), expiresAt });
          if (verbose && !resumedRunId) console.log(`[mysteron] guest joined: ${msg.label} (${id}), expires ${expiresAt}`);
          bus.emitWorkers();
        } else if (msg.t === "heartbeat" && id) {
          const w = this.workers.get(id);
          if (w) w.lastSeen = new Date().toISOString();
        } else if (msg.t === "quota" && id) {
          const w = this.workers.get(id);
          if (w) {
            w.lastSeen = new Date().toISOString();
            w.quota = msg.quota;
            bus.emitWorkers();
          }
        } else if (msg.t === "run-line" && id) {
          const w = this.workers.get(id);
          if (w) w.lastSeen = new Date().toISOString();
          this.onRunLine?.(msg.runId, msg.stream, msg.text);
        } else if (msg.t === "run-done" && id) {
          const w = this.workers.get(id);
          if (w) {
            w.status = "idle";
            w.runId = undefined;
            bus.emitWorkers();
          }
          this.onRunDone?.(msg.runId, {
            status: msg.status,
            exitCode: msg.exitCode,
            patchBase64: msg.patchBase64,
            commitMessage: msg.commitMessage,
            costUsd: msg.costUsd,
            numTurns: msg.numTurns,
            pushed: msg.pushed,
          });
        }
      });

      const drop = () => {
        if (!id) return;
        const w = this.workers.get(id);
        if (w?.runId) {
          // Give the worker time to reconnect and resume rather than immediately failing.
          const runId = w.runId;
          const timer = setTimeout(() => {
            this.pendingRuns.delete(runId);
            this.onRunDone?.(runId, { status: "failed", exitCode: null });
          }, RECONNECT_GRACE_MS);
          timer.unref?.();
          this.pendingRuns.set(runId, timer);
        }
        if (this.workers.delete(id)) bus.emitWorkers();
      };
      socket.on("close", drop);
      socket.on("error", drop);
    });
    return wss;
  }
}
