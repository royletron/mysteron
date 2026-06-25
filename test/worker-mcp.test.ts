import assert from "node:assert/strict";
import express from "express";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, test } from "node:test";

// Throwaway dirs before importing modules that read env at call time.
const tmp = path.join(os.tmpdir(), `mysteron-mcp-test-${process.pid}`);
process.env.MYSTERON_HOME = path.join(tmp, "home");
process.env.CLAUDE_PROJECTS_DIR = path.join(tmp, "claude");

const { initProject } = await import("../src/core/project.js");
const { createTicket } = await import("../src/core/board.js");
const { mintGuestToken } = await import("../src/core/settings.js");
const { createWorkerMcp } = await import("../src/server/worker-mcp.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

const root = path.join(tmp, "proj");
let server: Server;
let port: number;
let token: string;

before(async () => {
  await fs.mkdir(root, { recursive: true });
  await initProject(root, { name: "MCP Proj" });
  await createTicket(root, { title: "Live ticket", priority: "normal" });
  token = (await mintGuestToken()).token;

  // Stub RunManager: every run resolves to our project.
  const runs = { get: () => ({ projectRoot: root }) } as never;
  const mcp = createWorkerMcp(runs);
  const app = express();
  app.use(express.json());
  app.post("/api/worker/mcp/:runId", (req, res) => void mcp.post(req, res));
  app.get("/api/worker/mcp/:runId", (req, res) => void mcp.session(req, res));
  app.delete("/api/worker/mcp/:runId", (req, res) => void mcp.session(req, res));
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

function connect(authToken: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/api/worker/mcp/run1`), {
    requestInit: { headers: { "x-mysteron-guest-token": authToken } },
  });
  const client = new Client({ name: "test-guest", version: "0.0.0" });
  return { client, transport };
}

test("serves the host's live board (tickets/docs) to a guest over HTTP", async () => {
  const { client, transport } = connect(token);
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === "list_tickets"));

    const result = (await client.callTool({ name: "list_tickets", arguments: {} })) as {
      content: { text: string }[];
    };
    const out = result.content.map((c) => c.text).join("");
    assert.match(out, /Live ticket/); // the ticket created on the host is visible to the guest
  } finally {
    await client.close();
  }
});

test("rejects a guest with the wrong token", async () => {
  const { client, transport } = connect("nope-wrong-token");
  await assert.rejects(() => client.connect(transport));
  await client.close().catch(() => undefined);
});
