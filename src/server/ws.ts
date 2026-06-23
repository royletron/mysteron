import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { bus, type AutopilotEvent, type HensonEvent, type RunEvent } from "../core/events.js";
import type { RunManager } from "../runner/manager.js";

/**
 * A single WebSocket per browser tab carries all live push data — global board/
 * autopilot events and per-run output — multiplexed by channel. WebSockets use a
 * separate, much larger browser connection pool than HTTP/1.1, so this never
 * starves the 6-per-origin budget that fetch/SSE share (the old lock-up).
 *
 * Client → server messages:
 *   { type: "sub-run", runId }     subscribe to a run's output (replays buffer)
 *   { type: "unsub-run", runId }   stop receiving that run
 * (every socket receives global events by default)
 *
 * Server → client messages:
 *   { channel: "global", evt }     a HensonEvent or AutopilotEvent
 *   { channel: "run", evt }        a RunEvent (kind: line | status | started)
 */
export function setupWebSocket(server: Server, runs: RunManager, verbose = false): void {
  const wss = new WebSocketServer({ server, path: "/ws" });

  // Fan global events out to every connected socket.
  const onHenson = (evt: HensonEvent) => broadcast({ channel: "global", evt });
  const onAutopilot = (evt: AutopilotEvent) => broadcast({ channel: "global", evt });
  const onRun = (evt: RunEvent) => {
    for (const c of clients) {
      if (c.runs.has(evt.runId)) send(c.socket, { channel: "run", evt });
    }
  };
  bus.on("henson", onHenson);
  bus.on("autopilot", onAutopilot);
  bus.on("run", onRun);

  interface Client {
    socket: WebSocket;
    runs: Set<string>;
  }
  const clients = new Set<Client>();

  function send(socket: WebSocket, msg: unknown): void {
    if (socket.readyState === socket.OPEN) {
      try {
        socket.send(JSON.stringify(msg));
      } catch {
        /* socket went away */
      }
    }
  }
  function broadcast(msg: unknown): void {
    for (const c of clients) send(c.socket, msg);
  }

  wss.on("connection", (socket) => {
    const client: Client = { socket, runs: new Set() };
    clients.add(client);
    if (verbose) console.log(`[henson] ws connect (${clients.size} open)`);

    socket.on("message", (raw) => {
      let msg: { type?: string; runId?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "sub-run" && msg.runId) {
        client.runs.add(msg.runId);
        // Replay the run's buffered output so a (re)subscriber catches up.
        const run = runs.get(msg.runId);
        if (run) {
          for (const line of run.lines) {
            send(socket, {
              channel: "run",
              evt: { kind: "line", runId: run.id, projectId: run.projectId, ticketId: run.ticketId, line, at: line.at },
            });
          }
          if (run.status !== "running") {
            send(socket, {
              channel: "run",
              evt: {
                kind: "status",
                runId: run.id,
                projectId: run.projectId,
                ticketId: run.ticketId,
                status: run.status,
                exitCode: run.exitCode,
                at: new Date().toISOString(),
              },
            });
          }
        }
      } else if (msg.type === "unsub-run" && msg.runId) {
        client.runs.delete(msg.runId);
      }
    });

    socket.on("close", () => {
      clients.delete(client);
      if (verbose) console.log(`[henson] ws close (${clients.size} open)`);
    });
    socket.on("error", () => clients.delete(client));

    send(socket, { channel: "hello", evt: { at: new Date().toISOString() } });
  });

  // Periodic heartbeat keeps intermediaries from dropping idle sockets.
  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (c.socket.readyState === c.socket.OPEN) c.socket.ping();
    }
  }, 30_000);
  wss.on("close", () => clearInterval(heartbeat));
}
