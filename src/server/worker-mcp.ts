import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildMcpServer } from "../mcp/server.js";
import { loadProjectConfig } from "../core/project.js";
import { loadSettings, verifyGuestToken } from "../core/settings.js";
import type { RunManager } from "../runner/manager.js";

const rpcError = (message: string) => ({ jsonrpc: "2.0" as const, error: { code: -32000, message }, id: null });

/**
 * Serves the project's Mysteron MCP (board / docs / memory) to a guest over HTTP,
 * so a guest agent works against the host's *live* board — not the stale, tracked-
 * files-only snapshot it runs in. Scoped to a dispatched run (→ its project) and
 * gated by the guest token. Sessions are keyed by the MCP session id the SDK mints
 * on initialize. The /worker path bypasses the password cookie gate (see auth.ts).
 */
export function createWorkerMcp(runs: RunManager) {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const authed = async (req: Request): Promise<boolean> => {
    const token = (req.header("x-mysteron-guest-token") || req.query.token || "").toString();
    return verifyGuestToken(await loadSettings(), token);
  };

  // POST carries client→server messages, including the initial `initialize`.
  const post = async (req: Request, res: Response): Promise<void> => {
    if (!(await authed(req))) {
      res.status(401).json(rpcError("invalid guest token"));
      return;
    }
    const sid = req.header("mcp-session-id");
    let transport = sid ? transports.get(sid) : undefined;

    if (!transport) {
      if (sid || !isInitializeRequest(req.body)) {
        res.status(400).json(rpcError("no active MCP session — send an initialize request first"));
        return;
      }
      const run = runs.get(req.params.runId);
      if (!run) {
        res.status(404).json(rpcError("unknown run"));
        return;
      }
      const config = await loadProjectConfig(run.projectRoot);
      if (!config) {
        res.status(404).json(rpcError("project is not initialised"));
        return;
      }
      const server = await buildMcpServer(run.projectRoot, config);
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          transports.set(id, transport!);
        },
      });
      transport.onclose = () => {
        if (transport!.sessionId) transports.delete(transport!.sessionId);
      };
      await server.connect(transport);
    }
    await transport.handleRequest(req, res, req.body);
  };

  // GET opens the server→client notification stream; DELETE ends the session.
  const session = async (req: Request, res: Response): Promise<void> => {
    if (!(await authed(req))) {
      res.status(401).end();
      return;
    }
    const sid = req.header("mcp-session-id");
    const transport = sid ? transports.get(sid) : undefined;
    if (!transport) {
      res.status(400).end();
      return;
    }
    await transport.handleRequest(req, res);
  };

  return { post, session };
}
