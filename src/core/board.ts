import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { nanoid } from "nanoid";
import { attachmentsDir, boardDir } from "./paths.js";
import { unmergedBranchTicketIds } from "./git.js";
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
    blockedBy: Array.isArray(data.blockedBy) ? (data.blockedBy as string[]) : undefined,
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
    ...(t.blockedBy?.length ? { blockedBy: t.blockedBy } : {}),
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
    blockedBy?: string[];
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
    blockedBy: input.blockedBy?.length ? input.blockedBy : undefined,
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

// --- Dependencies --------------------------------------------------------
// A ticket can be "blocked by" other tickets: it waits in the queue until each
// of them has landed in main (is done and, if it produced a branch, merged).
// The inverse relationship — the tickets a given one "blocks" — is derived.

/** One resolved "blocked by" edge: the upstream ticket and whether it has landed. */
export interface DependencyLink {
  id: string;
  /** Upstream title (falls back to the id when the ticket no longer exists). */
  title: string;
  state: TicketState;
  /** Done and not sitting on an unmerged branch — i.e. it's in main. */
  satisfied: boolean;
  /** The id no longer matches any ticket (treated as satisfied so work isn't stuck forever). */
  missing: boolean;
}

/** A lightweight reference to a downstream ticket that this one blocks. */
export interface TicketRef {
  id: string;
  title: string;
  state: TicketState;
}

export interface EnrichedTicket extends Ticket {
  /** Resolved "blocked by" dependencies — these must land before this ticket runs. */
  dependencies: DependencyLink[];
  /** Tickets that list this one as a dependency (the downstream waiters). */
  blocks: TicketRef[];
  /** True while any dependency hasn't landed in main yet. */
  blocked: boolean;
}

/** Has a ticket landed in main: marked done and not waiting on an open branch. */
export function ticketLanded(t: Ticket, unmergedTicketIds: Set<string>): boolean {
  return t.state === "done" && !unmergedTicketIds.has(t.id);
}

function resolveDependencies(
  ticket: Ticket,
  byId: Map<string, Ticket>,
  unmergedTicketIds: Set<string>,
): DependencyLink[] {
  return (ticket.blockedBy ?? []).map((id) => {
    const dep = byId.get(id);
    if (!dep) return { id, title: id, state: "done", satisfied: true, missing: true };
    return { id, title: dep.title, state: dep.state, satisfied: ticketLanded(dep, unmergedTicketIds), missing: false };
  });
}

/** Resolve every ticket's dependencies + downstream blocks, flagging blocked ones. */
export async function listTicketsEnriched(projectRoot: string): Promise<EnrichedTicket[]> {
  const all = await listTickets(projectRoot);
  const byId = new Map(all.map((t) => [t.id, t]));
  const depIds = new Set(all.flatMap((t) => t.blockedBy ?? []));
  const unmerged = depIds.size ? await unmergedBranchTicketIds(projectRoot, depIds) : new Set<string>();
  const blocksMap = new Map<string, TicketRef[]>();
  for (const t of all) {
    for (const dep of t.blockedBy ?? []) {
      const refs = blocksMap.get(dep) ?? [];
      refs.push({ id: t.id, title: t.title, state: t.state });
      blocksMap.set(dep, refs);
    }
  }
  return all.map((t) => {
    const dependencies = resolveDependencies(t, byId, unmerged);
    return { ...t, dependencies, blocks: blocksMap.get(t.id) ?? [], blocked: dependencies.some((d) => !d.satisfied) };
  });
}

/** Ids of tickets currently blocked by a dependency that hasn't landed in main. */
export async function blockedTicketIds(projectRoot: string): Promise<Set<string>> {
  const all = await listTickets(projectRoot);
  const withDeps = all.filter((t) => t.blockedBy?.length);
  if (withDeps.length === 0) return new Set();
  const byId = new Map(all.map((t) => [t.id, t]));
  const depIds = new Set(withDeps.flatMap((t) => t.blockedBy!));
  const unmerged = await unmergedBranchTicketIds(projectRoot, depIds);
  const blocked = new Set<string>();
  for (const t of withDeps) {
    if (resolveDependencies(t, byId, unmerged).some((d) => !d.satisfied)) blocked.add(t.id);
  }
  return blocked;
}

/**
 * Pull the next actionable ticket: the highest-priority *unblocked* ticket in
 * "ready", optionally moving it to "in-progress" and assigning it. Tickets blocked
 * by an unlanded dependency are skipped so they pause in the queue.
 */
export async function nextTicket(
  projectRoot: string,
  opts?: { claim?: boolean; assignee?: string },
): Promise<Ticket | undefined> {
  const ready = await listTickets(projectRoot, { state: "ready" });
  const blocked = await blockedTicketIds(projectRoot);
  const candidate = ready.find((t) => !blocked.has(t.id));
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
 * The highest-priority *unblocked* "ready" ticket assigned to a given companion
 * (used by the per-companion autopilot so each companion only does its own work).
 */
export async function nextTicketForCompanion(
  projectRoot: string,
  companionId: string,
  opts?: { includeUnassigned?: boolean },
): Promise<Ticket | undefined> {
  const ready = await listTickets(projectRoot, { state: "ready" });
  const blocked = await blockedTicketIds(projectRoot);
  return ready.find(
    (t) =>
      !blocked.has(t.id) &&
      (t.companionId === companionId || (opts?.includeUnassigned && !t.companionId)),
  );
}
