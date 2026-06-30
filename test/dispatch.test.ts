import assert from "node:assert/strict";
import { test } from "node:test";

import { DispatchQueue, planAssignments } from "../src/runner/dispatch.js";
import type { Companion, ProjectConfig, Ticket } from "../src/core/types.js";

function ticket(id: string, over: Partial<Ticket> = {}): Ticket {
  return {
    id,
    title: id,
    state: "ready",
    priority: "medium",
    labels: [],
    created: "",
    updated: "",
    body: "",
    ...over,
  };
}

function companion(id: string, role: string, runsOn?: string[]): Companion {
  return { id, name: id, role, avatarSeed: id, ...(runsOn ? { runsOn } : {}) };
}

function config(companions: Companion[]): ProjectConfig {
  return { id: "p", name: "P", recipe: "solo", companions, plugins: [], yolo: false, createdAt: "" };
}

const ids = (items: readonly { ticket: Ticket }[]) => items.map((i) => i.ticket.id);

// --- DispatchQueue: ordering, dedup, claim/release/requeue -------------------

test("sync queues ready tickets in board order and is idempotent", () => {
  const q = new DispatchQueue();
  assert.equal(q.sync([ticket("a"), ticket("b"), ticket("c")]), 3);
  assert.deepEqual(ids(q.queued()), ["a", "b", "c"]);
  // Re-syncing the same set adds nothing and re-orders to the board.
  assert.equal(q.sync([ticket("c"), ticket("a"), ticket("b")]), 0);
  assert.deepEqual(ids(q.queued()), ["c", "a", "b"]);
  assert.equal(q.depth(), 3);
});

test("sync drops queued tickets no longer ready, keeps in-flight ones running", () => {
  const q = new DispatchQueue();
  q.sync([ticket("a"), ticket("b")]);
  q.claim("a", "c1");
  // 'a' is in flight; the board now shows only 'a' ready (b was pulled).
  q.sync([ticket("a")]);
  assert.equal(q.has("a"), true, "in-flight item survives reconcile");
  assert.equal(q.has("b"), false, "queued-but-not-ready item is dropped");
  assert.equal(q.depth(), 0);
  assert.equal(q.inFlight(), 1);
});

test("claim marks ticket + companion busy; release frees them (O(1) dedup)", () => {
  const q = new DispatchQueue();
  q.sync([ticket("a")]);
  const item = q.claim("a", "c1");
  assert.ok(item);
  assert.equal(q.has("a"), true);
  assert.equal(q.isCompanionBusy("c1"), true);
  assert.equal(q.depth(), 0);
  assert.equal(q.inFlight(), 1);
  q.release("a");
  assert.equal(q.has("a"), false);
  assert.equal(q.isCompanionBusy("c1"), false);
  assert.equal(q.inFlight(), 0);
});

test("a companion stays busy until all its in-flight runs release (ref-counted)", () => {
  const q = new DispatchQueue();
  q.sync([ticket("a"), ticket("b")]);
  q.claim("a", "c1");
  q.claim("b", "c1"); // e.g. two guests running the soloist's unassigned work
  assert.equal(q.isCompanionBusy("c1"), true);
  q.release("a");
  assert.equal(q.isCompanionBusy("c1"), true, "still busy with b");
  q.release("b");
  assert.equal(q.isCompanionBusy("c1"), false);
});

test("requeue bumps attempts, frees the companion, and survives the next sync", () => {
  const q = new DispatchQueue();
  q.sync([ticket("a")]);
  q.claim("a", "c1");
  const back = q.requeue("a");
  assert.equal(back?.attempts, 1);
  assert.equal(q.isCompanionBusy("c1"), false);
  assert.equal(q.depth(), 1);
  // The ticket is still ready next tick — attempts must carry across the sync.
  q.sync([ticket("a")]);
  q.claim("a", "c1");
  assert.equal(q.requeue("a")?.attempts, 2);
});

test("requeue with a backoff holds an item out of dispatch until it's due", () => {
  let clock = 1000;
  const q = new DispatchQueue(() => clock);
  q.sync([ticket("a")]);
  q.claim("a", "c1");
  q.requeue("a", 500); // not eligible until clock 1500
  assert.equal(q.depth(), 1, "still queued");
  assert.deepEqual(ids(q.eligible()), [], "not yet eligible");
  clock = 1499;
  assert.deepEqual(ids(q.eligible()), [], "still backing off");
  clock = 1500;
  assert.deepEqual(ids(q.eligible()), ["a"], "eligible once the backoff elapses");
});

test("a backoff survives the next sync (attempts + eligibility both carry over)", () => {
  let clock = 1000;
  const q = new DispatchQueue(() => clock);
  q.sync([ticket("a")]);
  q.claim("a", "c1");
  q.requeue("a", 500);
  // The ticket is still ready next tick; the backoff must not be reset by sync.
  q.sync([ticket("a")]);
  assert.deepEqual(ids(q.eligible()), [], "still backing off after sync");
  assert.equal(q.queued()[0].attempts, 1);
  clock = 1500;
  assert.deepEqual(ids(q.eligible()), ["a"]);
});

test("maxWaitMs reports the longest a queued item has waited", () => {
  let clock = 1000;
  const q = new DispatchQueue(() => clock);
  q.sync([ticket("a")]);
  clock = 1500;
  assert.equal(q.maxWaitMs(), 500);
  q.claim("a", "c1");
  assert.equal(q.maxWaitMs(), 0, "in-flight items aren't waiting");
});

// --- planAssignments: target selection ---------------------------------------

const queueOf = (...tickets: Ticket[]) => {
  const q = new DispatchQueue();
  q.sync(tickets);
  return q.queued();
};
const notBusy = () => false;

