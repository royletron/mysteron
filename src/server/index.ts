import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectWatcher } from "../core/watcher.js";
import { bus, type RunEvent } from "../core/events.js";
import { binStaleDone } from "../core/board.js";
import { loadRegistry } from "../core/registry.js";
import { RunManager } from "../runner/manager.js";
import { Autopilot } from "../runner/autopilot.js";
import { registerApi } from "./api.js";
import { setupWebSocket } from "./ws.js";
import { startRateLimitProxy, type RateLimitProxy } from "../plugins/usage-monitor/proxy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Locate the built web UI. The Vite build outputs to dist/server/public, so it
 * sits next to this file when running from dist, or under repo/dist when running
 * from src via tsx. Run `npm run build` (or `npm run dev:web` for HMR) first.
 */
function publicDir(): string {
  const candidates = [
    path.join(__dirname, "public"), // dist/server/public (built / production)
    path.join(__dirname, "..", "..", "dist", "server", "public"), // tsx from src/server
  ];
  return candidates.find((c) => existsSync(c)) ?? candidates[0];
}

export interface ServeOptions {
  port?: number;
  host?: string;
  verbose?: boolean;
}

export async function serve(opts: ServeOptions = {}): Promise<{ port: number; close: () => Promise<void> }> {
  const port = opts.port ?? Number(process.env.MYSTERON_PORT ?? 4319);
  const host = opts.host ?? process.env.MYSTERON_HOST ?? "127.0.0.1";
  const verbose = opts.verbose ?? Boolean(process.env.MYSTERON_VERBOSE);

  const watcher = new ProjectWatcher();
  await watcher.start();

  // Capture proxy for real Claude usage limits. We route spawned `claude`
  // traffic through it (see runner/manager.ts) so we can read the
  // `anthropic-ratelimit-unified-*` response headers — the only source of true
  // session/weekly utilization. Opt out with MYSTERON_RATELIMIT_PROXY=0. A failure
  // here must never stop the server: we just fall back to the JSONL estimate.
  let rateLimitProxy: RateLimitProxy | undefined;
  if (process.env.MYSTERON_RATELIMIT_PROXY !== "0") {
    try {
      rateLimitProxy = await startRateLimitProxy();
      // The child env var the run manager reads (kept separate from
      // ANTHROPIC_BASE_URL so the proxy's own upstream isn't pointed at itself).
      process.env.MYSTERON_RATELIMIT_PROXY_URL = rateLimitProxy.url;
      if (verbose) console.log(`[mysteron] rate-limit capture proxy at ${rateLimitProxy.url}`);
    } catch (err) {
      console.warn(`[mysteron] rate-limit proxy failed to start: ${(err as Error).message}`);
    }
  }

  const runs = new RunManager();
  // Load persisted agent-run history so a ticket's past runs survive restarts.
  const registry = await loadRegistry();
  const loaded = await runs.hydrate(registry.projects.map((p) => ({ projectId: p.id, projectRoot: p.path })));
  if (verbose && loaded) console.log(`[mysteron] loaded ${loaded} persisted run(s)`);
  const autopilot = new Autopilot(runs);

  // Sweep tickets that have sat in "done" for 48h into the bin — now and hourly.
  const sweepBins = async () => {
    const reg = await loadRegistry();
    for (const p of reg.projects) {
      try {
        const moved = await binStaleDone(p.path);
        if (moved) bus.emitEvent({ type: "board-changed", projectId: p.id });
      } catch {
        /* one bad project must not stop the sweep */
      }
    }
  };
  void sweepBins();
  const binTimer = setInterval(() => void sweepBins(), 60 * 60 * 1000);
  binTimer.unref?.();

  if (verbose) {
    bus.on("mysteron", (e) => console.log("[mysteron] event", e));
    bus.on("autopilot", (e) => console.log("[mysteron] autopilot", e));
    bus.on("run", (e: RunEvent) => {
      if (e.kind === "status") console.log(`[mysteron] run ${e.runId} → ${e.status} (exit ${e.exitCode})`);
      else if (e.kind === "line" && e.line?.stream === "system") console.log(`[mysteron] run ${e.runId}: ${e.line.text}`);
    });
  }

  const app = express();
  registerApi(app, watcher, runs, autopilot, { verbose });
  // Vite content-hashes assets (safe to cache forever); index.html references
  // them, so it must never be cached or a rebuild won't be picked up.
  app.use(
    express.static(publicDir(), {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith("index.html")) {
          res.setHeader("Cache-Control", "no-cache");
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }),
  );

  return new Promise((resolveServer) => {
    const server = app.listen(port, host, () => {
      // eslint-disable-next-line no-console
      console.log(`🎭  Mysteron is running at http://${host}:${port}${verbose ? "  (verbose)" : ""}`);
      resolveServer({
        port,
        close: async () => {
          clearInterval(binTimer);
          await watcher.stop();
          await rateLimitProxy?.close();
          await new Promise<void>((r) => server.close(() => r()));
        },
      });
    });
    // Live updates ride a single WebSocket per tab (separate from the HTTP pool).
    setupWebSocket(server, runs, verbose);
  });
}
