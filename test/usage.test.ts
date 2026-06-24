import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Isolate the snapshot file under a temp MYSTERON_HOME.
const tmp = path.join(os.tmpdir(), `mysteron-usage-${process.pid}`);
process.env.MYSTERON_HOME = path.join(tmp, "home");

const { parseUnifiedLimits, extractRateLimitHeaders, readSnapshot } = await import(
  "../src/plugins/usage-monitor/snapshot.js"
);
const { startRateLimitProxy } = await import("../src/plugins/usage-monitor/proxy.js");
const { detectAccount, _resetAccountCache } = await import("../src/plugins/usage-monitor/account.js");

test("extractRateLimitHeaders keeps only anthropic-ratelimit-* (lowercased)", () => {
  const got = extractRateLimitHeaders({
    "Content-Type": "application/json",
    "Anthropic-RateLimit-Unified-5h-Utilization": "0.42",
    "anthropic-ratelimit-unified-7d-status": "allowed",
    "x-request-id": "abc",
  });
  assert.deepEqual(got, {
    "anthropic-ratelimit-unified-5h-utilization": "0.42",
    "anthropic-ratelimit-unified-7d-status": "allowed",
  });
});

test("parseUnifiedLimits maps 0–1 utilization to 0–100 and parses resets", () => {
  const epoch = 1_900_000_000; // seconds
  const u = parseUnifiedLimits({
    "anthropic-ratelimit-unified-status": "allowed_warning",
    "anthropic-ratelimit-unified-5h-utilization": "0.73",
    "anthropic-ratelimit-unified-5h-status": "allowed",
    "anthropic-ratelimit-unified-5h-reset": String(epoch),
    "anthropic-ratelimit-unified-7d-utilization": "0.1",
    "anthropic-ratelimit-unified-7d-status": "allowed",
  });
  assert.ok(u);
  assert.equal(u!.status, "allowed_warning");
  assert.equal(u!.session?.utilizationPct, 73);
  assert.equal(u!.session?.status, "allowed");
  assert.equal(u!.session?.resetAt, new Date(epoch * 1000).toISOString());
  assert.equal(u!.weekly?.utilizationPct, 10);
});

test("parseUnifiedLimits returns undefined without unified headers (e.g. API key)", () => {
  assert.equal(parseUnifiedLimits({ "anthropic-ratelimit-requests-limit": "50" }), undefined);
  assert.equal(parseUnifiedLimits({}), undefined);
});

test("account detection: explicit API key wins", async () => {
  _resetAccountCache();
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  try {
    const a = await detectAccount();
    assert.equal(a.kind, "api-key");
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev;
  }
});

test("account detection: unified-header hint short-circuits to subscription", async () => {
  _resetAccountCache();
  const a = await detectAccount(true);
  assert.equal(a.kind, "subscription");
});

test("proxy forwards requests and captures rate-limit headers to a snapshot", async () => {
  // Fake upstream that returns unified rate-limit headers.
  const upstream = http.createServer((req, res) => {
    res.setHeader("anthropic-ratelimit-unified-status", "allowed");
    res.setHeader("anthropic-ratelimit-unified-5h-utilization", "0.5");
    res.setHeader("anthropic-ratelimit-unified-5h-status", "allowed");
    res.setHeader("anthropic-ratelimit-unified-7d-utilization", "0.2");
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamPort = (upstream.address() as import("node:net").AddressInfo).port;

  const proxy = await startRateLimitProxy({ upstream: `http://127.0.0.1:${upstreamPort}` });
  try {
    const body = await new Promise<string>((resolve, reject) => {
      http
        .get(`${proxy.url}/v1/messages`, (res) => {
          let s = "";
          res.on("data", (c) => (s += c));
          res.on("end", () => resolve(s));
        })
        .on("error", reject);
    });
    assert.deepEqual(JSON.parse(body), { ok: true, path: "/v1/messages" });

    // The snapshot write is fire-and-forget; poll briefly for it to land.
    let snap = await readSnapshot();
    for (let i = 0; i < 50 && !snap; i++) {
      await new Promise((r) => setTimeout(r, 20));
      snap = await readSnapshot();
    }
    assert.ok(snap, "snapshot written");
    assert.equal(snap!.unified?.session?.utilizationPct, 50);
    assert.equal(snap!.unified?.weekly?.utilizationPct, 20);
    assert.equal(snap!.raw["anthropic-ratelimit-unified-status"], "allowed");
  } finally {
    await proxy.close();
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});

after(async () => {
  const { promises: fs } = await import("node:fs");
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});