test("unassigned work fans out to an idle guest", () => {
  const plan = planAssignments({
    queued: queueOf(ticket("a")),
    config: config([companion("c1", "soloist")]),
    idleWorkers: [{ id: "w1", label: "box" }],
    hostMaxed: false,
    isCompanionBusy: notBusy,
  });
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0].target, { kind: "guest", workerId: "w1", label: "box" });
});

test("assigned work runs locally when the host can, not on a guest", () => {
  const plan = planAssignments({
    queued: queueOf(ticket("a", { companionId: "c1" })),
    config: config([companion("c1", "soloist")]),
    idleWorkers: [{ id: "w1", label: "box" }],
    hostMaxed: false,
    isCompanionBusy: notBusy,
  });
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0].target, { kind: "local", companionId: "c1" });
});

test("a companion pinned away from local goes to a guest only", () => {
  const cfg = config([companion("c1", "soloist", ["box"])]);
  const t = ticket("a", { companionId: "c1" });
  // Pinned to "box": runs on the matching guest...
  const onBox = planAssignments({
    queued: queueOf(t),
    config: cfg,
    idleWorkers: [{ id: "w1", label: "box" }],
    hostMaxed: false,
    isCompanionBusy: notBusy,
  });
  assert.deepEqual(onBox[0]?.target, { kind: "guest", workerId: "w1", label: "box" });
  // ...but never on a guest it isn't pinned to, and never locally.
  const onOther = planAssignments({
    queued: queueOf(t),
    config: cfg,
    idleWorkers: [{ id: "w2", label: "elsewhere" }],
    hostMaxed: false,
    isCompanionBusy: notBusy,
  });
  assert.equal(onOther.length, 0, "no eligible host — the ticket waits");
});

test("when the host is maxed, only guests are assigned", () => {
  const plan = planAssignments({
    queued: queueOf(ticket("a", { companionId: "c1" })),
    config: config([companion("c1", "soloist")]),
    idleWorkers: [{ id: "w1", label: "box" }],
    hostMaxed: true,
    isCompanionBusy: notBusy,
  });
  assert.deepEqual(plan[0]?.target, { kind: "guest", workerId: "w1", label: "box" });

  // ...and with no guest, a maxed host assigns nothing.
  const none = planAssignments({
    queued: queueOf(ticket("a", { companionId: "c1" })),
    config: config([companion("c1", "soloist")]),
    idleWorkers: [],
    hostMaxed: true,
    isCompanionBusy: notBusy,
  });
  assert.equal(none.length, 0);
});

test("unassigned work honours the soloist's host pin — never fans to a forbidden guest", () => {
  // Soloist pinned to local only. Unassigned work is attributed to it, so it must
  // NOT be handed to a guest — it runs locally instead.
  const localOnly = planAssignments({
    queued: queueOf(ticket("a")),
    config: config([companion("c1", "soloist", ["local"])]),
    idleWorkers: [{ id: "w1", label: "box" }],
    hostMaxed: false,
    isCompanionBusy: notBusy,
  });
  assert.deepEqual(localOnly[0]?.target, { kind: "local", companionId: "c1" });

  // Soloist pinned to "box" only: unassigned work may go to "box"...
  const onBox = planAssignments({
    queued: queueOf(ticket("a")),
    config: config([companion("c1", "soloist", ["box"])]),
    idleWorkers: [{ id: "w1", label: "box" }],
    hostMaxed: false,
    isCompanionBusy: notBusy,
  });
  assert.deepEqual(onBox[0]?.target, { kind: "guest", workerId: "w1", label: "box" });

  // ...but never to a guest it isn't pinned to.
  const onOther = planAssignments({
    queued: queueOf(ticket("a")),
    config: config([companion("c1", "soloist", ["box"])]),
    idleWorkers: [{ id: "w2", label: "elsewhere" }],
    hostMaxed: false,
    isCompanionBusy: notBusy,
  });
  assert.equal(onOther.length, 0, "unassigned work waits rather than running on a forbidden host");
});

test("a busy companion is not given a second local task", () => {
  const plan = planAssignments({
    queued: queueOf(ticket("a", { companionId: "c1" })),
    config: config([companion("c1", "soloist")]),
    idleWorkers: [],
    hostMaxed: false,
    isCompanionBusy: (id) => id === "c1",
  });
  assert.equal(plan.length, 0);
});

test("each companion takes one task and each worker one ticket, in order", () => {
  const plan = planAssignments({
    queued: queueOf(
      ticket("a", { companionId: "c2" }),
      ticket("b", { companionId: "c1" }),
      ticket("c", { companionId: "c1" }),
    ),
    config: config([companion("c1", "soloist"), companion("c2", "backend")]),
    idleWorkers: [],
    hostMaxed: false,
    isCompanionBusy: notBusy,
  });
  // c1 takes its first ticket (b), c2 takes a; c (c1's second) is left for later.
  assert.deepEqual(
    plan.map((a) => [a.target.kind === "local" ? a.target.companionId : "?", a.item.ticket.id]),
    [
      ["c1", "b"],
      ["c2", "a"],
    ],
  );
});

test("a guest taking the soloist's unassigned work blocks a duplicate local run", () => {
  // One unassigned ticket, one guest, one local soloist: it must run once, on the guest.
  const plan = planAssignments({
    queued: queueOf(ticket("a")),
    config: config([companion("c1", "soloist")]),
    idleWorkers: [{ id: "w1", label: "box" }],
    hostMaxed: false,
    isCompanionBusy: notBusy,
  });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].target.kind, "guest");
});
