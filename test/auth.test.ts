import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Isolate settings.json under a temp MYSTERON_HOME.
const tmp = path.join(os.tmpdir(), `mysteron-auth-${process.pid}`);
process.env.MYSTERON_HOME = path.join(tmp, "home");

const { loadSettings, setPassword, setAuthEnabled, verifyPassword, authActive } = await import(
  "../src/core/settings.js"
);

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

after(async () => {
  const { promises: fs } = await import("node:fs");
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});
