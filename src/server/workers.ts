import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { nanoid } from "nanoid";
import { bus } from "../core/events.js";
import { loadSettings, verifyGuestToken } from "../core/settings.js";
import type { GuestMsg, HostMsg } from "../core/worker-protocol.js";

/** A connected guest worker, as exposed to the UI (no socket). */
export interface Worker {
  id: string;
  label: string;
  capacity: number;
  connectedAt: string;
  lastSeen: string;
  expiresAt: string;
  status: "idle" | "busy";
}

const MAX_OFFER_MS = 24 * 60 * 60 * 1000; // cap an offer at a day
const STALE_MS = 60_000; // drop a worker we haven't heard from in a minute

/**
 * Tracks guest workers that have dialled in to offer their machine + Claude
 * account. Phase 1: presence only (register, heartbeat, expiry). Dispatch of
 * actual ticket work lands in phase 2.
 */
export class WorkerRegistry {
  private workers = new Map<string, Worker & { socket: WebSocket }>();

  list(): Worker[] {
    return [...this.workers.values()]
      .map(({ socket, ...w }) => {
        void socket;
        return w;
      })
      .sort((a, b) => a.connectedAt.localeCompare(b.connectedAt));
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

  attach(server: Server, projectName: () => string, verbose = false): void {
    const wss = new WebSocketServer({ server, path: "/worker" });
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
          this.workers.set(id, {
            id,
            socket,
            label: msg.label || "guest",
            capacity: Math.max(1, Math.floor(msg.capacity || 1)),
            connectedAt: now.toISOString(),
            lastSeen: now.toISOString(),
            expiresAt,
            status: "idle",
          });
          this.send(socket, { t: "registered", workerId: id, projectName: projectName(), expiresAt });
          if (verbose) console.log(`[mysteron] guest joined: ${msg.label} (${id}), expires ${expiresAt}`);
          bus.emitWorkers();
        } else if (msg.t === "heartbeat" && id) {
          const w = this.workers.get(id);
          if (w) w.lastSeen = new Date().toISOString();
        }
      });

      const drop = () => {
        if (id && this.workers.delete(id)) bus.emitWorkers();
      };
      socket.on("close", drop);
      socket.on("error", drop);
    });
  }
}
