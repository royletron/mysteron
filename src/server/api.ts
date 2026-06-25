import express, { type Express, type Request, type Response } from "express";
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
  loadProjectConfig,
  readDoc,
  updateTicket,
  writeDoc,
  regenerateCompanion,
  buildRoster,
  seedCompanionSpecs,
  readCompanionSpec,
  writeCompanionSpec,
  recentCommits,
  type ProjectConfig,
  type RegistryEntry,
} from "../core/index.js";
import { findEntry, loadRegistry, unregisterProject } from "../core/registry.js";
import { initProject, saveProjectConfig } from "../core/project.js";
import { RECIPES, findRecipe } from "../core/recipes.js";
import { BOARD_STATES, TICKET_STATES } from "../core/types.js";
import { allPlugins, enabledPlugins } from "../plugins/manager.js";
import { usageMonitorPlugin } from "../plugins/usage-monitor/index.js";
import type { ProjectWatcher } from "../core/watcher.js";
import { type RunManager, runSummary, CompanionBusyError } from "../runner/manager.js";
import type { Autopilot } from "../runner/autopilot.js";
import type { RunEvent } from "../core/events.js";
import { registerAuth } from "./auth.js";
import type { WorkerRegistry } from "./workers.js";

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
    const tickets = await listTickets(r.entry.path);
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

  // Update editable project settings (yolo, default recipe).
  app.patch("/api/projects/:id/config", async (req: Request, res: Response) => {
    const r = await resolve(req.params.id);
    if (!r) return notFound(res);
    const { yolo, recipe, allowedTools, disallowedTools, regenerateCompanionId, pluginOptions } = (req.body ?? {}) as {
      yolo?: boolean;
      recipe?: string;
      allowedTools?: string[];
      disallowedTools?: string[];
      regenerateCompanionId?: string;
      pluginOptions?: ProjectConfig["pluginOptions"];
    };
    const next = { ...r.config, companions: [...r.config.companions] };
    if (typeof yolo === "boolean") next.yolo = yolo;
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
    const ticket = await createTicket(r.entry.path, { ...req.body, companionId, assignee });
    bus.emitEvent({ type: "board-changed", projectId: r.entry.id, detail: ticket.id });
    res.json({ ticket });
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
    try {
      const run = await runs.start({
        projectId: r.entry.id,
        projectRoot: r.entry.path,
        config: r.config,
        ticket,
      });
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
