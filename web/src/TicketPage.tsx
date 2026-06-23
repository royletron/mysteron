import { useEffect, useState } from "preact/hooks";
import {
  RUN_STATUS,
  api,
  fmtWhen,
  type ProjectDetail,
  type RunLine,
  type RunStatus,
  type RunSummary,
  type Ticket,
} from "./api";
import { useAsync, useRunStream } from "./hooks";
import { ErrorBox, LiveDot, Loading, RunTimer } from "./ui";
import { Avatar } from "./Avatar";
import { AgentLog, AgentThinking } from "./AgentLog";
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

  // Autostart (arrived via the ▶ play button): strip the marker and launch the
  // agent here so there's no race between starting the run and opening the page.
  useEffect(() => {
    if (!autostart) return;
    window.history.replaceState(null, "", `#/project/${projectId}/ticket/${ticketId}`);
    api(`/api/projects/${projectId}/tickets/${ticketId}/run`, { method: "POST" })
      .then(() => setRefresh((n) => n + 1))
      .catch((e) => alert(`Could not start agent: ${(e as Error).message}`));
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

  if (loading && !data) return <Loading />;
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
  const active = runs.find((r) => r.status === "running");
  const selectedRun = runs.find((r) => r.id === selectedRunId);
  const status = liveStatus?.status ?? selectedRun?.status;
  const statusInfo = status ? RUN_STATUS[status] : null;
  const timerRun = active ?? selectedRun;

  const startRun = async () => {
    try {
      await api(`/api/projects/${projectId}/tickets/${ticketId}/run`, { method: "POST" });
      setSelectedRunId(null);
      setRefresh((n) => n + 1);
    } catch (e) {
      alert((e as Error).message);
    }
  };
  const stopRun = async () => {
    const r = active || runs[0];
    if (r) {
      await api(`/api/runs/${r.id}/stop`, { method: "POST" });
      setRefresh((n) => n + 1);
    }
  };

  return (
    <div>
      <div class="mb-4 flex items-center gap-3">
        <a href={`#/project/${projectId}`} class="btn btn-ghost btn-sm">
          ← board
        </a>
        {lead ? <Avatar companion={lead} size={34} /> : null}
        <div>
          <h1 class="text-xl font-semibold">{ticket.title}</h1>
          <div class="text-sm text-zinc-400">
            {detail.entry.name}
            {lead ? ` · ${lead.name}` : ""}
          </div>
        </div>
      </div>

      <div class="grid grid-cols-[minmax(280px,360px)_1fr] items-start gap-4">
        <div class="card sticky top-20 self-start">
          <div class="mb-3 flex items-center gap-2">
            <span class={`pill gap-1.5 ${statusInfo?.color ?? "text-zinc-500"}`}>
              {statusInfo?.live && <LiveDot />}
              {statusInfo?.label ?? "idle"}
            </span>
            {timerRun && <RunTimer run={timerRun} class="text-sm text-zinc-400" />}
            <div class="flex-1" />
            {active ? (
              <button class="btn btn-danger" title="Stop agent" onClick={stopRun}>
                ■
              </button>
            ) : (
              <button class="btn btn-primary" title="Run agent" onClick={startRun}>
                ▶
              </button>
            )}
          </div>
          <div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <b class="text-zinc-400">State</b>
            <span>{ticket.state}</span>
            <b class="text-zinc-400">Priority</b>
            <span>{ticket.priority}</span>
            <b class="text-zinc-400">Assignee</b>
            <span>{ticket.assignee || "—"}</span>
            <b class="text-zinc-400">Ticket id</b>
            <span class="font-mono">{ticket.id}</span>
          </div>
          <label class="field-label">Description</label>
          <pre class="max-h-[220px] overflow-auto whitespace-pre-wrap rounded-sm border border-zinc-800 bg-zinc-950 p-2.5 font-mono text-xs">
            {ticket.body || "(no description)"}
          </pre>
          <label class="field-label">Run history</label>
          {runs.length === 0 ? (
            <div class="text-sm text-zinc-500">No runs yet.</div>
          ) : (
            <div class="flex flex-col gap-1">
              {runs.map((r) => (
                <button
                  key={r.id}
                  title={r.command}
                  onClick={() => setSelectedRunId(r.id)}
                  class={`flex items-center justify-between gap-2 rounded-sm border px-2 py-1 text-left text-xs ${
                    r.id === selectedRunId
                      ? "border-violet-500 text-zinc-100"
                      : "border-zinc-800 text-zinc-400 hover:border-zinc-600"
                  }`}
                >
                  <span class={`inline-flex items-center gap-1.5 ${RUN_STATUS[r.status]?.color}`}>
                    {RUN_STATUS[r.status]?.live && <LiveDot />}
                    {RUN_STATUS[r.status]?.label || r.status}
                  </span>
                  <span class="text-zinc-500">
                    {fmtWhen(r.startedAt)}
                    <RunTimer run={r} prefix=" · " />
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div class="card">
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
                  <div class="font-mono text-xs text-zinc-600">Waiting for the agent…</div>
                )}
                {lines.length > 0 && <AgentLog lines={lines} />}
                {status === "running" && (
                  <div class={lines.length > 0 ? "mt-3" : ""}>
                    <AgentThinking companion={lead} />
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


