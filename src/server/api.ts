import express, { type Express, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  bus,
  discoverProjectDocs,
  addAttachment,
  removeAttachment,
  readAttachment,
  createTicket,
  deleteTicket,
  getTicket,
  listDocs,
  listMemories,
  listTickets,
  listTicketsEnriched,
  moveTicketsByState,
  reorderTickets,
  loadProjectConfig,
  readDoc,
  updateTicket,
  writeDoc,
  generateCompanion,
  regenerateCompanion,
  buildRoster,
  seedCompanionSpecs,
  readCompanionSpec,
  writeCompanionSpec,
  recentCommits,
  getCompanion,
  defaultCompanion,
  companionAllowsLocal,
  companionAllowsGuest,
  companionHasHostPins,
  hostsUnavailableMessage,
  type ProjectConfig,
  type RegistryEntry,
} from "../core/index.js";
import { findEntry, loadRegistry, unregisterProject } from "../core/registry.js";
import { initProject, saveProjectConfig } from "../core/project.js";
import { RECIPES, findRecipe } from "../core/recipes.js";
import { BOARD_STATES, TICKET_STATES, type TicketState } from "../core/types.js";
import { allPlugins, enabledPlugins } from "../plugins/manager.js";
import { usageMonitorPlugin } from "../plugins/usage-monitor/index.js";
import { deleteSnapshot } from "../plugins/usage-monitor/snapshot.js";
import type { ProjectWatcher } from "../core/watcher.js";
import { type RunManager, runSummary, CompanionBusyError, agentAvailable, agentUnavailableMessage } from "../runner/manager.js";
import { checkUsageBudget } from "../runner/budget.js";
import type { Autopilot } from "../runner/autopilot.js";
import type { RunEvent } from "../core/events.js";
import { registerAuth } from "./auth.js";
import { createWorkerMcp } from "./worker-mcp.js";
import type { WorkerRegistry } from "./workers.js";
import type { GuestController } from "./guest-controller.js";
import { loadSettings, verifyGuestToken } from "../core/settings.js";
import { workingTreeRef, listBranches, currentBranch, mergeBranch, deleteBranch, originStatus, pushCurrentBranch } from "../core/git.js";

interface ResolvedProject {
  entry: RegistryEntry;
  config: ProjectConfig;
}

async function resolve(id: string): Promise<ResolvedProject | undefined> {
  const entry = await findEntry(id);
  if (!entry) return undefined;
  const config = await loadProjectConfig(entry.path);
  if (!config) return undefined;
  return { entry, config };
}

function notFound(res: Response): Response {
  return res.status(404).json({ error: "not found" });
}

/** Write to an SSE stream, swallowing errors from a client that has gone away. */
function sseWrite(res: Response, chunk: string): void {
  try {
    res.write(chunk);
  } catch {
    /* client disconnected; the "close" handler will clean up listeners */
  }
}

export interface ApiOptions {
  verbose?: boolean;
}

