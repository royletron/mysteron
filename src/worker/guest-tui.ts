import { createLogUpdate } from "log-update";
import type { GuestQuota } from "../core/worker-protocol.js";
import type {
  GuestConnection,
  GuestRunDone,
  GuestRunLine,
  GuestRunStart,
  GuestRunStats,
  GuestStatus,
} from "./guest.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Per-active-run card shown in the dashboard. */
export interface RunCard {
  runId: string;
  ticketTitle: string;
  lines: string[];
  costUsd?: number;
  numTurns?: number;
}

/** Everything the dashboard needs to draw a frame. Kept plain so it's easy to test. */
export interface GuestView {
  label: string;
  hostUrl: string;
  hostLabel?: string;
  state: GuestStatus["state"];
  message?: string;
  startedAt: number;
  expiresAt?: number;
  now: number;
  runs: RunCard[];
  totals: { done: number; failed: number; stopped: number; costUsd: number; turns: number };
  /** This guest's current Claude allowance, captured like the host captures its own. */
  quota?: GuestQuota;
}

export interface RenderOpts {
  width: number;
  height: number;
  frame: number;
  color: boolean;
}

const ESC = "\x1b[";

/** Build a tiny ANSI palette; every helper is a no-op when colour is disabled. */
export function palette(color: boolean) {
  const wrap = (code: string) => (s: string) => (color ? `${ESC}${code}m${s}${ESC}0m` : s);
  return {
    bold: wrap("1"),
    dim: wrap("2"),
    red: wrap("31"),
    green: wrap("32"),
    yellow: wrap("33"),
    blue: wrap("34"),
    magenta: wrap("35"),
    cyan: wrap("36"),
    gray: wrap("90"),
  };
}

/** Visible length, ignoring ANSI escape sequences. */
function visibleLen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Truncate to a visible width, preserving any trailing reset by re-clamping on raw text. */
function clamp(s: string, width: number): string {
  if (visibleLen(s) <= width) return s;
  // Strip colour first, then clamp — keeps the maths simple for over-long lines.
  // eslint-disable-next-line no-control-regex
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  return plain.slice(0, Math.max(0, width - 1)) + "…";
}

/** Human duration like "1h 04m", "12m 30s", "0:09". Exported for testing. */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

function badge(state: GuestStatus["state"], p: ReturnType<typeof palette>, spin: string): string {
  switch (state) {
    case "connecting":
      return p.yellow(`${spin} connecting`);
    case "offered":
      return p.green("● offered");
    case "rejected":
      return p.red("✖ rejected");
    case "stopped":
      return p.gray("■ stopped");
  }
}

function streamColor(line: string, p: ReturnType<typeof palette>): (s: string) => string {
  if (line.startsWith("✖") || line.startsWith("✗")) return p.red;
  if (line.startsWith("✓")) return p.green;
  if (line.startsWith("→") || line.startsWith("⚙") || line.startsWith("⤓") || line.startsWith("▶")) return p.cyan;
  if (line.startsWith("←") || line.trimStart().startsWith("←")) return p.dim;
  return (s: string) => s;
}

