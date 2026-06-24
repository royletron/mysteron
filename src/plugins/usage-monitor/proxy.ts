import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import {
  extractRateLimitHeaders,
  parseUnifiedLimits,
  writeSnapshot,
  type RateLimitSnapshot,
} from "./snapshot.js";

/**
 * A tiny pass-through reverse proxy that sits between Claude Code and Anthropic.
 *
 * Why: the real, authoritative usage numbers (5h-session + weekly utilization,
 * reset times, status) only come back as `anthropic-ratelimit-unified-*` HTTP
 * response headers, which Claude Code keeps in memory and never exposes. Since
 * Mysteron is the one launching `claude`, we route its traffic through this proxy
 * (via ANTHROPIC_BASE_URL) and skim those headers off real responses — no extra
 * quota spent, no keychain hacking, and it works for any account type.
 *
 * It forwards everything untouched (method, path, headers, body, streaming SSE)
 * to the upstream — it only *reads* response headers on the way back.
 */
export interface RateLimitProxy {
  /** Base URL to hand to Claude Code via ANTHROPIC_BASE_URL. */
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Default upstream: the user's own base URL if set, else the public API. */
function defaultUpstream(): string {
  return process.env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com";
}

// Throttle snapshot writes: rate-limit headers ride every response, but the
// numbers only move meaningfully every few seconds.
const MIN_WRITE_INTERVAL_MS = 3000;

export async function startRateLimitProxy(opts: {
  upstream?: string;
  host?: string;
  port?: number;
} = {}): Promise<RateLimitProxy> {
  const upstream = new URL(opts.upstream ?? defaultUpstream());
  const host = opts.host ?? "127.0.0.1";
  const isHttps = upstream.protocol === "https:";
  const transport = isHttps ? https : http;
  const upstreamPort = upstream.port || (isHttps ? 443 : 80);

  let lastWrite = 0;

  const capture = (headers: http.IncomingHttpHeaders): void => {
    const raw = extractRateLimitHeaders(headers);
    if (Object.keys(raw).length === 0) return; // not an Anthropic API response
    const now = Date.now();
    if (now - lastWrite < MIN_WRITE_INTERVAL_MS) return;
    lastWrite = now;
    const snap: RateLimitSnapshot = {
      capturedAt: new Date(now).toISOString(),
      raw,
      unified: parseUnifiedLimits(raw),
    };
    void writeSnapshot(snap);
  };

  const server = http.createServer((req, res) => {
    const target = new URL(req.url ?? "/", "http://localhost");
    const proxyReq = transport.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstreamPort,
        method: req.method,
        path: target.pathname + target.search,
        // Forward headers verbatim, but rewrite Host to the upstream so TLS/SNI
        // and virtual-hosting line up.
        headers: { ...req.headers, host: upstream.host },
      },
      (proxyRes) => {
        capture(proxyRes.headers);
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on("error", (err) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`mysteron rate-limit proxy: upstream error: ${err.message}`);
    });
    req.pipe(proxyReq);
  });

  // Long SSE streams must not be cut off by an idle timeout.
  server.timeout = 0;
  server.requestTimeout = 0;
  server.headersTimeout = 0;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://${host}:${port}`,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
