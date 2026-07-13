import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  TICKET_PRIORITIES,
  TICKET_STATES,
  completeSubtask,
  createTicket,
  getTicket,
  listDocs,
  listMemories,
  listTickets,
  nextTicket,
  readDoc,
  readMemory,
  setSubtasks,
  updateTicket,
  writeDoc,
  writeMemory,
} from "../core/index.js";
import { RECIPES, findRecipe } from "../core/recipes.js";
import { ETIQUETTE_DOC, SPEC_DOC } from "../core/paths.js";
import { loadProjectConfig } from "../core/project.js";
import { resolvePlugins } from "../plugins/manager.js";
import { bus } from "../core/events.js";
import type { ProjectConfig } from "../core/types.js";

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function textResource(uri: string, mimeType: string, content: string) {
  return { contents: [{ uri, mimeType, text: content }] };
}

function ticketToMarkdown(t: Awaited<ReturnType<typeof getTicket>>): string {
  if (!t) return "(not found)";
  const lines = [
    `# ${t.title}`,
    `**ID:** ${t.id}  **State:** ${t.state}  **Priority:** ${t.priority}`,
  ];
  if (t.labels?.length) lines.push(`**Labels:** ${t.labels.join(", ")}`);
  if (t.assignee) lines.push(`**Assignee:** ${t.assignee}`);
  if (t.body) lines.push("", t.body);
  return lines.join("\n");
}

/** Build an MCP server scoped to a single project. `callerCompanionId` identifies
 *  the companion the agent is running as, so tickets it raises are attributed to it. */
export async function buildMcpServer(
  projectRoot: string,
  config: ProjectConfig,
  callerCompanionId?: string,
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
        forceSplit: z
          .boolean()
          .optional()
          .describe("Force the ticket to be broken into subtasks on run, even if it looks small."),
      },
    },
    // Stamp the raising companion so the board can show who pushed the ticket.
    async (args) => json(await createTicket(projectRoot, { ...args, createdBy: callerCompanionId })),
  );

  server.registerTool(
    "update_ticket",
    {
      description:
        "Update a ticket: change its state (e.g. move to in-progress/review/done), title, body, priority, assignee, labels, dependencies (blockedBy) or forceSplit.",
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
        forceSplit: z
          .boolean()
          .optional()
          .describe("Force the ticket to be broken into subtasks on run, even if it looks small."),
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

  // --- Subtasks -------------------------------------------------------------
  server.registerTool(
    "plan_subtasks",
    {
      description:
        "Break a ticket into an ordered list of small, independently-committable steps. Do this at the start when a ticket is too big to finish in one go; work through the steps in order, committing and calling complete_subtask after each. Pass an empty list to clear the breakdown. Re-planning keeps the done flag of any step whose title is unchanged.",
      inputSchema: {
        id: z.string(),
        subtasks: z.array(z.string()).describe("Ordered step titles, each a small discrete piece of work."),
      },
    },
    async ({ id, subtasks }) => {
      const t = await setSubtasks(projectRoot, id, subtasks);
      return t ? json(t) : text(`Ticket not found: ${id}`);
    },
  );

  server.registerTool(
    "complete_subtask",
    {
      description:
        "Mark a subtask done once its work is committed: the step matching `title` if given, otherwise the first still-pending step. Recording progress as you go is what lets a later run resume from the first unfinished step.",
      inputSchema: {
        id: z.string(),
        title: z.string().optional().describe("Title of the step to complete; omit to complete the next pending one."),
      },
    },
    async ({ id, title }) => {
      const t = await completeSubtask(projectRoot, id, title);
      return t ? json(t) : text(`No pending subtask to complete on ticket: ${id}`);
    },
  );

  // --- Memory ---------------------------------------------------------------
  server.registerTool(
    "list_memories",
    {
      description:
        "List project memory — shared context mirroring the src tree (nested names like 'core/board'). Check it before working an area.",
      inputSchema: {},
    },
    async () => json(await listMemories(projectRoot)),
  );

  server.registerTool(
    "read_memory",
    {
      description: "Read a project memory by name (may be nested, e.g. 'core/board').",
      inputSchema: { name: z.string() },
    },
    async ({ name }) => {
      const m = await readMemory(projectRoot, name);
      return m === undefined ? text(`Memory not found: ${name}`) : text(m);
    },
  );

  server.registerTool(
    "write_memory",
    {
      description:
        "Save shared project memory as you work — markdown with frontmatter (name, description, metadata.type). Name it to mirror the src tree (e.g. 'core/board'); a file may hold several related facts. Record what you learn about an area, e.g. who owns it.",
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

  // --- Resources (read-only, URI-addressable) --------------------------------

  // mysteron://board — full ticket list as JSON
  server.registerResource(
    "board",
    "mysteron://board",
    { description: "All tickets on the board as JSON.", mimeType: "application/json" },
    async (uri) => textResource(uri.href, "application/json", JSON.stringify(await listTickets(projectRoot), null, 2)),
  );

  // mysteron://spec — SPEC.md shorthand
  server.registerResource(
    "spec",
    "mysteron://spec",
    { description: "The project's SPEC.md.", mimeType: "text/markdown" },
    async (uri) => textResource(uri.href, "text/markdown", (await readDoc(projectRoot, SPEC_DOC)) ?? "(no SPEC.md yet)"),
  );

  // mysteron://ticket/{id} — single ticket as markdown
  server.registerResource(
    "ticket",
    new ResourceTemplate("mysteron://ticket/{id}", { list: undefined }),
    { description: "A single ticket rendered as markdown.", mimeType: "text/markdown" },
    async (uri, { id }) => {
      const t = await getTicket(projectRoot, id as string);
      return textResource(uri.href, "text/markdown", ticketToMarkdown(t));
    },
  );

  // mysteron://docs/{name} — shared doc file
  server.registerResource(
    "docs",
    new ResourceTemplate("mysteron://docs/{name}", {
      list: async () => ({
        resources: (await listDocs(projectRoot)).map((n) => ({ uri: `mysteron://docs/${n.name}`, name: n.name })),
      }),
    }),
    { description: "A shared doc file by name (e.g. SPEC.md).", mimeType: "text/markdown" },
    async (uri, { name }) => {
      const content = await readDoc(projectRoot, name as string);
      return textResource(uri.href, "text/markdown", content ?? `(doc not found: ${name})`);
    },
  );

  // mysteron://memory/{name} — memory file
  server.registerResource(
    "memory",
    new ResourceTemplate("mysteron://memory/{name}", {
      list: async () => ({
        resources: (await listMemories(projectRoot)).map((n) => ({ uri: `mysteron://memory/${n.name}`, name: n.name })),
      }),
    }),
    { description: "A project memory file by name.", mimeType: "text/markdown" },
    async (uri, { name }) => {
      const content = await readMemory(projectRoot, name as string);
      return textResource(uri.href, "text/markdown", content ?? `(memory not found: ${name})`);
    },
  );

  // Notify clients when board state changes so subscribers get push updates.
  bus.on("mysteron", (evt: { type: string }) => {
    if (evt.type === "board-changed") server.sendResourceListChanged();
  });

  // --- Plugin-contributed tools --------------------------------------------
  const ctx = { projectRoot, config };
  for (const plugin of await resolvePlugins(projectRoot, config.plugins)) {
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
  const server = await buildMcpServer(projectRoot, config, process.env.MYSTERON_COMPANION_ID || undefined);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
