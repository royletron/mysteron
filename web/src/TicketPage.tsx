import { useEffect, useState } from "preact/hooks";
import {
  RUN_STATUS,
  api,
  fmtCost,
  fmtWhen,
  type ProjectDetail,
  type RunLine,
  type RunStatus,
  type RunSummary,
  type Ticket,
} from "./api";
import { useAsync, useRunStream } from "./hooks";
import { ErrorBox, LiveDot, Loading, RunTimer, CloudGlyph, RunMachine } from "./ui";
import { Avatar } from "./Avatar";
import { AgentLog, AgentThinking } from "./AgentLog";
import { ChevronDown, ChevronUp } from "lucide-preact";
import type { AppEvent } from "./App";

interface TicketData {
  detail: ProjectDetail;
  ticket?: Ticket;
  runs: RunSummary[];
}

export function TicketPage({
  projectId,
  ticketId,
  autostart,
  evt,
  onTitle,
}: {
  projectId: string;
  ticketId: string;
  autostart: boolean;
  evt: AppEvent;
  onTitle?: (title: string) => void;
}) {
  const [refresh, setRefresh] = useState(0);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [lines, setLines] = useState<RunLine[]>([]);
  const [liveStatus, setLiveStatus] = useState<{ status: RunStatus; exitCode?: number | null } | null>(null);
  // Why the last run attempt couldn't start (e.g. no agent installed, usage
  // maxed out). Shown as a persistent banner so a failed click isn't silent.
  const [startError, setStartError] = useState<string | null>(null);
  // Mobile: whether the expanded "details" drawer is open.
  const [infoOpen, setInfoOpen] = useState(false);

  // Autostart (arrived via the ▶ play button): strip the marker and launch the
  // agent here so there's no race between starting the run and opening the page.
  useEffect(() => {
    if (!autostart) return;
    window.history.replaceState(null, "", `#/project/${projectId}/ticket/${ticketId}`);
    api(`/api/projects/${projectId}/tickets/${ticketId}/run`, { method: "POST" })
      .then(() => {
        setStartError(null);
        setRefresh((n) => n + 1);
      })
      .catch((e) => setStartError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const matchSeq = evt.projectId === projectId ? evt.seq : -1;
  const { data, loading, error } = useAsync<TicketData>(async () => {
    const [detail, runsData] = await Promise.all([
      api<ProjectDetail>(`/api/projects/${projectId}`),
      api<{ runs: RunSummary[] }>(`/api/projects/${projectId}/runs`),
    ]);
    let ticket: Ticket | undefined;
    for (const s of detail.states) {
      const f = (detail.board[s] || []).find((t) => t.id === ticketId);
      if (f) ticket = f;
    }
    return { detail, ticket, runs: runsData.runs.filter((r) => r.ticketId === ticketId) };
  }, [projectId, ticketId, refresh, matchSeq]);

  // Auto-select the active run (or the most recent one) once runs are known.
  useEffect(() => {
    if (!data) return;
    if (selectedRunId && data.runs.some((r) => r.id === selectedRunId)) return;
    const active = data.runs.find((r) => r.status === "running");
    const pick = active?.id ?? data.runs[0]?.id ?? null;
    if (pick) setSelectedRunId(pick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Reset the log when switching which run we view.
  useEffect(() => {
    setLines([]);
    setLiveStatus(null);
  }, [selectedRunId]);

  // Stream the selected run (auto-closes when the run finishes or the tab is
  // backgrounded; replays the buffer on reconnect, hence onReset).
  useRunStream(selectedRunId, {
    onReset: () => setLines([]),
    onLine: (line) => setLines((ls) => [...ls, line]),
    onStatus: (status, exitCode) => {
      setLiveStatus({ status, exitCode });
      setRefresh((n) => n + 1);
    },
  });

  // Report the ticket title up to the navbar breadcrumb once it's known.
  useEffect(() => {
    if (data?.ticket?.title) onTitle?.(data.ticket.title);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.ticket?.title]);

  // Autoscroll the page to follow new output when already near the bottom.
  useEffect(() => {
    const doc = document.documentElement;
    if (doc.scrollHeight - window.scrollY - window.innerHeight < 120) {
      window.scrollTo({ top: doc.scrollHeight });
    }
  }, [lines]);

  if (loading && !data) return <Loading what="Establishing contact…" />;
  if (error || !data)
    return (
      <div>
        <ErrorBox message={`Could not load: ${error}`} />
        <div class="text-center">
          <a href={`#/project/${projectId}`} class="btn btn-ghost">
            ← back to board
          </a>
        </div>
      </div>
    );

  const { detail, ticket, runs } = data;
  if (!ticket)
    return (
      <div class="p-10 text-center text-zinc-500">
        Ticket not found.
        <div>
          <a href={`#/project/${projectId}`} class="btn btn-ghost mt-2">
            ← back to board
          </a>
        </div>
      </div>
    );

  const c = detail.config;
  const lead = c.companions.find((x) => x.role === "soloist") ?? c.companions[0];
  const assigned = ticket.companionId ? c.companions.find((x) => x.id === ticket.companionId) : undefined;
  const active = runs.find((r) => r.status === "running");
  const selectedRun = runs.find((r) => r.id === selectedRunId);
  const status = liveStatus?.status ?? selectedRun?.status;
  const statusInfo = status ? RUN_STATUS[status] : null;
  const timerRun = active ?? selectedRun;

  const startRun = async () => {
    try {
      await api(`/api/projects/${projectId}/tickets/${ticketId}/run`, { method: "POST" });
      setStartError(null);
      setSelectedRunId(null);
      setRefresh((n) => n + 1);
    } catch (e) {
      setStartError((e as Error).message);
    }
  };
  const stopRun = async () => {
    const r = active || runs[0];
    if (r) {
      await api(`/api/runs/${r.id}/stop`, { method: "POST" });
      setRefresh((n) => n + 1);
    }
  };

  // Reusable bits (rendered in the desktop card, the mobile sticky bar, and the
  // mobile drawer) — functions so each call returns fresh vnodes.
  const statusPill = () => (
    <span class={`pill gap-1.5 ${statusInfo?.color ?? "text-zinc-500"}`}>
      {statusInfo?.live && <LiveDot />}
      {statusInfo?.label ?? "idle"}
    </span>
  );
  // Shown when the active/selected run is executing on a guest machine.
  const guestBadge = () =>
    timerRun?.guestLabel ? (
      <span
        class="pill gap-1.5 border-sky-500 text-sky-400"
        title={`Running on “${timerRun.guestLabel}” — a guest machine, on its own Claude account`}
      >
        <CloudGlyph /> {timerRun.guestLabel}
      </span>
    ) : null;
  // Shown when a guest run's work landed on a dedicated branch (not the current one).
  const branchBadge = () =>
    selectedRun?.branch ? (
      <span
        class="pill gap-1.5 border-violet-500 text-violet-300"
        title={`Work committed to branch ${selectedRun.branch} — run \`git merge ${selectedRun.branch}\` to bring it into your branch`}
      >
        ⎇ {selectedRun.branch}
      </span>
    ) : null;
  const runMeta = () => (
    <>
      {timerRun && <RunTimer run={timerRun} class="text-sm text-zinc-400" />}
      {timerRun?.costUsd != null && (
        <span class="text-sm text-zinc-400" title={timerRun.numTurns != null ? `${timerRun.numTurns} turns` : undefined}>
          {fmtCost(timerRun.costUsd)}
        </span>
      )}
    </>
  );
  const playStop = (small = false) =>
    active ? (
      <button class={`btn btn-danger ${small ? "btn-sm" : ""}`} title="Stop agent" onClick={stopRun}>
        ■
      </button>
    ) : (
      <button class={`btn btn-primary ${small ? "btn-sm" : ""}`} title="Run agent" onClick={startRun}>
        ▶
      </button>
    );
  // Guest runs get their own lane in the history so the list stays readable.
  const localRuns = runs.filter((r) => !r.guestLabel);
  const guestRuns = runs.filter((r) => r.guestLabel);
  const runButton = (r: RunSummary) => (
    <button
      key={r.id}
      title={r.command}
      onClick={() => {
        setSelectedRunId(r.id);
        setInfoOpen(false);
      }}
      class={`flex flex-col gap-1 rounded-sm border px-2 py-1 text-left text-xs ${
        r.id === selectedRunId
          ? "border-violet-500 text-zinc-100"
          : "border-zinc-800 text-zinc-400 hover:border-zinc-600"
      }`}
    >
      <span class="flex items-center justify-between gap-2">
        <span class={`inline-flex items-center gap-1.5 ${RUN_STATUS[r.status]?.color}`}>
          {RUN_STATUS[r.status]?.live && <LiveDot />}
          {RUN_STATUS[r.status]?.label || r.status}
        </span>
        <span class="inline-flex items-center gap-1.5 text-zinc-500">
          {fmtWhen(r.startedAt)}
          <RunTimer run={r} prefix=" · " />
          {r.costUsd != null && ` · ${fmtCost(r.costUsd)}`}
        </span>
      </span>
      <span class="flex justify-end">
        <RunMachine run={r} />
      </span>
    </button>
  );

  const infoDetails = () => (
    <>
      <div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <b class="text-zinc-400">State</b>
        <span>{ticket.state}</span>
        <b class="text-zinc-400">Priority</b>
        <span>{ticket.priority}</span>
        <b class="text-zinc-400">Companion</b>
        <span class="inline-flex items-center gap-1.5">
          {assigned ? (
            <>
              <Avatar companion={assigned} size={18} /> {assigned.name}
            </>
          ) : (
            ticket.assignee || "—"
          )}
        </span>
        <b class="text-zinc-400">Ticket id</b>
        <span class="font-mono">{ticket.id}</span>
      </div>
      {(ticket.dependencies?.length || ticket.blocks?.length) ? (
        <div class="mt-3 flex flex-col gap-2 text-xs">
          {ticket.dependencies && ticket.dependencies.length > 0 && (
            <div>
              <span class="text-zinc-500">Blocked by</span>
              <div class="mt-1 flex flex-col gap-1">
                {ticket.dependencies.map((d) => (
                  <div key={d.id} class="flex items-center gap-2">
                    <span class={d.satisfied ? "text-emerald-400" : "text-amber-400"}>{d.satisfied ? "✓" : "⏳"}</span>
                    <span class="flex-1 truncate">{d.title}</span>
                    {!d.missing && <span class="text-zinc-500">{d.state}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
          {ticket.blocks && ticket.blocks.length > 0 && (
            <div>
              <span class="text-zinc-500">Blocks</span>
              <div class="mt-1 flex flex-col gap-1">
                {ticket.blocks.map((b) => (
                  <div key={b.id} class="flex items-center gap-2">
                    <span class="flex-1 truncate">{b.title}</span>
                    <span class="text-zinc-500">{b.state}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : null}
      <label class="field-label">Description</label>
      <pre class="max-h-[220px] overflow-auto whitespace-pre-wrap rounded-sm border border-zinc-800 bg-zinc-950 p-2.5 font-mono text-xs">
        {ticket.body || "(no description)"}
      </pre>
      <label class="field-label">Run history</label>
      {runs.length === 0 ? (
        <div class="text-sm text-zinc-500">No runs yet.</div>
      ) : (
        <div class="flex flex-col gap-2.5">
          {localRuns.length > 0 && <div class="flex flex-col gap-1">{localRuns.map(runButton)}</div>}
          {guestRuns.length > 0 && (
            <div class="flex flex-col gap-1">
              <span class="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-sky-400">
                <CloudGlyph /> Guest runs
              </span>
              {guestRuns.map(runButton)}
            </div>
          )}
        </div>
      )}
    </>
  );

  return (
    <div>
      <div class="mb-4 flex items-center gap-3">
        {lead ? <Avatar companion={lead} size={34} /> : null}
        <div class="min-w-0">
          <h1 class="text-xl font-semibold">{ticket.title}</h1>
          <div class="text-sm text-zinc-400">
            {detail.entry.name}
            {lead ? ` · ${lead.name}` : ""}
          </div>
        </div>
      </div>

      {/* Mobile: compact sticky status bar (the full Info card is hidden). */}
      <div class="sticky top-[52px] z-10 -mx-4 mb-4 flex items-center gap-2 border-b border-zinc-800 bg-zinc-950/80 px-4 py-2 backdrop-blur md:hidden">
        {statusPill()}
        {guestBadge()}
        {branchBadge()}
        {runMeta()}
        <div class="flex-1" />
        {playStop(true)}
        <button class="btn btn-sm" aria-label="Show details" title="Show details" onClick={() => setInfoOpen(true)}>
          <ChevronDown size={16} />
        </button>
      </div>

      <div class="grid grid-cols-1 items-start gap-4 md:grid-cols-[minmax(280px,360px)_1fr]">
        <div class="hidden flex-col self-stretch md:flex">
          <div class="card sticky top-20">
            <div class="mb-3 flex flex-wrap items-center gap-2">
              {statusPill()}
              {guestBadge()}
              {branchBadge()}
              {runMeta()}
              <div class="flex-1" />
              {playStop()}
            </div>
            {infoDetails()}
          </div>
          <div class="flex-1" />
          <a href={`#/project/${projectId}`} class="btn btn-ghost btn-sm sticky bottom-4 mt-3 self-start">
            ← board
          </a>
        </div>

        <div class="card">
          {startError && (
            <div class="mb-3 flex items-start gap-2 rounded-sm border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              <span aria-hidden>⚠</span>
              <div class="flex-1">
                <div class="font-medium">Couldn't start a run</div>
                <div class="text-red-300/90">{startError}</div>
              </div>
              <button class="btn btn-sm" onClick={() => setStartError(null)} aria-label="Dismiss">
                ✕
              </button>
            </div>
          )}
          <div class="mb-1.5 text-xs text-zinc-500">Live agent output</div>
          <div class="min-h-[52vh] rounded-sm border border-zinc-800 bg-black/70 p-3">
            {selectedRun && selectedRun.logAvailable === false ? (
              <div class="font-mono text-xs text-zinc-400">
                🖥 This run was performed by {selectedRun.companion} on{" "}
                <span class="text-zinc-200">{selectedRun.hostname}</span>. Its logs are local to that machine —
                only the run record syncs via git.
              </div>
            ) : (
              <>
                {lines.length === 0 && status !== "running" && (
                  <div class="font-mono text-xs text-zinc-600">Awaiting the voice of the Mysterons…</div>
                )}
                {lines.length > 0 && <AgentLog lines={lines} />}
                {status === "running" && (
                  <div class={lines.length > 0 ? "mt-3" : ""}>
                    {timerRun?.guestLabel && (
                      <div class="mb-2 inline-flex items-center gap-1.5 font-mono text-xs text-sky-400">
                        <CloudGlyph /> Running on guest machine “{timerRun.guestLabel}” — on its own Claude account, streamed here live.
                      </div>
                    )}
                    <AgentThinking companion={lead} />
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Mobile: expanded details drawer (full screen). */}
      {infoOpen && (
        <div class="fixed inset-0 z-50 flex flex-col bg-zinc-950 md:hidden">
          <div class="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
            <b>Details</b>
            {statusPill()}
            <div class="flex-1" />
            <button class="btn btn-sm" aria-label="Close details" title="Close" onClick={() => setInfoOpen(false)}>
              <ChevronUp size={16} />
            </button>
          </div>
          <div class="flex-1 overflow-auto p-4">
            {infoDetails()}
            <a
              href={`#/project/${projectId}`}
              class="btn btn-ghost btn-sm mt-3"
              onClick={() => setInfoOpen(false)}
            >
              ← board
            </a>
          </div>
        </div>
      )}
    </div>
  );
}


