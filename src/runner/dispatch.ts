import { companionAllowsGuest, companionAllowsLocal, defaultCompanion, getCompanion } from "../core/companions.js";
import type { Companion, ProjectConfig, Ticket } from "../core/types.js";
import type { Run, RunManager } from "./manager.js";
import type { WorkerRegistry } from "../server/workers.js";

/**
 * One dispatch layer for the autopilot: it separates *deciding what runs* (the
 * {@link DispatchQueue} + {@link planAssignments}) from *how it runs* (the
 * {@link Executor}s). A ready+unblocked ticket becomes a queued work-item; the
 * planner picks a target for it (a local companion or an idle guest); the matching
 * executor starts it. Dedup (is this ticket/companion already in flight?) is the
 * queue's O(1) job, not an O(runs) scan of every run on every tick.
 */

/** Where a queued work-item should run. */
export type DispatchTarget =
  | { kind: "local"; companionId?: string }
  | { kind: "guest"; workerId: string; label: string };

/** A ticket waiting in (or claimed from) the dispatch queue. */
export interface WorkItem {
  ticket: Ticket;
  /** How many times this item has been dispatched and bounced back for a retry. */
  attempts: number;
  /** Epoch ms when the item first entered the queue (for wait-time observability). */
  enqueuedAt: number;
  /** Epoch ms before which the item must not be dispatched (retry backoff); 0 = now. */
  nextEligibleAt?: number;
  /** While in flight: the companion id the run is attributed to (so release frees it). */
  runsAs?: string;
}

/** A planned dispatch: which queued item runs, and where. */
export interface Assignment {
  item: WorkItem;
  target: DispatchTarget;
}

/** The companion a run for this ticket is attributed to (assigned one, else the soloist). */
export function runningCompanionId(config: ProjectConfig, ticket: Ticket): string | undefined {
  return (getCompanion(config, ticket.companionId) ?? defaultCompanion(config))?.id;
}

/**
 * The waiting/claimed work-items for one project's board. The board's `ready`
 * column is still the source of truth — {@link sync} reconciles the queue to it
 * each tick — but membership, in-flight dedup, depth and wait-time are answered
 * here in O(1) instead of by scanning the run history.
 */
export class DispatchQueue {
  /** Waiting items, in board (priority) order — rebuilt each sync so ordering is deterministic. */
  private order: WorkItem[] = [];
  private queuedIds = new Set<string>();
  /** ticketId -> in-flight item. */
  private claimed = new Map<string, WorkItem>();
  /** companionId -> count of in-flight runs attributed to it (a companion may have guest runs too). */
  private busy = new Map<string, number>();

  constructor(private now: () => number = Date.now) {}

  /**
   * Bring the queue in line with the currently ready+unblocked tickets: enqueue
   * newcomers, refresh snapshots, drop items no longer eligible, and re-order to
   * match the board. In-flight (claimed) items are left running, untouched.
   * Returns how many items were newly enqueued.
   */
  sync(tickets: Ticket[]): number {
    const prev = new Map(this.order.map((it) => [it.ticket.id, it]));
    this.order = [];
    this.queuedIds.clear();
    let added = 0;
    for (const ticket of tickets) {
      if (this.claimed.has(ticket.id)) continue; // running — not waiting
      const existing = prev.get(ticket.id);
      if (existing) {
        existing.ticket = ticket;
        this.order.push(existing);
      } else {
        this.order.push({ ticket, attempts: 0, enqueuedAt: this.now() });
        added++;
      }
      this.queuedIds.add(ticket.id);
    }
    return added;
  }

  /** The waiting items in dispatch order (read-only). */
  queued(): readonly WorkItem[] {
    return this.order;
  }

  /**
   * Waiting items ready to dispatch *now* — i.e. past any retry backoff. The
   * planner runs against these so a just-failed ticket isn't re-dispatched until
   * its backoff has elapsed, even though it stays in the queue.
   */
  eligible(): readonly WorkItem[] {
    const t = this.now();
    return this.order.filter((it) => (it.nextEligibleAt ?? 0) <= t);
  }

