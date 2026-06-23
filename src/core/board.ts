import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { nanoid } from "nanoid";
import { boardDir } from "./paths.js";
import {
  TICKET_STATES,
  type Ticket,
  type TicketPriority,
  type TicketState,
} from "./types.js";

function now(): string {
  return new Date().toISOString();
}

function ticketPath(projectRoot: string, id: string): string {
  return path.join(boardDir(projectRoot), `${id}.md`);
}

function parseTicket(id: string, raw: string): Ticket {
  let data: Record<string, unknown> = {};
  let content = raw;
  try {
    const parsed = matter(raw);
    data = parsed.data;
    content = parsed.content;
  } catch (err) {
    // A malformed ticket file must not break the whole board — surface it as a
    // readable placeholder instead of throwing (which would hang the request).
    return {
      id,
      title: `⚠ ${id} (unparseable frontmatter)`,
      state: "backlog",
      priority: "medium",
      labels: ["parse-error"],
      created: now(),
      updated: now(),
      body: `This ticket could not be parsed: ${(err as Error).message}\n\n---\n${raw}`,
    };
  }
  const state = (data.state as TicketState) ?? "backlog";
  return {
    id,
    title: (data.title as string) ?? "(untitled)",
    state: TICKET_STATES.includes(state) ? state : "backlog",
    priority: (data.priority as TicketPriority) ?? "medium",
    assignee: data.assignee as string | undefined,
    labels: Array.isArray(data.labels) ? (data.labels as string[]) : [],
    created: (data.created as string) ?? now(),
    updated: (data.updated as string) ?? now(),
    body: content.trim(),
  };
}

function serializeTicket(t: Ticket): string {
  const fm = {
    title: t.title,
    state: t.state,
    priority: t.priority,
    ...(t.assignee ? { assignee: t.assignee } : {}),
    labels: t.labels,
    created: t.created,
    updated: t.updated,
  };
  return matter.stringify(`\n${t.body.trim()}\n`, fm);
}

export async function listTickets(
  projectRoot: string,
  filter?: { state?: TicketState },
): Promise<Ticket[]> {
  const dir = boardDir(projectRoot);
  let files: string[] = [];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const tickets: Ticket[] = [];
  for (const f of files) {
    const id = f.replace(/\.md$/, "");
    const raw = await fs.readFile(path.join(dir, f), "utf8");
    tickets.push(parseTicket(id, raw));
  }
  const filtered = filter?.state
    ? tickets.filter((t) => t.state === filter.state)
    : tickets;
  // Sort by priority then created date for stable ordering.
  const rank: Record<TicketPriority, number> = { high: 0, medium: 1, low: 2 };
  return filtered.sort(
    (a, b) => rank[a.priority] - rank[b.priority] || a.created.localeCompare(b.created),
  );
}

export async function getTicket(
  projectRoot: string,
  id: string,
): Promise<Ticket | undefined> {
  try {
    const raw = await fs.readFile(ticketPath(projectRoot, id), "utf8");
    return parseTicket(id, raw);
  } catch {
    return undefined;
  }
}

export async function createTicket(
  projectRoot: string,
  input: {
    title: string;
    body?: string;
    state?: TicketState;
    priority?: TicketPriority;
    assignee?: string;
    labels?: string[];
  },
): Promise<Ticket> {
  await fs.mkdir(boardDir(projectRoot), { recursive: true });
  const ts = now();
  const ticket: Ticket = {
    id: nanoid(8),
    title: input.title,
    state: input.state ?? "backlog",
    priority: input.priority ?? "medium",
    assignee: input.assignee,
    labels: input.labels ?? [],
    created: ts,
    updated: ts,
    body: input.body ?? "",
  };
  await fs.writeFile(ticketPath(projectRoot, ticket.id), serializeTicket(ticket), "utf8");
  return ticket;
}

export async function updateTicket(
  projectRoot: string,
  id: string,
  patch: Partial<Omit<Ticket, "id" | "created">>,
): Promise<Ticket | undefined> {
  const existing = await getTicket(projectRoot, id);
  if (!existing) return undefined;
  const updated: Ticket = {
    ...existing,
    ...patch,
    id: existing.id,
    created: existing.created,
    updated: now(),
  };
  await fs.writeFile(ticketPath(projectRoot, id), serializeTicket(updated), "utf8");
  return updated;
}

export async function deleteTicket(projectRoot: string, id: string): Promise<boolean> {
  try {
    await fs.unlink(ticketPath(projectRoot, id));
    return true;
  } catch {
    return false;
  }
}

/**
 * Pull the next actionable ticket: the highest-priority ticket in "ready",
 * optionally moving it to "in-progress" and assigning it.
 */
export async function nextTicket(
  projectRoot: string,
  opts?: { claim?: boolean; assignee?: string },
): Promise<Ticket | undefined> {
  const ready = await listTickets(projectRoot, { state: "ready" });
  const candidate = ready[0];
  if (!candidate) return undefined;
  if (opts?.claim) {
    return updateTicket(projectRoot, candidate.id, {
      state: "in-progress",
      assignee: opts.assignee ?? candidate.assignee,
    });
  }
  return candidate;
}
