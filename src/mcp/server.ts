import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  TICKET_PRIORITIES,
  TICKET_STATES,
  createTicket,
  getTicket,
  listDocs,
  listMemories,
  listTickets,
  nextTicket,
  readDoc,
  readMemory,
  updateTicket,
  writeDoc,
  writeMemory,
} from "../core/index.js";
import { RECIPES, findRecipe } from "../core/recipes.js";
import { ETIQUETTE_DOC, SPEC_DOC } from "../core/paths.js";
import { loadProjectConfig } from "../core/project.js";
import { enabledPlugins } from "../plugins/manager.js";
import type { ProjectConfig } from "../core/types.js";

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

/** Build an MCP server scoped to a single project. */
export async function buildMcpServer(
  projectRoot: string,
  config: ProjectConfig,
): Promise<McpServer> {
  const server = new McpServer({
    name: `mysteron:${config.name}`,
    version: "0.1.0",
  });

  server.registerTool(
    "project_info",
    {
      description:
        "Get this project's identity: companion roster (name + role), recipe, enabled plugins, yolo mode and available agent-team recipes.",
      inputSchema: {},
    },
    async () =>
      json({
        id: config.id,
        name: config.name,
        recipe: config.recipe,
        companions: config.companions.map((c) => ({ id: c.id, name: c.name, role: c.role })),
        plugins: config.plugins,
        yolo: config.yolo,
        recipes: RECIPES.map((r) => ({ id: r.id, name: r.name })),
      }),
  );

  // --- Docs / spec / etiquette ---------------------------------------------
  server.registerTool(
    "read_spec",
    { description: "Read the project specification (docs/SPEC.md).", inputSchema: {} },
    async () => text((await readDoc(projectRoot, SPEC_DOC)) ?? "(no SPEC.md yet)"),
  );

  server.registerTool(
    "read_etiquette",
    {
      description:
        "Read the project etiquette: the rules every agent must follow (commits, merging, tests, comments).",
      inputSchema: {},
    },
    async () => text((await readDoc(projectRoot, ETIQUETTE_DOC)) ?? "(no ETIQUETTE.md yet)"),
  );

  server.registerTool(
    "list_docs",
    { description: "List all markdown docs in the project's shared docs folder.", inputSchema: {} },
    async () => json(await listDocs(projectRoot)),
  );

  server.registerTool(
    "read_doc",
    {
      description: "Read a markdown doc by name (e.g. SPEC.md).",
      inputSchema: { name: z.string().describe("Doc file name, e.g. SPEC.md") },
    },
    async ({ name }) => {
      const doc = await readDoc(projectRoot, name);
      return doc === undefined ? text(`Doc not found: ${name}`) : text(doc);
    },
  );

  server.registerTool(
    "write_doc",
    {
      description: "Create or overwrite a markdown doc in the shared docs folder.",
      inputSchema: {
        name: z.string().describe("Doc file name, e.g. DESIGN.md"),
        content: z.string().describe("Full markdown content to write."),
      },
    },
    async ({ name, content }) => json(await writeDoc(projectRoot, name, content)),
  );

  // --- Board / tickets ------------------------------------------------------
  server.registerTool(
    "list_tickets",
    {
      description: "List tickets on the project board, optionally filtered by state.",
      inputSchema: {
        state: z.enum(TICKET_STATES).optional().describe("Filter by board state."),
      },
    },
    async ({ state }) => json(await listTickets(projectRoot, state ? { state } : undefined)),
  );

  server.registerTool(
    "get_ticket",
    {
      description: "Get a single ticket by id, including its full description.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const t = await getTicket(projectRoot, id);
      return t ? json(t) : text(`Ticket not found: ${id}`);
    },
  );

  server.registerTool(
    "create_ticket",
    {
      description: "Create a new ticket on the board.",
      inputSchema: {
        title: z.string(),
        body: z.string().optional().describe("Markdown description / acceptance criteria."),
        state: z.enum(TICKET_STATES).optional(),
        priority: z.enum(TICKET_PRIORITIES).optional(),
        labels: z.array(z.string()).optional(),
        assignee: z.string().optional(),
        blockedBy: z
          .array(z.string())
          .optional()
          .describe("Ids of tickets this one depends on; it waits in the queue until they're done and merged to main."),
      },
    },
    async (args) => json(await createTicket(projectRoot, args)),
  );

  server.registerTool(
    "update_ticket",
    {
      description:
        "Update a ticket: change its state (e.g. move to in-progress/review/done), title, body, priority, assignee, labels or dependencies (blockedBy).",
      inputSchema: {
        id: z.string(),
        state: z.enum(TICKET_STATES).optional(),
        title: z.string().optional(),
        body: z.string().optional(),
        priority: z.enum(TICKET_PRIORITIES).optional(),
        assignee: z.string().optional(),
        labels: z.array(z.string()).optional(),
        blockedBy: z
          .array(z.string())
          .optional()
          .describe("Ids of tickets this one depends on; it waits in the queue until they're done and merged to main. Pass [] to clear."),
      },
    },
    async ({ id, ...patch }) => {
      const t = await updateTicket(projectRoot, id, patch);
      return t ? json(t) : text(`Ticket not found: ${id}`);
    },
  );

  server.registerTool(
    "next_ticket",
    {
      description:
        "Pull the next actionable ticket (highest-priority in 'ready'). Set claim=true to move it to 'in-progress' and assign it.",
      inputSchema: {
        claim: z.boolean().optional(),
        assignee: z.string().optional(),
      },
    },
    async ({ claim, assignee }) => {
      const t = await nextTicket(projectRoot, { claim, assignee });
      return t ? json(t) : text("No tickets in 'ready'.");
    },
  );

  // --- Memory ---------------------------------------------------------------
  server.registerTool(
    "list_memories",
    { description: "List project memories (facts the companion has saved).", inputSchema: {} },
    async () => json(await listMemories(projectRoot)),
  );

  server.registerTool(
    "read_memory",
    { description: "Read a project memory by name.", inputSchema: { name: z.string() } },
    async ({ name }) => {
      const m = await readMemory(projectRoot, name);
      return m === undefined ? text(`Memory not found: ${name}`) : text(m);
    },
  );

  server.registerTool(
    "write_memory",
    {
      description:
        "Save a project memory (markdown with frontmatter: name, description, metadata.type).",
      inputSchema: { name: z.string(), content: z.string() },
    },
    async ({ name, content }) =>
      text(`Saved memory: ${await writeMemory(projectRoot, name, content)}`),
  );

  // --- Recipes --------------------------------------------------------------
  server.registerTool(
    "list_recipes",
    {
      description: "List agent-team recipes the companion can use to delegate work.",
      inputSchema: {},
    },
    async () => json(RECIPES),
  );

  server.registerTool(
    "get_recipe",
    {
      description: "Get a single agent-team recipe by id, including its roles.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const r = findRecipe(id);
      return r ? json(r) : text(`Recipe not found: ${id}`);
    },
  );

  // --- Plugin-contributed tools --------------------------------------------
  const ctx = { projectRoot, config };
  for (const plugin of enabledPlugins(config.plugins)) {
    for (const tool of plugin.tools?.(ctx) ?? []) {
      server.registerTool(
        tool.name,
        { description: `[${plugin.name}] ${tool.description}`, inputSchema: tool.inputSchema },
        async (args: Record<string, unknown>) => json(await tool.handler(args, ctx)),
      );
    }
  }

  return server;
}

/** Start the MCP server over stdio for the given project root. */
export async function startStdioMcp(projectRoot: string): Promise<void> {
  const config = await loadProjectConfig(projectRoot);
  if (!config) {
    throw new Error(
      `No Mysteron project at ${projectRoot}. Run "mysteron init" there first.`,
    );
  }
  const server = await buildMcpServer(projectRoot, config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
