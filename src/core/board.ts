import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { nanoid } from "nanoid";
import { attachmentsDir, boardDir } from "./paths.js";
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
    companionId: data.companionId as string | undefined,
    assignee: data.assignee as string | undefined,
    labels: Array.isArray(data.labels) ? (data.labels as string[]) : [],
    created: (data.created as string) ?? now(),
    updated: (data.updated as string) ?? now(),
    body: content.trim(),
    attachments: Array.isArray(data.attachments) ? (data.attachments as string[]) : undefined,
  };
}

function serializeTicket(t: Ticket): string {
  const fm = {
    title: t.title,
    state: t.state,
    priority: t.priority,
    ...(t.companionId ? { companionId: t.companionId } : {}),
    ...(t.assignee ? { assignee: t.assignee } : {}),
    labels: t.labels,
    created: t.created,
    updated: t.updated,
    ...(t.attachments?.length ? { attachments: t.attachments } : {}),
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
    companionId?: string;
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
    companionId: input.companionId,
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
    await fs.rm(attachmentsDir(projectRoot, id), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** Strip any path components so an attachment name can't escape its ticket dir. */
function safeName(name: string): string {
  return path.basename(name).replace(/[^\w.\- ]+/g, "_");
}

/** Save an image attachment for a ticket and record it in the ticket's frontmatter. */
export async function addAttachment(
  projectRoot: string,
  id: string,
  name: string,
  data: Buffer,
): Promise<Ticket | undefined> {
  const ticket = await getTicket(projectRoot, id);
  if (!ticket) return undefined;
  const dir = attachmentsDir(projectRoot, id);
  await fs.mkdir(dir, { recursive: true });

  // Keep names unique so a re-upload doesn't clobber an existing attachment.
  let file = safeName(name);
  const existing = new Set(ticket.attachments ?? []);
  if (existing.has(file)) {
    const ext = path.extname(file);
    file = `${path.basename(file, ext)}-${nanoid(4)}${ext}`;
  }
  await fs.writeFile(path.join(dir, file), data);
  return updateTicket(projectRoot, id, { attachments: [...(ticket.attachments ?? []), file] });
}

export async function removeAttachment(
  projectRoot: string,
  id: string,
  name: string,
): Promise<Ticket | undefined> {
  const ticket = await getTicket(projectRoot, id);
  if (!ticket) return undefined;
  const file = safeName(name);
  await fs.rm(path.join(attachmentsDir(projectRoot, id), file), { force: true });
  return updateTicket(projectRoot, id, {
    attachments: (ticket.attachments ?? []).filter((a) => a !== file),
  });
}

/** Raw bytes of one attachment, or undefined if it's missing. */
export async function readAttachment(
  projectRoot: string,
  id: string,
  name: string,
): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(path.join(attachmentsDir(projectRoot, id), safeName(name)));
  } catch {
    return undefined;
  }
}

/** Default age after which a "done" ticket is swept into the bin. */
export const BIN_AFTER_MS = 48 * 60 * 60 * 1000;

/** Move tickets that have sat in "done" longer than maxAgeMs into the bin.
 *  Returns how many were moved. */
export async function binStaleDone(projectRoot: string, maxAgeMs = BIN_AFTER_MS): Promise<number> {
  const cutoff = Date.now() - maxAgeMs;
  const done = await listTickets(projectRoot, { state: "done" });
  let moved = 0;
  for (const t of done) {
    if (Date.parse(t.updated) <= cutoff) {
      await updateTicket(projectRoot, t.id, { state: "bin" });
      moved++;
    }
  }
  return moved;
}

/** Move every ticket currently in one column to another state (or the bin) in
 *  one go. Returns how many tickets were moved. */
export async function moveTicketsByState(
  projectRoot: string,
  from: TicketState,
  to: TicketState,
): Promise<number> {
  if (from === to) return 0;
  const tickets = await listTickets(projectRoot, { state: from });
  for (const t of tickets) {
    await updateTicket(projectRoot, t.id, { state: to });
  }
  return tickets.length;
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

/**
 * The highest-priority "ready" ticket assigned to a given companion (used by the
 * per-companion autopilot so each companion only does its own work).
 */
export async function nextTicketForCompanion(
  projectRoot: string,
  companionId: string,
  opts?: { includeUnassigned?: boolean },
): Promise<Ticket | undefined> {
  const ready = await listTickets(projectRoot, { state: "ready" });
  return ready.find(
    (t) => t.companionId === companionId || (opts?.includeUnassigned && !t.companionId),
  );
}
