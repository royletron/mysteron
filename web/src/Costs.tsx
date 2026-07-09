import { useState } from "preact/hooks";
import { fmtUsd, fmtNum, getCosts, type CostStats, type DailyCost } from "./api";
import { useAsync } from "./hooks";
import { ErrorBox, Loading } from "./ui";

/**
 * Cross-project spend explorer. Reads the global cost ledger (every finished
 * agent run pushes its USD cost) and shows overall totals, spend over time, a
 * per-project breakdown, and the priciest tickets.
 */
export function Costs() {
  const { data, error, loading } = useAsync(() => getCosts(), []);

  return (
    <div>
      <div class="mb-6 flex items-center gap-4">
        <h1 class="text-xl font-semibold">Cost explorer</h1>
        <span class="text-sm text-zinc-500">what your agents are spending, across every project</span>
      </div>

      {loading && !data && <Loading />}
      {error && <ErrorBox message={`Failed to load costs: ${error}`} />}
      {data && data.runs === 0 && (
        <div class="p-10 text-center text-zinc-500">
          <p>No costs recorded yet.</p>
          <p>Spend shows up here once an agent finishes a ticket and reports its cost.</p>
        </div>
      )}
      {data && data.runs > 0 && <Explorer stats={data} />}
    </div>
  );
}

