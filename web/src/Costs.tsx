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

/** A dependency-free bar chart of daily spend; bar height is relative to the busiest day. */
function DailyChart({ daily }: { daily: DailyCost[] }) {
  const max = daily.reduce((m, d) => Math.max(m, d.totalUsd), 0);
  if (max <= 0) return <p class="text-sm text-zinc-500">No spend recorded.</p>;
  return (
    <div class="flex h-40 items-end gap-1 overflow-x-auto">
      {daily.map((d) => (
        <div
          key={d.date}
          class="group flex min-w-[8px] flex-1 flex-col items-center justify-end gap-1"
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
