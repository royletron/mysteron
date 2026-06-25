import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Isolate settings.json under a temp MYSTERON_HOME.
const tmp = path.join(os.tmpdir(), `mysteron-auth-${process.pid}`);
process.env.MYSTERON_HOME = path.join(tmp, "home");

const {
  loadSettings,
  setPassword,
  setAuthEnabled,
  verifyPassword,
  authActive,
  mintGuestToken,
  clearGuestToken,
  verifyGuestToken,
} = await import("../src/core/settings.js");

test("fresh install: protection off, nothing set", async () => {
  const s = await loadSettings();
  assert.equal(s.auth.enabled, false);
  assert.equal(authActive(s), false);
  assert.equal(s.auth.hash, undefined);
});

test("setPassword stores a verifiable hash and enables protection", async () => {
  const { settings, id } = await setPassword("open-sesame");
  assert.ok(id && id.length >= 16);
  assert.equal(authActive(settings), true);
  assert.ok(settings.auth.hash && settings.auth.salt);
  assert.equal(verifyPassword(settings, "open-sesame"), true);
  assert.equal(verifyPassword(settings, "wrong"), false);
  // Persisted.
  const reloaded = await loadSettings();
  assert.equal(verifyPassword(reloaded, "open-sesame"), true);
  assert.equal(reloaded.auth.id, id);
});

test("changing the password rotates the credential id (invalidates cookies)", async () => {
  const before = (await loadSettings()).auth.id;
  const { id: after } = await setPassword("new-secret");
  assert.notEqual(after, before);
  const s = await loadSettings();
  assert.equal(verifyPassword(s, "new-secret"), true);
  assert.equal(verifyPassword(s, "open-sesame"), false);
});

test("toggle off keeps the hash; toggle on requires a password", async () => {
  let s = await setAuthEnabled(false);
  assert.equal(authActive(s), false);
  assert.ok(s.auth.hash, "hash retained while disabled");
  s = await setAuthEnabled(true);
  assert.equal(authActive(s), true);
});

test("guest token: mint → verify → clear", async () => {
  const { token } = await mintGuestToken();
  assert.ok(token && token.length >= 16);
  let s = await loadSettings();
  assert.equal(verifyGuestToken(s, token), true);
  assert.equal(verifyGuestToken(s, "not-the-token"), false);
  await clearGuestToken();
  s = await loadSettings();
  assert.equal(verifyGuestToken(s, token), false);
});

test("parseDuration handles units and defaults to minutes", async () => {
  const { parseDuration } = await import("../src/core/worker-protocol.js");
  assert.equal(parseDuration("90s"), 90_000);
  assert.equal(parseDuration("30m"), 30 * 60_000);
  assert.equal(parseDuration("2h"), 2 * 3_600_000);
  assert.equal(parseDuration("1d"), 86_400_000);
  assert.equal(parseDuration("5"), 5 * 60_000); // bare number → minutes
  assert.equal(parseDuration("nope"), undefined);
});

after(async () => {
  const { promises: fs } = await import("node:fs");
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});