function Explorer({ stats }: { stats: CostStats }) {
  return (
    <div class="flex flex-col gap-6">
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Total spend" value={fmtUsd(stats.totalUsd)} accent />
        <Stat label="Runs" value={fmtNum(stats.runs)} />
        <Stat label="Tickets" value={fmtNum(stats.tickets)} />
        <Stat label="Avg / ticket" value={fmtUsd(stats.avgTicketUsd)} />
        <Stat label="Avg / run" value={fmtUsd(stats.avgRunUsd)} />
      </div>

      <section class="card">
        <h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-400">Spend over time</h2>
        <DailyChart daily={stats.daily} />
      </section>

      <AvgTicketTrend stats={stats} />

      <section class="card">
        <h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-400">By project</h2>
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-zinc-800 text-left text-xs uppercase tracking-wide text-zinc-500">
              <th class="py-2 pr-2">Project</th>
              <th class="py-2 px-2 text-right">Total</th>
              <th class="py-2 px-2 text-right">Runs</th>
              <th class="py-2 px-2 text-right">Tickets</th>
              <th class="py-2 pl-2 text-right">Avg / ticket</th>
            </tr>
          </thead>
          <tbody>
            {stats.byProject.map((p) => (
              <tr key={p.projectId} class="border-b border-zinc-800/60 last:border-0">
                <td class="py-2 pr-2">
                  <a href={`#/project/${p.projectId}`} class="text-zinc-200 hover:text-violet-300">
                    {p.name}
                  </a>
                </td>
                <td class="py-2 px-2 text-right font-medium text-emerald-400">{fmtUsd(p.totalUsd)}</td>
                <td class="py-2 px-2 text-right text-zinc-400">{fmtNum(p.runs)}</td>
                <td class="py-2 px-2 text-right text-zinc-400">{fmtNum(p.tickets)}</td>
                <td class="py-2 pl-2 text-right text-zinc-300">{fmtUsd(p.avgTicketUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {stats.topTickets.length > 0 && (
        <section class="card">
          <h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-400">Priciest tickets</h2>
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-zinc-800 text-left text-xs uppercase tracking-wide text-zinc-500">
                <th class="py-2 pr-2">Ticket</th>
                <th class="py-2 px-2">Project</th>
                <th class="py-2 px-2 text-right">Runs</th>
                <th class="py-2 pl-2 text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {stats.topTickets.map((t) => (
                <tr key={`${t.projectId}/${t.ticketId}`} class="border-b border-zinc-800/60 last:border-0">
                  <td class="py-2 pr-2">
                    <a
                      href={`#/project/${t.projectId}/ticket/${t.ticketId}`}
                      class="text-zinc-200 hover:text-violet-300"
                    >
                      {t.ticketTitle || t.ticketId}
                    </a>
                  </td>
                  <td class="py-2 px-2 text-zinc-400">{t.projectName}</td>
                  <td class="py-2 px-2 text-right text-zinc-400">{fmtNum(t.runs)}</td>
                  <td class="py-2 pl-2 text-right font-medium text-emerald-400">{fmtUsd(t.totalUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div class="card">
      <div class="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div class={`mt-1 text-2xl font-semibold ${accent ? "text-emerald-400" : "text-zinc-100"}`}>{value}</div>
    </div>
  );
}

/**
 * Average cost per ticket over time, with a linear trend line so you can see at a
 * glance whether a project is getting pricier per ticket. A dropdown scopes it to a
 * single project (default: all projects combined).
 */
function AvgTicketTrend({ stats }: { stats: CostStats }) {
  const [projectId, setProjectId] = useState("all");
  const daily =
    projectId === "all" ? stats.daily : stats.byProject.find((p) => p.projectId === projectId)?.daily ?? [];
  const points = daily
    .filter((d) => d.tickets > 0)
    .map((d) => ({ date: d.date, value: d.totalUsd / d.tickets }));

  return (
    <section class="card">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-sm font-semibold uppercase tracking-wide text-zinc-400">Avg cost per ticket over time</h2>
        <select
          class="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
          value={projectId}
          onChange={(e) => setProjectId((e.target as HTMLSelectElement).value)}
        >
          <option value="all">All projects</option>
          {stats.byProject.map((p) => (
            <option key={p.projectId} value={p.projectId}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <TrendChart points={points} />
    </section>
  );
}

/** Least-squares fit; returns the line's endpoints (y at x=0 and x=n-1). */
function trendEnds(values: number[]): { y0: number; y1: number } | null {
  const n = values.length;
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (let x = 0; x < n; x++) {
    sx += x;
    sy += values[x];
    sxy += x * values[x];
    sxx += x * x;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return { y0: intercept, y1: intercept + slope * (n - 1) };
}

/** A line chart of avg cost/ticket with a dashed least-squares trend line over the top. */
function TrendChart({ points }: { points: { date: string; value: number }[] }) {
  if (points.length < 2) {
    return <p class="text-sm text-zinc-500">Not enough days with ticket spend to plot a trend yet.</p>;
  }
  const w = 600;
  const h = 160;
  const pad = 4;
  const values = points.map((p) => p.value);
  const trend = trendEnds(values);
  const max = Math.max(...values, trend ? trend.y1 : 0, trend ? trend.y0 : 0);
  const n = points.length;
  const x = (i: number) => (n === 1 ? w / 2 : pad + (i / (n - 1)) * (w - 2 * pad));
  const y = (v: number) => h - pad - (max <= 0 ? 0 : (v / max) * (h - 2 * pad));
  const line = points.map((p, i) => `${x(i)},${y(p.value)}`).join(" ");
  const rising = trend ? trend.y1 > trend.y0 : false;

  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} class="h-40 w-full" preserveAspectRatio="none">
        <polyline points={line} fill="none" stroke="rgb(167 139 250 / 0.8)" stroke-width="2" />
        {points.map((p, i) => (
          <circle key={p.date} cx={x(i)} cy={y(p.value)} r="2.5" fill="rgb(167 139 250)">
            <title>{`${p.date} · ${fmtUsd(p.value)} / ticket`}</title>
          </circle>
        ))}
        {trend && (
          <line
            x1={x(0)}
            y1={y(trend.y0)}
            x2={x(n - 1)}
            y2={y(trend.y1)}
            stroke={rising ? "rgb(248 113 113 / 0.9)" : "rgb(52 211 153 / 0.9)"}
            stroke-width="2"
            stroke-dasharray="6 4"
          />
        )}
      </svg>
      <div class="mt-2 flex items-center justify-between text-[11px] text-zinc-500">
        <span>{points[0].date}</span>
        {trend && (
          <span class={rising ? "text-red-400" : "text-emerald-400"}>
            trend {rising ? "↑ rising" : "↓ falling"} · {fmtUsd(trend.y0)} → {fmtUsd(trend.y1)} / ticket
          </span>
        )}
        <span>{points[n - 1].date}</span>
      </div>
    </div>
  );
}

/** A dependency-free bar chart of daily spend; bar height is relative to the busiest day. */
function DailyChart({ daily }: { daily: DailyCost[] }) {
  const max = daily.reduce((m, d) => Math.max(m, d.totalUsd), 0);
  if (max <= 0) return <p class="text-sm text-zinc-500">No spend recorded.</p>;
  return (
    <div class="flex h-40 items-end gap-1 overflow-x-auto">
      {daily.map((d) => (
        <div
          key={d.date}
          class="group flex h-full min-w-[8px] flex-1 flex-col items-center justify-end gap-1"
          title={`${d.date} · ${fmtUsd(d.totalUsd)} · ${d.runs} run${d.runs === 1 ? "" : "s"}`}
        >
          <div
            class="w-full rounded-t-sm bg-violet-500/70 transition group-hover:bg-violet-400"
            style={{ height: `${Math.max(2, (d.totalUsd / max) * 100)}%` }}
          />
          <span class="w-full truncate text-center text-[9px] text-zinc-600">{d.date.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}