/** Render one full dashboard frame as a newline-joined string. Pure — no I/O. */
export function renderFrame(v: GuestView, opts: RenderOpts): string {
  const p = palette(opts.color);
  const spin = SPINNER[opts.frame % SPINNER.length];
  const w = Math.max(20, opts.width);
  const rule = p.gray("─".repeat(w));
  const out: string[] = [];

  out.push(`${p.bold("🎭 mysteron guest")} ${p.dim("·")} ${p.cyan(v.label)}`);
  out.push(rule);

  const host = v.hostLabel ? `${v.hostLabel} ${p.dim(`(${v.hostUrl})`)}` : v.hostUrl;
  out.push(`${p.gray("host ")}  ${host}   ${badge(v.state, p, spin)}`);

  if (v.expiresAt) {
    const remaining = formatDuration(v.expiresAt - v.now);
    const up = formatDuration(v.now - v.startedAt);
    out.push(`${p.gray("offer")}  ${p.bold(remaining)} left ${p.dim(`· up ${up}`)}`);
  }

  const t = v.totals;
  const active = v.runs.length;
  const cost = t.costUsd > 0 ? ` ${p.dim("·")} ${p.green(`$${t.costUsd.toFixed(4)}`)}` : "";
  const turns = t.turns > 0 ? ` ${p.dim("·")} ${t.turns} turns` : "";
  out.push(
    `${p.gray("work ")}  ${p.bold(String(active))} active ${p.dim("·")} ` +
      `${p.green(`${t.done}✓`)} ${p.red(`${t.failed}✖`)} ${p.gray(`${t.stopped}■`)}${cost}${turns}`,
  );

  if (v.quota) {
    const q = v.quota;
    const pct = Math.round(q.percentUsed);
    const tint = !q.safeToContinue ? p.red : pct >= 70 ? p.yellow : p.green;
    const reset = q.resetAt ? ` ${p.dim(`· resets ${new Date(q.resetAt).toLocaleTimeString()}`)}` : "";
    const flag = q.safeToContinue ? "" : ` ${p.red("· maxed out")}`;
    out.push(`${p.gray("quota")}  ${tint(`${pct}% used`)} ${p.dim(`(${q.source})`)}${reset}${flag}`);
  }

  if (v.message) out.push(p.dim(clamp(v.message, w)));
  out.push("");

  if (v.runs.length === 0) {
    const idle =
      v.state === "offered"
        ? `${spin} ${p.dim("idle — waiting for work…")}`
        : v.state === "connecting"
          ? p.dim("connecting to host…")
          : p.dim("not offering.");
    out.push(`  ${idle}`);
  } else {
    // Share the remaining vertical space between active run cards.
    const headerRows = out.length;
    const budget = Math.max(2, opts.height - headerRows - 1);
    const perRun = Math.max(1, Math.floor(budget / v.runs.length) - 1);
    for (const r of v.runs) {
      const stats = [
        r.numTurns != null ? `${r.numTurns} turns` : null,
        r.costUsd != null ? `$${r.costUsd.toFixed(4)}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      const head = `${p.yellow(spin)} ${p.bold(r.ticketTitle)}${stats ? ` ${p.dim(`[${stats}]`)}` : ""}`;
      out.push(clamp(head, w));
      for (const ln of r.lines.slice(-perRun)) {
        out.push("  " + clamp(streamColor(ln, p)(ln), w - 2));
      }
    }
  }

  return out.map((l) => clamp(l, w)).join("\n");
}

/**
 * Drives a live, repainting dashboard for the guest terminal: subscribes to the
 * connection's lifecycle hooks, keeps a small per-run log tail, and redraws on a
 * timer. Use this only on an interactive TTY; pipe-friendly logging lives in the
 * `join` CLI fallback.
 *
 * Repainting (cursor management, erasing the previous frame, clipping to the
 * terminal height, and flicker-free diffed writes) is delegated to `log-update`,
 * which handles the awkward cases — frames taller than the window, resizes,
 * wrapped lines — that a hand-rolled cursor-up redraw got wrong.
 */
export class GuestTui {
  private readonly conn: GuestConnection;
  private readonly stream: NodeJS.WriteStream;
  private readonly color: boolean;
  private readonly maxTail: number;
  private readonly log: ReturnType<typeof createLogUpdate>;

  private status?: GuestStatus;
  private readonly runs = new Map<string, RunCard>();
  private readonly totals = { done: 0, failed: 0, stopped: 0, costUsd: 0, turns: 0 };
  private readonly startedAt = Date.now();

  private frame = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor(conn: GuestConnection, stream: NodeJS.WriteStream = process.stdout, maxTail = 50) {
    this.conn = conn;
    this.stream = stream;
    this.maxTail = maxTail;
    this.color = !process.env.NO_COLOR;
    this.log = createLogUpdate(stream);
  }

  start(): void {
    this.conn.onChange = (s) => {
      this.status = s;
    };
    this.conn.onRunStart = (r: GuestRunStart) => {
      this.runs.set(r.runId, { runId: r.runId, ticketTitle: r.ticketTitle, lines: [] });
    };
    this.conn.onRunLine = (l: GuestRunLine) => {
      const card = this.runs.get(l.runId);
      if (!card) return;
      for (const part of l.text.split("\n")) {
        if (part.trim()) card.lines.push(part);
      }
      if (card.lines.length > this.maxTail) card.lines.splice(0, card.lines.length - this.maxTail);
    };
    this.conn.onRunStats = (s: GuestRunStats) => {
      const card = this.runs.get(s.runId);
      if (!card) return;
      card.costUsd = s.costUsd;
      card.numTurns = s.numTurns;
    };
    this.conn.onRunDone = (d: GuestRunDone) => {
      this.runs.delete(d.runId);
      this.totals[d.status]++;
      if (d.costUsd) this.totals.costUsd += d.costUsd;
      if (d.numTurns) this.totals.turns += d.numTurns;
    };

    this.timer = setInterval(() => this.paint(), 90);
    this.timer.unref?.();
  }

  private view(): GuestView {
    const s = this.status;
    return {
      label: s?.label ?? this.conn.label,
      hostUrl: s?.hostUrl ?? this.conn.hostUrl,
      hostLabel: s?.hostLabel,
      state: s?.state ?? "connecting",
      message: s?.message,
      startedAt: this.startedAt,
      expiresAt: s?.expiresAt ? Date.parse(s.expiresAt) : undefined,
      now: Date.now(),
      runs: [...this.runs.values()],
      totals: this.totals,
      quota: s?.quota,
    };
  }

  private paint(): void {
    const text = renderFrame(this.view(), {
      width: (this.stream.columns ?? 100) - 1,
      height: this.stream.rows ?? 30,
      frame: this.frame++,
      color: this.color,
    });
    this.log(text);
  }

  /** Stop repainting, restore the cursor, and leave a final frame on screen. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.paint();
    this.log.done(); // persist the final frame and restore the cursor
  }
}
