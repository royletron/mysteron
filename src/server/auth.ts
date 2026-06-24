import type { Express, Request, Response, NextFunction } from "express";
import {
  loadSettings,
  setAuthEnabled,
  setPassword,
  verifyPassword,
  authActive,
} from "../core/settings.js";

const COOKIE = "mysteron_auth";
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function cookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * Whether a request's cookie satisfies the current credential id. When
 * protection is off, everyone is "authed". Works off the raw cookie header so it
 * serves both Express requests and the WebSocket upgrade.
 */
export async function isAuthedByCookieHeader(cookieHeader?: string): Promise<boolean> {
  const s = await loadSettings();
  if (!authActive(s)) return true;
  return cookieValue(cookieHeader, COOKIE) === s.auth.id;
}

function setAuthCookie(res: Response, id: string): void {
  res.cookie(COOKIE, id, { httpOnly: true, sameSite: "lax", path: "/", maxAge: YEAR_MS });
}

/** Public auth state (never leaks the hash/salt/id). */
async function publicStatus(req: Request) {
  const s = await loadSettings();
  return {
    enabled: authActive(s),
    authed: await isAuthedByCookieHeader(req.headers.cookie),
    passwordSet: Boolean(s.auth.hash),
  };
}

/**
 * Registers the auth gate + endpoints. Must be called after express.json() and
 * before the project routes, so the gate runs first. The gate lets /api/auth/*
 * through (login/status/logout) and, while protection is off, lets everything
 * through (so the first password can be set).
 */
export function registerAuth(app: Express): void {
  app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith("/auth/")) return next();
    isAuthedByCookieHeader(req.headers.cookie)
      .then((ok) => (ok ? next() : res.status(401).json({ error: "authentication required" })))
      .catch(() => res.status(500).json({ error: "auth check failed" }));
  });

  app.get("/api/auth/status", async (req: Request, res: Response) => {
    res.json(await publicStatus(req));
  });

  app.post("/api/auth/login", async (req: Request, res: Response) => {
    const { password } = (req.body ?? {}) as { password?: string };
    const s = await loadSettings();
    if (!authActive(s)) return res.json({ ok: true }); // nothing to log into
    if (!password || !verifyPassword(s, password)) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    setAuthCookie(res, s.auth.id!);
    res.json({ ok: true });
  });

  app.post("/api/auth/logout", (_req: Request, res: Response) => {
    res.clearCookie(COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  // --- Global settings (gated like any other /api route) -------------------
  app.get("/api/settings", async (req: Request, res: Response) => {
    res.json({ auth: await publicStatus(req) });
  });

  // Set/change password, or toggle protection. When auth is already active this
  // route is gated, so the caller is authenticated. Setting a new password mints
  // a new credential id (signing others out) and re-cookies the current user.
  app.put("/api/settings/auth", async (req: Request, res: Response) => {
    const { password, enabled } = (req.body ?? {}) as { password?: string; enabled?: boolean };
    if (typeof password === "string" && password.length > 0) {
      const { id } = await setPassword(password);
      setAuthCookie(res, id); // keep the user who just set it logged in
    } else if (typeof enabled === "boolean") {
      try {
        await setAuthEnabled(enabled);
      } catch (e) {
        return res.status(400).json({ error: (e as Error).message });
      }
    } else {
      return res.status(400).json({ error: "Provide a password or an enabled flag." });
    }
    res.json({ auth: await publicStatus(req) });
  });
}
