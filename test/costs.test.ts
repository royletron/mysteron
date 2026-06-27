import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// Isolate the cost ledger + registry under a temp MYSTERON_HOME before import.
const tmp = path.join(os.tmpdir(), `mysteron-costs-${process.pid}`);
process.env.MYSTERON_HOME = path.join(tmp, "home");

const { recordRunCost, loadCostEntries, costStats, costsPath } = await import("../src/core/costs.js");
const { saveRegistry } = await import("../src/core/registry.js");

const run = (over: Partial<Parameters<typeof recordRunCost>[0]> = {}) => ({
  id: "r1",
  projectId: "p1",
  ticketId: "t1",
  ticketTitle: "First ticket",
  companion: "Waldorf",
  costUsd: 0.1,
  numTurns: 3,
  startedAt: "2026-06-01T10:00:00.000Z",
  endedAt: "2026-06-01T10:05:00.000Z",
  ...over,
});

before(async () => {
  await fs.mkdir(path.join(tmp, "home"), { recursive: true });
  await saveRegistry({ projects: [{ id: "p1", name: "Alpha", path: "/tmp/alpha", createdAt: "2026-01-01T00:00:00.000Z" }] });
});
after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

test("records a run cost and upserts by runId", async () => {
  await recordRunCost(run());
  await recordRunCost(run({ costUsd: 0.25 })); // same id → replaces, not appended
  const entries = await loadCostEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].costUsd, 0.25);
  // Persisted to the central home, not a project.
  assert.match(costsPath(), /home\/costs\.json$/);
});

test("ignores runs that report no (or invalid) cost", async () => {
  await recordRunCost(run({ id: "no-cost", costUsd: undefined }));
  await recordRunCost(run({ id: "nan", costUsd: Number.NaN }));
  await recordRunCost(run({ id: "neg", costUsd: -1 }));
  const entries = await loadCostEntries();
  assert.equal(entries.length, 1); // only r1 from the previous test
});

test("aggregates cross-project stats", async () => {
  // A second run on the same ticket, plus a run on a different project/ticket.
  await recordRunCost(run({ id: "r2", costUsd: 0.5, endedAt: "2026-06-02T09:00:00.000Z" }));
  await recordRunCost(
    run({ id: "r3", projectId: "p2", ticketId: "t9", ticketTitle: "Other", costUsd: 1, endedAt: "2026-06-02T11:00:00.000Z" }),
  );

  const stats = await costStats();
  // r1 (0.25) + r2 (0.5) + r3 (1) = 1.75 across 3 runs / 2 distinct tickets.
  assert.equal(stats.runs, 3);
  assert.equal(stats.tickets, 2);
  assert.ok(Math.abs(stats.totalUsd - 1.75) < 1e-9);
  assert.ok(Math.abs(stats.avgTicketUsd - 0.875) < 1e-9);

  // Projects sorted by spend, names resolved from the registry (id fallback otherwise).
  assert.equal(stats.byProject.length, 2);
  const alpha = stats.byProject.find((p) => p.projectId === "p1")!;
  assert.equal(alpha.name, "Alpha");
  assert.equal(alpha.runs, 2);
  assert.equal(alpha.tickets, 1);
  const p2 = stats.byProject.find((p) => p.projectId === "p2")!;
  assert.equal(p2.name, "p2"); // unregistered → id fallback

  // Daily series is ordered oldest-first and buckets by end date.
  assert.deepEqual(
    stats.daily.map((d) => d.date),
    ["2026-06-01", "2026-06-02"],
  );

  // Priciest ticket first: t9 ($1) outranks t1 (0.25 + 0.5 = 0.75).
  assert.equal(stats.topTickets[0].ticketId, "t9");
  assert.equal(stats.topTickets[1].ticketId, "t1");
  assert.ok(Math.abs(stats.topTickets[1].totalUsd - 0.75) < 1e-9);
});