  /** Whether a ticket is waiting or in flight — O(1). */
  has(ticketId: string): boolean {
    return this.queuedIds.has(ticketId) || this.claimed.has(ticketId);
  }

  /** Whether a companion has any in-flight run (local or guest) — O(1). */
  isCompanionBusy(companionId: string): boolean {
    return (this.busy.get(companionId) ?? 0) > 0;
  }

  /** Items waiting to run. */
  depth(): number {
    return this.order.length;
  }

  /** Items currently running. */
  inFlight(): number {
    return this.claimed.size;
  }

  /** The longest a waiting item has sat in the queue (ms); 0 when empty. */
  maxWaitMs(): number {
    const t = this.now();
    let max = 0;
    for (const it of this.order) max = Math.max(max, t - it.enqueuedAt);
    return max;
  }

  /**
   * Move a waiting ticket in flight, attributing the run to `companionId` (so the
   * companion reads busy until the work is released). Returns the claimed item, or
   * undefined if it wasn't waiting.
   */
  claim(ticketId: string, companionId?: string): WorkItem | undefined {
    const idx = this.order.findIndex((it) => it.ticket.id === ticketId);
    if (idx < 0) return undefined;
    const [item] = this.order.splice(idx, 1);
    this.queuedIds.delete(ticketId);
    item.runsAs = companionId;
    this.claimed.set(ticketId, item);
    if (companionId) this.busy.set(companionId, (this.busy.get(companionId) ?? 0) + 1);
    return item;
  }

  /** Work landed — drop the in-flight claim. */
  release(ticketId: string): void {
    this.drop(ticketId);
  }

  /**
   * Work failed or needs another go — drop the claim and put the item back at the
   * tail of the queue, bumping its attempt count. `delayMs` holds it out of
   * dispatch for that long (retry backoff). (The next sync re-orders it to the
   * board's position; this just keeps the item, its attempts, and its backoff alive.)
   */
  requeue(ticketId: string, delayMs = 0): WorkItem | undefined {
    const item = this.drop(ticketId);
    if (!item) return undefined;
    item.attempts++;
    item.runsAs = undefined;
    item.nextEligibleAt = delayMs > 0 ? this.now() + delayMs : undefined;
    if (!this.queuedIds.has(ticketId)) {
      this.order.push(item);
      this.queuedIds.add(ticketId);
    }
    return item;
  }

  private drop(ticketId: string): WorkItem | undefined {
    const item = this.claimed.get(ticketId);
    if (!item) return undefined;
    this.claimed.delete(ticketId);
    if (item.runsAs) {
      const n = (this.busy.get(item.runsAs) ?? 0) - 1;
      if (n > 0) this.busy.set(item.runsAs, n);
      else this.busy.delete(item.runsAs);
    }
    return item;
  }
}

/** Whether a queued ticket may be handed to a guest worker (vs. kept for local). */
function guestEligible(ticket: Ticket, companion: Companion | undefined, hostMaxed: boolean): boolean {
  // Unassigned work always fans out. A companion-assigned ticket goes to a guest
  // only when the host can't run it locally — either it's maxed, or the companion
  // is pinned away from "local".
  if (!ticket.companionId) return true;
  return hostMaxed || !companionAllowsLocal(companion);
}

export interface PlanInput {
  /** Waiting items in priority order (from {@link DispatchQueue.queued}). */
  queued: readonly WorkItem[];
  config: ProjectConfig;
  /** Idle guest workers available to take a ticket this tick. */
  idleWorkers: { id: string; label: string }[];
  /** When the host's Claude budget is maxed, only guests run. */
  hostMaxed: boolean;
  /** Whether a companion already has an in-flight run (queue-backed, O(1)). */
  isCompanionBusy: (companionId: string) => boolean;
}

