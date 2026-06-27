import { promises as fs } from "node:fs";
import path from "node:path";
import { mysteronHome } from "./paths.js";
import { loadRegistry } from "./registry.js";

/**
 * A tiny, JS-native cost ledger. Agent runs report a USD cost when they finish
 * (Claude Code's `total_cost_usd`); we push one entry per run here so spend can
 * be explored across every project. It lives in the central Mysteron home
 * (~/.mysteron/costs.json), NOT in any project — costs are machine/account-wide
 * and shouldn't pollute a project's git history. A single JSON file is plenty
 * for this volume and keeps us dependency-free, matching the registry/settings
 * stores.
 */

export interface CostEntry {
  /** The run that produced this cost (the upsert key — a re-recorded run replaces its entry). */
  runId: string;
  projectId: string;
  ticketId: string;
  ticketTitle: string;
  /** Companion that ran it, for display. */
  companion: string;
  costUsd: number;
  numTurns?: number;
  startedAt: string;
  endedAt: string;
}

/** The minimal run shape needed to record a cost (avoids importing the RunManager). */
export interface RunCostInput {
  id: string;
  projectId: string;
  ticketId: string;
  ticketTitle: string;
  companion: string;
  costUsd?: number;
  numTurns?: number;
  startedAt: string;
  endedAt?: string;
}

export function costsPath(): string {
  return path.join(mysteronHome(), "costs.json");
}

export async function loadCostEntries(): Promise<CostEntry[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(costsPath(), "utf8")) as { entries?: CostEntry[] };
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

// Serialise read-modify-write so concurrent run completions (parallel companions)
// don't clobber each other's entries. Best-effort: a disk error never propagates.
let writeQueue: Promise<void> = Promise.resolve();

/**
 * Push a finished run's cost to the ledger. No-op when the run reported no cost
 * (e.g. it failed to launch, or used a custom agent that doesn't emit one).
 * Upserts by runId so a guest run recorded twice doesn't double-count.
 */
export function recordRunCost(run: RunCostInput): Promise<void> {
  if (typeof run.costUsd !== "number" || !Number.isFinite(run.costUsd) || run.costUsd < 0) {
    return Promise.resolve();
  }
  const entry: CostEntry = {
    runId: run.id,
    projectId: run.projectId,
    ticketId: run.ticketId,
    ticketTitle: run.ticketTitle,
    companion: run.companion,
    costUsd: run.costUsd,
    numTurns: run.numTurns,
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? run.startedAt,
  };
  writeQueue = writeQueue
    .then(async () => {
      const entries = await loadCostEntries();
      const i = entries.findIndex((e) => e.runId === entry.runId);
      if (i >= 0) entries[i] = entry;
      else entries.push(entry);
      await fs.mkdir(mysteronHome(), { recursive: true });
      await fs.writeFile(costsPath(), JSON.stringify({ entries }, null, 2) + "\n", "utf8");
    })
    .catch(() => undefined); // keep the chain alive for the next writer
  return writeQueue;
}

/** YYYY-MM-DD bucket for a timestamp (local date). */
function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

export interface DailyCost {
  date: string;
  totalUsd: number;
  runs: number;
}

export interface ProjectCost {
  projectId: string;
  name: string;
  totalUsd: number;
  runs: number;
  /** Distinct tickets that incurred cost. */
  tickets: number;
  avgTicketUsd: number;
  avgRunUsd: number;
  daily: DailyCost[];
}

export interface TicketCost {
  projectId: string;
  projectName: string;
  ticketId: string;
  ticketTitle: string;
  totalUsd: number;
  runs: number;
}

export interface CostStats {
  totalUsd: number;
  runs: number;
  /** Distinct tickets across all projects. */
  tickets: number;
  avgTicketUsd: number;
  avgRunUsd: number;
  byProject: ProjectCost[];
  /** Overall spend per day, across every project (oldest first). */
  daily: DailyCost[];
  /** The most expensive tickets, biggest first. */
  topTickets: TicketCost[];
}

function emptyDaily(date: string): DailyCost {
  return { date, totalUsd: 0, runs: 0 };
}

function sortedDaily(map: Map<string, DailyCost>): DailyCost[] {
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Aggregate the ledger into a cross-project spend report: overall totals, a
 * per-project breakdown (each with its own daily series), an overall daily
 * series, and the priciest tickets. Project names come from the registry,
 * falling back to the id for projects that have since been unregistered.
 */
export async function costStats(): Promise<CostStats> {
  const entries = await loadCostEntries();
  const reg = await loadRegistry();
  const nameById = new Map(reg.projects.map((p) => [p.id, p.name]));

  const overallDaily = new Map<string, DailyCost>();
  const ticketKeys = new Set<string>();
  const projects = new Map<
    string,
    { totalUsd: number; runs: number; tickets: Set<string>; daily: Map<string, DailyCost> }
  >();
  const tickets = new Map<string, TicketCost>();
  let totalUsd = 0;

  for (const e of entries) {
    totalUsd += e.costUsd;
    const day = dayKey(e.endedAt);
    const od = overallDaily.get(day) ?? emptyDaily(day);
    od.totalUsd += e.costUsd;
    od.runs += 1;
    overallDaily.set(day, od);

    const tKey = `${e.projectId}/${e.ticketId}`;
    ticketKeys.add(tKey);

    let p = projects.get(e.projectId);
    if (!p) {
      p = { totalUsd: 0, runs: 0, tickets: new Set(), daily: new Map() };
      projects.set(e.projectId, p);
    }
    p.totalUsd += e.costUsd;
    p.runs += 1;
    p.tickets.add(e.ticketId);
    const pd = p.daily.get(day) ?? emptyDaily(day);
    pd.totalUsd += e.costUsd;
    pd.runs += 1;
    p.daily.set(day, pd);

    const t = tickets.get(tKey) ?? {
      projectId: e.projectId,
      projectName: nameById.get(e.projectId) ?? e.projectId,
      ticketId: e.ticketId,
      ticketTitle: e.ticketTitle,
      totalUsd: 0,
      runs: 0,
    };
    t.totalUsd += e.costUsd;
    t.runs += 1;
    tickets.set(tKey, t);
  }

  const byProject: ProjectCost[] = [...projects.entries()]
    .map(([projectId, p]) => ({
      projectId,
      name: nameById.get(projectId) ?? projectId,
      totalUsd: p.totalUsd,
      runs: p.runs,
      tickets: p.tickets.size,
      avgTicketUsd: p.tickets.size ? p.totalUsd / p.tickets.size : 0,
      avgRunUsd: p.runs ? p.totalUsd / p.runs : 0,
      daily: sortedDaily(p.daily),
    }))
    .sort((a, b) => b.totalUsd - a.totalUsd);

  const topTickets = [...tickets.values()].sort((a, b) => b.totalUsd - a.totalUsd).slice(0, 10);

  return {
    totalUsd,
    runs: entries.length,
    tickets: ticketKeys.size,
    avgTicketUsd: ticketKeys.size ? totalUsd / ticketKeys.size : 0,
    avgRunUsd: entries.length ? totalUsd / entries.length : 0,
    byProject,
    daily: sortedDaily(overallDaily),
    topTickets,
  };
}