export function registerApi(
  app: Express,
  watcher: ProjectWatcher,
  runs: RunManager,
  autopilot: Autopilot,
  workers: WorkerRegistry,
  guest: GuestController,
  opts: ApiOptions = {},
): void {
  const verbose = opts.verbose ?? false;

  // Express 4 does not catch rejections from async route handlers — the request
  // just hangs (and the UI sits on "Loading…" forever). Wrap each handler so any
  // rejection is forwarded to the error middleware below.
  const methods = ["get", "post", "put", "patch", "delete"] as const;
  const router = app as unknown as Record<string, (path: string, ...h: unknown[]) => unknown>;
  for (const m of methods) {
    const orig = router[m].bind(app);
    router[m] = (path: string, ...handlers: unknown[]) =>
      orig(
        path,
        ...handlers.map((h) => (req: Request, res: Response, next: (e?: unknown) => void) =>
          Promise.resolve((h as (...a: unknown[]) => unknown)(req, res, next)).catch(next),
        ),
      );
  }

  app.use(express.json({ limit: "4mb" }));

  if (verbose) {
    app.use((req: Request, res: Response, next: () => void) => {
      const t = Date.now();
      res.on("finish", () =>
        console.log(`[mysteron] ${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - t}ms)`),
      );
      next();
    });
  }

  // Optional password protection: gates every /api route (except /api/auth/*)
  // and exposes the login/logout/settings endpoints. Registered before the
  // project routes so the gate runs first.
  registerAuth(app);

  // --- Guest workers -------------------------------------------------------
  app.get("/api/workers", (_req: Request, res: Response) => {
    res.json({ workers: workers.list() });
  });

  // The project's MCP (board / docs / memory) served to a guest over HTTP, so a
  // guest agent works against the host's live board (the snapshot it runs in only
  // carries tracked files). Scoped to the run's project and gated by guest token.
  const workerMcp = createWorkerMcp(runs);
  app.post("/api/worker/mcp/:runId", (req, res) => void workerMcp.post(req, res));
  app.get("/api/worker/mcp/:runId", (req, res) => void workerMcp.session(req, res));
  app.delete("/api/worker/mcp/:runId", (req, res) => void workerMcp.session(req, res));

  // A guest fetches the working-tree snapshot for a run it was dispatched. Gated
  // by the guest token (this path bypasses the password cookie gate).
  app.get("/api/worker/snapshot/:runId", async (req: Request, res: Response) => {
    const token = (req.header("x-mysteron-guest-token") || req.query.token || "").toString();
    const settings = await loadSettings();
    if (!verifyGuestToken(settings, token)) return res.status(401).json({ error: "invalid guest token" });
    const run = runs.get(req.params.runId);
    if (!run) return notFound(res);
    // Serve the exact state pinned at dispatch (so the guest diffs against, and we
    // later 3-way-merge from, the same base); fall back for older runs.
    const ref = run.baseRef ?? (await workingTreeRef(run.projectRoot));
    res.setHeader("content-type", "application/x-tar");
    // `git archive` of the working-tree ref → a tar of tracked files at their
    // current (incl. uncommitted) content.
    const child = spawn("git", ["-C", run.projectRoot, "archive", "--format=tar", ref]);
    child.stdout.pipe(res);
    child.stderr.resume();
    child.on("error", () => {
      if (!res.headersSent) res.status(500);
      res.end();
    });
  });

  // A read-only board snapshot for a guest to view in their own app (token-gated).
  app.get("/api/worker/board", async (req: Request, res: Response) => {
    const token = (req.header("x-mysteron-guest-token") || req.query.token || "").toString();
    const settings = await loadSettings();
    if (!verifyGuestToken(settings, token)) return res.status(401).json({ error: "invalid guest token" });
    const reg = await loadRegistry();
    const projects = [];
    for (const entry of reg.projects) {
      const tickets = await listTickets(entry.path);
      projects.push({
        id: entry.id,
        name: entry.name,
        tickets: tickets.map((t) => ({
          id: t.id,
          title: t.title,
          state: t.state,
          priority: t.priority,
          assignee: t.assignee,
        })),
      });
    }
    res.json({ projects });
  });

  // --- This machine offering itself as a guest to a host -------------------
  app.get("/api/guest", (_req: Request, res: Response) => {
    res.json({ guest: guest.status() ?? null });
  });

  app.post("/api/guest", (req: Request, res: Response) => {
    const { hostUrl, token, forMs, name, capacity } = (req.body ?? {}) as {
      hostUrl?: string;
      token?: string;
      forMs?: number;
      name?: string;
      capacity?: number;
    };
    if (!hostUrl || !token) return res.status(400).json({ error: "hostUrl and token are required" });
    try {
      const status = guest.start({ hostUrl, token, label: name, forMs, capacity });
      res.json({ guest: status });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.delete("/api/guest", (_req: Request, res: Response) => {
    guest.stop();
    res.json({ ok: true });
  });

  // Proxy the host's board so the guest can see it in their own app.
  app.get("/api/guest/board", async (_req: Request, res: Response) => {
    const conn = guest.connection;
    if (!conn) return res.json({ projects: [] });
    try {
      const r = await fetch(new URL("/api/worker/board", conn.hostUrl).toString(), {
        headers: { "x-mysteron-guest-token": conn.token },
      });
      if (!r.ok) return res.status(502).json({ error: `host board fetch failed (${r.status})` });
      res.json(await r.json());
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  });

  // --- Projects ------------------------------------------------------------
  app.get("/api/projects", async (_req: Request, res: Response) => {
    const reg = await loadRegistry();
    const pending = new Set(watcher.pendingSyncs().map((p) => p.projectId));
    const projects = [];
    for (const entry of reg.projects) {
      const config = await loadProjectConfig(entry.path);
      const tickets = config ? await listTickets(entry.path) : [];
      const counts: Record<string, number> = {};
      for (const s of TICKET_STATES) counts[s] = 0;
      for (const t of tickets) counts[t.state]++;
      projects.push({
        ...entry,
        recipe: config?.recipe,
        companions: config?.companions ?? [],
        yolo: config?.yolo ?? false,
        plugins: config?.plugins ?? [],
        counts,
        pendingDocSync: pending.has(entry.id),
        autopilot: autopilot.status(entry.id)?.status ?? "stopped",
        valid: Boolean(config),
      });
    }
    res.json({ projects });
  });

  // Preview the docs that init would import from a given path.
  app.post("/api/discover", async (req: Request, res: Response) => {
    const { path: projectPath } = req.body ?? {};
    if (!projectPath || typeof projectPath !== "string") {
      return res.status(400).json({ error: "path is required" });
    }
    try {
      res.json({ docs: await discoverProjectDocs(projectPath) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/projects/init", async (req: Request, res: Response) => {
    const { path: projectPath, name, importDocs, recipe } = req.body ?? {};
    if (!projectPath || typeof projectPath !== "string") {
      return res.status(400).json({ error: "path is required" });
    }
    if (recipe && !findRecipe(recipe)) {
      return res.status(400).json({ error: `unknown recipe: ${recipe}` });
    }
    try {
      const result = await initProject(projectPath, { name, importDocs, recipe });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.delete("/api/projects/:id", async (req: Request, res: Response) => {
    const ok = await unregisterProject(req.params.id);
    res.json({ ok });
  });

  app.get("/api/projects/:id", async (req: Request, res: Response) => {
    const r = await resolve(req.params.id);
    if (!r) return notFound(res);
    const tickets = await listTicketsEnriched(r.entry.path);
    const board: Record<string, typeof tickets> = {};
    for (const s of TICKET_STATES) board[s] = [];
    for (const t of tickets) board[t.state].push(t);
    res.json({
      entry: r.entry,
      config: r.config,
      board,
      states: BOARD_STATES,
      docs: await listDocs(r.entry.path),
      memories: await listMemories(r.entry.path),
      pendingDocSync: watcher.pendingSyncs().some((p) => p.projectId === r.entry.id),
      autopilot: autopilot.status(r.entry.id) ?? { status: "stopped", message: "", completed: 0, activity: [] },
      busyCompanions: runs.busyCompanionIds(r.entry.id),
      activeRuns: runs.listByProject(r.entry.id).filter((x) => x.status === "running").map(runSummary),
    });
  });

  app.post("/api/projects/:id/sync-clear", async (req: Request, res: Response) => {
    watcher.clearPending(req.params.id);
    res.json({ ok: true });
  });

  // Recent git commits, with companions attributed via the Mysteron-Companion trailer.
  app.get("/api/projects/:id/commits", async (req: Request, res: Response) => {
    const r = await resolve(req.params.id);
    if (!r) return notFound(res);
    const commits = await recentCommits(r.entry.path, 50);
    const byName = new Map(r.config.companions.map((c) => [c.name, c]));
    res.json({
      commits: commits.map((commit) => ({
        ...commit,
        companionRef: commit.companion ? byName.get(commit.companion) : undefined,
      })),
    });
  });

  // Open branches (a PR-style review list) — guest runs land work here. Each
  // carries the companion that produced it (Mysteron-Companion trailer) plus
  // ahead/behind + files-changed vs the checked-out branch.
  app.get("/api/projects/:id/branches", async (req: Request, res: Response) => {
    const r = await resolve(req.params.id);
    if (!r) return notFound(res);
    const branches = await listBranches(r.entry.path);
    const byName = new Map(r.config.companions.map((c) => [c.name, c]));
    res.json({
      current: await currentBranch(r.entry.path),
      branches: branches.map((b) => ({ ...b, companionRef: b.companion ? byName.get(b.companion) : undefined })),
    });
  });

  // Merge an open branch into the checked-out branch (no-ff; refuses on a dirty
  // tree, aborts cleanly on conflict).
  app.post("/api/projects/:id/branches/merge", async (req: Request, res: Response) => {
    const r = await resolve(req.params.id);
    if (!r) return notFound(res);
    const branch = (req.body?.branch ?? "").toString();
    const result = await mergeBranch(r.entry.path, branch);
    if (!result.ok) return res.status(result.conflicted ? 409 : 400).json(result);
    res.json(result);
  });

  // How far the checked-out branch is ahead/behind origin (fetches first so the
  // reading is fresh — best-effort, never blocks on an offline/auth'd remote).
  app.get("/api/projects/:id/origin", async (req: Request, res: Response) => {
    const r = await resolve(req.params.id);
    if (!r) return notFound(res);
    res.json(await originStatus(r.entry.path, { fetch: true }));
  });

  // Push the checked-out branch to origin; on rejection, pull --rebase then retry.
  app.post("/api/projects/:id/push", async (req: Request, res: Response) => {
    const r = await resolve(req.params.id);
    if (!r) return notFound(res);
    const result = await pushCurrentBranch(r.entry.path);
    res.status(result.ok ? 200 : 400).json(result);
  });

  // Delete an open branch (e.g. after merging or discarding it).
  app.post("/api/projects/:id/branches/delete", async (req: Request, res: Response) => {
    const r = await resolve(req.params.id);
    if (!r) return notFound(res);
    const branch = (req.body?.branch ?? "").toString();
    const result = await deleteBranch(r.entry.path, branch);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  });

  // Update editable project settings (yolo, default recipe).
  app.patch("/api/projects/:id/config", async (req: Request, res: Response) => {
    const r = await resolve(req.params.id);
    if (!r) return notFound(res);
    const { yolo, recipe, commit, allowedTools, disallowedTools, regenerateCompanionId, pluginOptions, addCompanion, deleteCompanionId, setCompanionRunsOn } = (req.body ?? {}) as {
      yolo?: boolean;
      recipe?: string;
      commit?: ProjectConfig["commit"] | null;
      allowedTools?: string[];
      disallowedTools?: string[];
      regenerateCompanionId?: string;
      pluginOptions?: ProjectConfig["pluginOptions"];
      addCompanion?: { role: string };
      deleteCompanionId?: string;
      setCompanionRunsOn?: { id: string; runsOn: string[] };
    };
    const next = { ...r.config, companions: [...r.config.companions] };
    if (typeof yolo === "boolean") next.yolo = yolo;
    // Commit strategy: which branch completed work lands on (local + guest alike).
    if (commit !== undefined) {
      if (commit === null) {
        delete next.commit;
      } else if (commit.mode === "main" || commit.mode === "branch" || commit.mode === "per-ticket") {
        next.commit = {
          mode: commit.mode,
          ...(commit.branch ? { branch: String(commit.branch).trim() } : {}),
          ...(commit.branchPrefix ? { branchPrefix: String(commit.branchPrefix).trim() } : {}),
        };
      } else {
        return res.status(400).json({ error: `unknown commit mode: ${(commit as { mode?: string }).mode}` });
      }
    }
    if (Array.isArray(allowedTools)) next.allowedTools = allowedTools.map(String).filter((t) => t.trim());
    if (Array.isArray(disallowedTools)) next.disallowedTools = disallowedTools.map(String).filter((t) => t.trim());
    if (pluginOptions !== undefined) next.pluginOptions = pluginOptions;
    // Changing the recipe rebuilds the companion roster.
    if (typeof recipe === "string" && recipe !== next.recipe) {
      if (!findRecipe(recipe)) return res.status(400).json({ error: `unknown recipe: ${recipe}` });
      next.recipe = recipe;
      next.companions = buildRoster(recipe);
    }
    // Regenerate a single companion's name/avatar (keeps its id + session).
    if (typeof regenerateCompanionId === "string") {
      next.companions = next.companions.map((c) => {
        if (c.id !== regenerateCompanionId) return c;
        const { name } = regenerateCompanion(c);
        return { ...c, name, avatarSeed: name };
      });
    }
    // Add a custom companion with a generated name.
    if (addCompanion && typeof addCompanion.role === "string" && addCompanion.role.trim()) {
      const { name } = generateCompanion();
      const id = randomUUID();
      next.companions = [...next.companions, { id, name, role: addCompanion.role.trim(), avatarSeed: name }];
    }
    // Remove a companion (must keep at least one).
    if (typeof deleteCompanionId === "string" && next.companions.length > 1) {
      next.companions = next.companions.filter((c) => c.id !== deleteCompanionId);
    }
    // Pin a companion to specific hosts ("local" + guest labels). Empty clears the
    // pin (runs anywhere) — store as absent so configs stay tidy.
    if (setCompanionRunsOn && typeof setCompanionRunsOn.id === "string" && Array.isArray(setCompanionRunsOn.runsOn)) {
      const runsOn = setCompanionRunsOn.runsOn.map(String).map((h) => h.trim()).filter(Boolean);
      next.companions = next.companions.map((c) =>
        c.id === setCompanionRunsOn.id ? { ...c, runsOn: runsOn.length ? runsOn : undefined } : c,
      );
    }
    await saveProjectConfig(r.entry.path, next);
    await seedCompanionSpecs(r.entry.path, next);
    bus.emitEvent({ type: "config-changed", projectId: r.entry.id });
    res.json({ config: next });
  });

  // Companion role-spec docs (seeded from the recipe, editable here).
  app.get("/api/projects/:id/companions/:companionId/spec", async (req: Request, res: Response) => {
    const r = await resolve(req.params.id);
    if (!r) return notFound(res);
    const content = await readCompanionSpec(r.entry.path, req.params.companionId);
    res.json({ content: content ?? "" });
  });

  app.put("/api/projects/:id/companions/:companionId/spec", async (req: Request, res: Response) => {
    const r = await resolve(req.params.id);
    if (!r) return notFound(res);
    if (typeof req.body?.content !== "string") {
      return res.status(400).json({ error: "content is required" });
    }
    await writeCompanionSpec(r.entry.path, req.params.companionId, req.body.content);
    bus.emitEvent({ type: "config-changed", projectId: r.entry.id });
    res.json({ ok: true });
  });

  // --- Tickets -------------------------------------------------------------
  app.get("/api/projects/:id/tickets", async (req: Request, res: Response) => {
    const r = await resolve(req.params.id);
    if (!r) return notFound(res);
    res.json({ tickets: await listTickets(r.entry.path) });
  });

  app.post("/api/projects/:id/tickets", async (req: Request, res: Response) => {
    const r = await resolve(req.params.id);
    if (!r) return notFound(res);
    if (!req.body?.title) return res.status(400).json({ error: "title is required" });
    // Default the assignee to the soloist (or the sole companion) — "defaults to
    // soloist if that's all there is"; multi-companion projects stay unassigned.
    const fallback =
      r.config.companions.find((c) => c.role === "soloist") ??
      (r.config.companions.length === 1 ? r.config.companions[0] : undefined);
    const companionId = req.body.companionId ?? fallback?.id;
    const assignee = r.config.companions.find((c) => c.id === companionId)?.name;
    // Tickets raised from the web UI stay anonymous — only the MCP stamps createdBy.
    const { createdBy: _ignore, ...body } = req.body;
    const ticket = await createTicket(r.entry.path, { ...body, companionId, assignee });
    bus.emitEvent({ type: "board-changed", projectId: r.entry.id, detail: ticket.id });
    res.json({ ticket });
  });

  // Bulk-move a whole column: move every ticket in `from` to `to` (a column, or
  // the bin) in one request. The UI confirms before calling this.
  app.post("/api/projects/:id/tickets/bulk-move", async (req: Request, res: Response) => {
    const r = await resolve(req.params.id);
    if (!r) return notFound(res);
    const { from, to } = (req.body ?? {}) as { from?: TicketState; to?: TicketState };
    if (!from || !to || !TICKET_STATES.includes(from) || !TICKET_STATES.includes(to)) {
      return res.status(400).json({ error: "from and to must be valid ticket states" });
    }
    const moved = await moveTicketsByState(r.entry.path, from, to);
    if (moved > 0) bus.emitEvent({ type: "board-changed", projectId: r.entry.id });
    res.json({ moved });
  });

  // Reorder a column from a drag-and-drop: `ids` is the destination column's full
  // ordered list. Each ticket is re-sequenced and pulled into `state`, so this also
  // handles dropping a card into another column at a chosen position.
  app.post("/api/projects/:id/tickets/reorder", async (req: Request, res: Response) => {
    const r = await resolve(req.params.id);
    if (!r) return notFound(res);
    const { state, ids } = (req.body ?? {}) as { state?: TicketState; ids?: string[] };
    if (!state || !TICKET_STATES.includes(state) || !Array.isArray(ids)) {
      return res.status(400).json({ error: "state must be a valid ticket state and ids an array" });
    }
    const changed = await reorderTickets(r.entry.path, state, ids);
    if (changed > 0) bus.emitEvent({ type: "board-changed", projectId: r.entry.id });
    res.json({ changed });
  });

  app.patch("/api/projects/:id/tickets/:ticketId", async (req: Request, res: Response) => {
    const r = await resolve(req.params.id);
    if (!r) return notFound(res);
    const patch = { ...(req.body ?? {}) };
    // Keep the display assignee in sync when (re)assigning to a companion.
    if ("companionId" in patch) {
      patch.assignee = r.config.companions.find((c) => c.id === patch.companionId)?.name ?? undefined;
    }
    const ticket = await updateTicket(r.entry.path, req.params.ticketId, patch);
    if (!ticket) return notFound(res);
    bus.emitEvent({ type: "board-changed", projectId: r.entry.id, detail: ticket.id });
    res.json({ ticket });
  });

  app.delete("/api/projects/:id/tickets/:ticketId", async (req: Request, res: Response) => {
    const r = await resolve(req.params.id);
    if (!r) return notFound(res);
    const ok = await deleteTicket(r.entry.path, req.params.ticketId);
    bus.emitEvent({ type: "board-changed", projectId: r.entry.id });
    res.json({ ok });
  });

  // --- Ticket image attachments --------------------------------------------
  // Upload is raw image bytes (skips the JSON body parser, so big images are
  // fine); the filename rides in ?name=.
  app.post(
    "/api/projects/:id/tickets/:ticketId/attachments",
    express.raw({ type: () => true, limit: "25mb" }),
    async (req: Request, res: Response) => {
      const r = await resolve(req.params.id);
      if (!r) return notFound(res);
      const type = String(req.headers["content-type"] ?? "");
      if (!type.startsWith("image/")) return res.status(400).json({ error: "expected an image" });
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: "empty body" });
      const q = req.query.name;
      const name = typeof q === "string" && q.trim() ? q : `image.${type.split("/")[1]}`;
      const ticket = await addAttachment(r.entry.path, req.params.ticketId, name, req.body);
      if (!ticket) return notFound(res);
      bus.emitEvent({ type: "board-changed", projectId: r.entry.id, detail: ticket.id });
      res.json({ ticket });
    },
  );

  app.delete("/api/projects/:id/tickets/:ticketId/attachments/:name", async (req: Request, res: Response) => {
    const r = await resolve(req.params.id);
    if (!r) return notFound(res);
    const ticket = await removeAttachment(r.entry.path, req.params.ticketId, req.params.name);
    if (!ticket) return notFound(res);
    bus.emitEvent({ type: "board-changed", projectId: r.entry.id, detail: ticket.id });
    res.json({ ticket });
  });

  app.get("/api/projects/:id/tickets/:ticketId/attachments/:name", async (req: Request, res: Response) => {
    const r = await resolve(req.params.id);
    if (!r) return notFound(res);
    const bytes = await readAttachment(r.entry.path, req.params.ticketId, req.params.name);
    if (!bytes) return notFound(res);
    res.type(req.params.name).send(bytes);
  });

  // --- Agent runs ----------------------------------------------------------
  // Start an agent working on a ticket (the "play" button).
  app.post("/api/projects/:id/tickets/:ticketId/run", async (req: Request, res: Response) => {
    const r = await resolve(req.params.id);
    if (!r) return notFound(res);
    const ticket = await getTicket(r.entry.path, req.params.ticketId);
    if (!ticket) return notFound(res);
    const args = { projectId: r.entry.id, projectRoot: r.entry.path, config: r.config, ticket };
    try {
      // The ticket's companion may be pinned to specific hosts ("runs on"): the
      // local machine and/or named guests. Consult that list before choosing where
      // to run, falling back to the existing budget/availability rules.
      const companion = getCompanion(r.config, ticket.companionId) ?? defaultCompanion(r.config);
      const allowsLocal = companionAllowsLocal(companion);
      const idleAllowedGuest = () => workers.idle().find((w) => companionAllowsGuest(companion, w.label));

      // A local run can't happen if the host's Claude usage is maxed out (it
      // would just fail against the rate limit) or if no agent program is even
      // installed. Together with a "runs on" pin that excludes local, those are
      // the cases where the work must go to a guest.
      const budget = await checkUsageBudget(r.entry.path, r.config);
      const usageMaxed = !!budget && !budget.safeToContinue;
      const noLocalAgent = !agentAvailable(r.config);
      const mustUseGuest = !allowsLocal || noLocalAgent || usageMaxed;

      if (mustUseGuest) {
        const worker = idleAllowedGuest();
        if (worker) {
          const run = await runs.startOnWorker(args, workers, { id: worker.id, label: worker.label });
          if (!run) return res.status(503).json({ error: "The guest worker became unavailable. Try again." });
          return res.json({ run: runSummary(run) });
        }
        // No allowed guest free. If local isn't even an option, say why; otherwise
        // (usage maxed but local allowed) fall through and let the user's explicit
        // run proceed locally.
        if (!allowsLocal) {
          return res.status(503).json({
            error: companionHasHostPins(companion) ? hostsUnavailableMessage(companion) : "No host is free to run this ticket.",
          });
        }
        if (noLocalAgent) {
          return res.status(503).json({ error: agentUnavailableMessage(r.config) });
        }
      }
      const run = await runs.start(args);
      res.json({ run: runSummary(run) });
    } catch (err) {
      if (err instanceof CompanionBusyError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  app.get("/api/projects/:id/runs", async (req: Request, res: Response) => {
    const r = await resolve(req.params.id);
    if (!r) return notFound(res);
    res.json({ runs: runs.listByProject(r.entry.id).map(runSummary) });
  });

  app.get("/api/runs/:runId", (req: Request, res: Response) => {
    const run = runs.get(req.params.runId);
    if (!run) return notFound(res);
    res.json({ run });
  });

  app.post("/api/runs/:runId/stop", (req: Request, res: Response) => {
    res.json({ ok: runs.stop(req.params.runId) });
  });

  // Live view: replay buffered output, then stream new lines + status.
  app.get("/api/runs/:runId/stream", (req: Request, res: Response) => {
    const run = runs.get(req.params.runId);
    if (!run) return notFound(res);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (evt: RunEvent) => sseWrite(res, `data: ${JSON.stringify(evt)}\n\n`);
    // Backfill existing output for late joiners.
    for (const line of run.lines) {
      send({ kind: "line", runId: run.id, projectId: run.projectId, ticketId: run.ticketId, line, at: line.at });
    }
    if (run.status !== "running") {
      send({ kind: "status", runId: run.id, projectId: run.projectId, ticketId: run.ticketId, status: run.status, exitCode: run.exitCode, at: new Date().toISOString() });
    }
    const onRun = (evt: RunEvent) => {
      if (evt.runId === run.id) send(evt);
    };
    bus.on("run", onRun);
    const keepAlive = setInterval(() => sseWrite(res, ": ping\n\n"), 25_000);
    res.on("close", () => {
      clearInterval(keepAlive);
      bus.off("run", onRun);
    });
  });

  // --- Autopilot (board-level play) ----------------------------------------
  app.get("/api/projects/:id/autopilot", async (req: Request, res: Response) => {
    const r = await resolve(req.params.id);
    if (!r) return notFound(res);
    res.json({ autopilot: autopilot.status(r.entry.id) ?? { status: "stopped" } });
  });

  app.post("/api/projects/:id/autopilot/start", async (req: Request, res: Response) => {
    const r = await resolve(req.params.id);
    if (!r) return notFound(res);
    const state = autopilot.start(r.entry.id, r.entry.path);
    res.json({ autopilot: state });
  });

  app.post("/api/projects/:id/autopilot/stop", async (req: Request, res: Response) => {
    const r = await resolve(req.params.id);
    if (!r) return notFound(res);
    res.json({ ok: autopilot.stop(r.entry.id) });
  });

  // --- Docs ----------------------------------------------------------------
  app.get("/api/projects/:id/docs/:name", async (req: Request, res: Response) => {
    const r = await resolve(req.params.id);
    if (!r) return notFound(res);
    const content = await readDoc(r.entry.path, req.params.name);
    if (content === undefined) return notFound(res);
    res.json({ name: req.params.name, content });
  });

  app.put("/api/projects/:id/docs/:name", async (req: Request, res: Response) => {
    const r = await resolve(req.params.id);
    if (!r) return notFound(res);
    if (typeof req.body?.content !== "string") {
      return res.status(400).json({ error: "content is required" });
    }
    try {
      const doc = await writeDoc(r.entry.path, req.params.name, req.body.content);
      res.json({ doc });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // --- Memory --------------------------------------------------------------
  app.get("/api/projects/:id/memories", async (req: Request, res: Response) => {
    const r = await resolve(req.params.id);
    if (!r) return notFound(res);
    res.json({ memories: await listMemories(r.entry.path) });
  });

  // --- Usage (first-party plugin surfaced over HTTP) -----------------------
  app.delete("/api/usage/snapshot", async (_req: Request, res: Response) => {
    await deleteSnapshot();
    res.json({ ok: true });
  });

  app.get("/api/projects/:id/usage", async (req: Request, res: Response) => {
    const r = await resolve(req.params.id);
    if (!r) return notFound(res);
    if (!r.config.plugins.includes("usage-monitor")) {
      return res.json({ enabled: false });
    }
    const tools = usageMonitorPlugin.tools?.({ projectRoot: r.entry.path, config: r.config }) ?? [];
    const check = tools.find((t) => t.name === "check_usage_budget");
    if (!check) return res.json({ enabled: false });
    const data = await check.handler({}, { projectRoot: r.entry.path, config: r.config });
    res.json({ enabled: true, ...(data as object) });
  });

  // --- Static metadata -----------------------------------------------------
  app.get("/api/recipes", (_req: Request, res: Response) => res.json({ recipes: RECIPES }));

  app.get("/api/plugins", async (req: Request, res: Response) => {
    const idFilter = req.query.project as string | undefined;
    let active: string[] = [];
    if (idFilter) {
      const r = await resolve(idFilter);
      active = r ? enabledPlugins(r.config.plugins).map((p) => p.id) : [];
    }
    res.json({
      plugins: allPlugins().map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        active: active.includes(p.id),
      })),
    });
  });

  // --- Live updates (SSE) --------------------------------------------------
  app.get("/api/events", (_req: Request, res: Response) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    sseWrite(res, ": connected\n\n");
    const onEvent = (evt: unknown) => sseWrite(res, `data: ${JSON.stringify(evt)}\n\n`);
    bus.on("mysteron", onEvent);
    bus.on("autopilot", onEvent);
    const keepAlive = setInterval(() => sseWrite(res, ": ping\n\n"), 25_000);
    res.on("close", () => {
      clearInterval(keepAlive);
      bus.off("mysteron", onEvent);
      bus.off("autopilot", onEvent);
    });
  });

  // Error handler — turns any route failure into a 500 (and logs it) instead of
  // a hung request. Must be registered last.
  app.use((err: Error, _req: Request, res: Response, _next: (e?: unknown) => void) => {
    console.error("[mysteron] route error:", verbose ? err.stack : err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });
}
