import assert from "node:assert/strict";
import { test } from "node:test";

const { renderFrame, formatDuration } = await import("../src/worker/guest-tui.ts");
import type { GuestView } from "../src/worker/guest-tui.ts";

const baseView = (over: Partial<GuestView> = {}): GuestView => ({
  label: "macbook",
  hostUrl: "https://host.example",
  hostLabel: "Studio",
  state: "offered",
  startedAt: 1000,
  expiresAt: 1000 + 90 * 60 * 1000,
  now: 1000 + 10 * 60 * 1000,
  runs: [],
  totals: { done: 0, failed: 0, stopped: 0, costUsd: 0, turns: 0 },
  ...over,
});

// Render without colour so assertions are about content, not ANSI codes.
const opts = { width: 80, height: 30, frame: 0, color: false };

test("formatDuration renders h/m/s sensibly", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(-5), "0s");
  assert.equal(formatDuration(9_000), "9s");
  assert.equal(formatDuration(90_000), "1m 30s");
  assert.equal(formatDuration(3_600_000 + 4 * 60_000), "1h 04m");
});

test("header shows guest label, host label and offered badge", () => {
  const out = renderFrame(baseView(), opts);
  assert.match(out, /mysteron guest/);
  assert.match(out, /macbook/);
  assert.match(out, /Studio/);
  assert.match(out, /offered/);
});

test("offer line shows remaining time", () => {
  const out = renderFrame(baseView(), opts);
  // 90m window, 10m elapsed → 80m = 1h 20m left.
  assert.match(out, /1h 20m left/);
});

test("idle hint when offered with no active runs", () => {
  const out = renderFrame(baseView(), opts);
  assert.match(out, /idle — waiting for work/);
});

test("active run card shows ticket title, tailed lines and stats", () => {
  const out = renderFrame(
    baseView({
      runs: [
        {
          runId: "r1",
          ticketTitle: "Wire the widget",
          lines: ["→ Edit src/a.ts", "✓ done"],
          costUsd: 0.1234,
          numTurns: 7,
        },
      ],
    }),
    opts,
  );
  assert.match(out, /Wire the widget/);
  assert.match(out, /Edit src\/a\.ts/);
  assert.match(out, /7 turns/);
  assert.match(out, /\$0\.1234/);
  assert.doesNotMatch(out, /idle/);
});

test("work line aggregates totals", () => {
  const out = renderFrame(
    baseView({ totals: { done: 3, failed: 1, stopped: 0, costUsd: 1.5, turns: 42 } }),
    opts,
  );
  assert.match(out, /3✓/);
  assert.match(out, /1✖/);
  assert.match(out, /\$1\.5000/);
  assert.match(out, /42 turns/);
});

test("connecting state shows a connecting hint and no offer line", () => {
  const out = renderFrame(baseView({ state: "connecting", hostLabel: undefined, expiresAt: undefined }), opts);
  assert.match(out, /connecting/);
  assert.doesNotMatch(out, /left/);
});

test("long lines are clamped to the available width", () => {
  const out = renderFrame(
    baseView({ runs: [{ runId: "r1", ticketTitle: "T", lines: ["x".repeat(500)] }] }),
    { ...opts, width: 40 },
  );
  for (const line of out.split("\n")) {
    assert.ok(line.length <= 40, `line too wide: ${line.length}`);
  }
});

test("colour mode wraps output in ANSI escapes", () => {
  const out = renderFrame(baseView(), { ...opts, color: true });
  // eslint-disable-next-line no-control-regex
  assert.match(out, /\x1b\[/);
});
