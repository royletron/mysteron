import { promises as fs } from "node:fs";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { mysteronHome } from "./paths.js";

/**
 * Global (per-machine) app settings, stored at ~/.mysteron/settings.json. Today
 * this is just optional password protection for the web UI.
 */
export interface AuthSettings {
  /** Whether password protection is currently gating requests. */
  enabled: boolean;
  /** scrypt hash of the password (hex). Absent until a password is set. */
  hash?: string;
  /** Per-password random salt (hex). */
  salt?: string;
  /**
   * Credential id — a random token regenerated every time the password changes.
   * Auth cookies carry this value; when it no longer matches, the cookie is
   * stale and the session is rejected (so changing the password signs everyone
   * out).
   */
  id?: string;
}

export interface GuestSettings {
  /** Shared token a guest must present to offer their machine as a worker. */
  token?: string;
}

export interface AppSettings {
  auth: AuthSettings;
  guest?: GuestSettings;
}

function settingsPath(): string {
  return path.join(mysteronHome(), "settings.json");
}

export async function loadSettings(): Promise<AppSettings> {
  try {
    const parsed = JSON.parse(await fs.readFile(settingsPath(), "utf8")) as Partial<AppSettings>;
    return { auth: { enabled: false, ...(parsed.auth ?? {}) }, guest: parsed.guest ?? {} };
  } catch {
    return { auth: { enabled: false }, guest: {} };
  }
}

export async function saveSettings(s: AppSettings): Promise<void> {
  await fs.mkdir(mysteronHome(), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(s, null, 2) + "\n", "utf8");
}

function hash(password: string, salt: string): Buffer {
  return scryptSync(password, salt, 32);
}

/**
 * Set (or change) the password. Mints a fresh credential id — invalidating any
 * existing cookies — and turns protection on. Returns the new credential id so
 * the caller can re-issue a cookie to the user making the change.
 */
export async function setPassword(password: string): Promise<{ settings: AppSettings; id: string }> {
  const s = await loadSettings();
  const salt = randomBytes(16).toString("hex");
  const id = randomBytes(24).toString("hex");
  s.auth = { enabled: true, salt, hash: hash(password, salt).toString("hex"), id };
  await saveSettings(s);
  return { settings: s, id };
}

/**
 * Turn protection on/off without touching the password. Disabling keeps the
 * stored hash so it can be re-enabled later; enabling requires a password.
 */
export async function setAuthEnabled(enabled: boolean): Promise<AppSettings> {
  const s = await loadSettings();
  if (enabled && !s.auth.hash) throw new Error("Set a password before enabling protection.");
  s.auth.enabled = enabled;
  await saveSettings(s);
  return s;
}

export function verifyPassword(s: AppSettings, password: string): boolean {
  if (!s.auth.hash || !s.auth.salt) return false;
  const expected = Buffer.from(s.auth.hash, "hex");
  const got = hash(password, s.auth.salt);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

/** Protection is actively gating requests (enabled AND fully configured). */
export function authActive(s: AppSettings): boolean {
  return Boolean(s.auth.enabled && s.auth.hash && s.auth.id);
}

// --- Guest worker join token -----------------------------------------------

export async function mintGuestToken(): Promise<{ settings: AppSettings; token: string }> {
  const s = await loadSettings();
  const token = randomBytes(18).toString("base64url");
  s.guest = { token };
  await saveSettings(s);
  return { settings: s, token };
}

export async function clearGuestToken(): Promise<AppSettings> {
  const s = await loadSettings();
  s.guest = {};
  await saveSettings(s);
  return s;
}

export function verifyGuestToken(s: AppSettings, token: string): boolean {
  const t = s.guest?.token;
  if (!t || !token) return false;
  const a = Buffer.from(t);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