/**
 * Decide, for one tick, which waiting items run and where — the single place the
 * selection logic (blocked? already active? companion pinned local/guest? host
 * maxed?) lives, instead of being duplicated across a local and a guest path.
 *
 * Guests are assigned first (one ticket each, respecting "runs on" pins), then
 * local companions take their own work (one task at a time). A companion that is
 * already busy — including by a guest run of its work — is skipped locally, which
 * matches the previous per-companion lock. Ordering is deterministic: it follows
 * the queue order and the companion roster, not "whoever the tick picked first".
 */
export function planAssignments(input: PlanInput): Assignment[] {
  const { config, hostMaxed } = input;
  // The companion a run is *attributed* to — assigned one, else the soloist. Use
  // the same fallback the run path uses (runningCompanionId / startOnWorker) so an
  // unassigned ticket still honours the soloist's "runs on" host pin instead of
  // fanning out to any guest.
  const companionFor = (t: Ticket) => getCompanion(config, t.companionId) ?? defaultCompanion(config);
  const assignments: Assignment[] = [];
  const takenTickets = new Set<string>();
  const tentativeBusy = new Set<string>(); // companions spoken for during this plan

  for (const worker of input.idleWorkers) {
    const item = input.queued.find(
      (it) =>
        !takenTickets.has(it.ticket.id) &&
        guestEligible(it.ticket, companionFor(it.ticket), hostMaxed) &&
        companionAllowsGuest(companionFor(it.ticket), worker.label),
    );
    if (!item) continue;
    takenTickets.add(item.ticket.id);
    const cid = runningCompanionId(config, item.ticket);
    if (cid) tentativeBusy.add(cid);
    assignments.push({ item, target: { kind: "guest", workerId: worker.id, label: worker.label } });
  }

  if (!hostMaxed) {
    for (const companion of config.companions) {
      if (!companionAllowsLocal(companion)) continue;
      if (tentativeBusy.has(companion.id) || input.isCompanionBusy(companion.id)) continue;
      const item = input.queued.find(
        (it) =>
          !takenTickets.has(it.ticket.id) &&
          (it.ticket.companionId === companion.id || (companion.role === "soloist" && !it.ticket.companionId)),
      );
      if (!item) continue;
      takenTickets.add(item.ticket.id);
      tentativeBusy.add(companion.id);
      assignments.push({ item, target: { kind: "local", companionId: companion.id } });
    }
  }

  return assignments;
}

/** Context shared by every executor for one project. */
export interface ExecutorContext {
  projectId: string;
  projectRoot: string;
  config: ProjectConfig;
}

/**
 * How a work-item runs. Both the local worktree runner and the guest worker
 * implement this, so the autopilot dispatches uniformly — the same way landing
 * is already unified through landGuestPatch.
 */
export interface Executor {
  readonly kind: DispatchTarget["kind"];
  /** Start the ticket; resolves to the Run, or undefined if it couldn't start. */
  start(ticket: Ticket): Promise<Run | undefined>;
}

class LocalExecutor implements Executor {
  readonly kind = "local" as const;
  constructor(
    private runs: RunManager,
    private ctx: ExecutorContext,
  ) {}
  start(ticket: Ticket): Promise<Run | undefined> {
    return this.runs.start({ ...this.ctx, ticket });
  }
}

class GuestExecutor implements Executor {
  readonly kind = "guest" as const;
  constructor(
    private runs: RunManager,
    private workers: WorkerRegistry,
    private ctx: ExecutorContext,
    private worker: { id: string; label: string },
  ) {}
  start(ticket: Ticket): Promise<Run | undefined> {
    return this.runs.startOnWorker({ ...this.ctx, ticket }, this.workers, this.worker);
  }
}

/** The executor for a planned target. */
export function executorFor(
  target: DispatchTarget,
  runs: RunManager,
  workers: WorkerRegistry,
  ctx: ExecutorContext,
): Executor {
  return target.kind === "guest"
    ? new GuestExecutor(runs, workers, ctx, { id: target.workerId, label: target.label })
    : new LocalExecutor(runs, ctx);
}
