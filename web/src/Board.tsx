import { useState } from "preact/hooks";
import {
  AP_STATUS,
  STATE_LABELS,
  api,
  type Companion,
  type ProjectDetail,
  type Ticket,
  type TicketState,
} from "./api";
import { Avatar } from "./Avatar";
import { LiveDot } from "./ui";

function runTicketUrl(projectId: string, ticketId: string): string {
  return `${location.origin}${location.pathname}#/project/${projectId}/ticket/${ticketId}/run`;
}

export function Board({
  detail,
  onEdit,
  reload,
}: {
  detail: ProjectDetail;
  onEdit: (ticket: Ticket) => void;
  reload: () => void;
}) {
  const projectId = detail.entry.id;
  const byId = new Map(detail.config.companions.map((c) => [c.id, c]));
  const busy = new Set(detail.busyCompanions ?? []);
  const running = new Set((detail.activeRuns ?? []).map((r) => r.ticketId));
  const [dragOver, setDragOver] = useState<TicketState | null>(null);

  const moveTicket = async (ticketId: string, state: TicketState) => {
    await api(`/api/projects/${projectId}/tickets/${ticketId}`, {
      method: "PATCH",
      body: JSON.stringify({ state }),
    });
    reload();
  };

  return (
    <div>
      <AutopilotBar detail={detail} />

      <div class="mb-3.5 text-sm text-zinc-500">Drag a card between columns to change its state.</div>

      <div class="grid grid-flow-col auto-cols-[minmax(250px,1fr)] gap-3.5 overflow-x-auto pb-2.5">
        {detail.states.map((state) => {
          const tickets = detail.board[state] || [];
          return (
            <div
              key={state}
              class={`min-h-[120px] rounded-sm border bg-zinc-900/40 p-3 transition ${
                dragOver === state ? "border-violet-500 bg-zinc-800/60" : "border-zinc-800"
              }`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(state);
              }}
              onDragLeave={() => setDragOver((s) => (s === state ? null : s))}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(null);
                const id = e.dataTransfer?.getData("text/plain");
                if (id) moveTicket(id, state);
              }}
            >
              <div class="mb-2.5 flex items-center justify-between text-xs uppercase tracking-wide text-zinc-500">
                <span>{STATE_LABELS[state]}</span>
                <span class="rounded-full bg-zinc-800 px-2 py-0.5">{tickets.length}</span>
              </div>
              {tickets.map((t) => (
                <TicketCard
                  key={t.id}
                  projectId={projectId}
                  t={t}
                  companion={t.companionId ? byId.get(t.companionId) : undefined}
                  busy={Boolean(t.companionId && busy.has(t.companionId))}
                  running={running.has(t.id)}
                  onEdit={() => onEdit(t)}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TicketCard({
  projectId,
  t,
  companion,
  busy,
  running,
  onEdit,
}: {
  projectId: string;
  t: Ticket;
  companion?: Companion;
  busy: boolean;
  running: boolean;
  onEdit: () => void;
}) {
  const inProgress = t.state === "in-progress";
  return (
    <div
      draggable
      onDragStart={(e) => e.dataTransfer?.setData("text/plain", t.id)}
      onClick={onEdit}
      class={`mb-2.5 cursor-grab rounded-sm border p-2.5 ${
        inProgress
          ? "pulse border-amber-300 bg-amber-400 text-zinc-900"
          : "border-zinc-800 bg-zinc-800/70 hover:border-violet-500"
      }`}
    >
      <div class="flex items-start justify-between gap-2">
        <div class="text-sm font-medium">{t.title}</div>
        <button
          class={`btn btn-sm shrink-0 px-2 py-0.5 opacity-60 hover:opacity-100 ${inProgress ? "text-zinc-900" : "text-emerald-400"}`}
          disabled={busy}
          title={
            running
              ? "Agent is running on this ticket"
              : busy
                ? `${companion?.name ?? "Companion"} is busy with another ticket`
                : "Run an agent on this ticket (opens a live view)"
          }
          onClick={(e) => {
            e.stopPropagation();
            if (!busy) window.open(runTicketUrl(projectId, t.id), "_blank");
          }}
        >
          {running ? <LiveDot /> : "▶"}
        </button>
      </div>
      <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
        <span class="tag">{t.priority}</span>
        {companion ? (
          <span class="tag inline-flex items-center gap-1">
            <Avatar companion={companion} size={14} /> {companion.name}
          </span>
        ) : t.assignee ? (
          <span class="tag">@{t.assignee}</span>
        ) : null}
        {(t.labels || []).map((l) => (
          <span key={l} class="tag">
            {l}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The autopilot status card — only shown while it's running; collapsed otherwise.
 *  Starting/stopping lives in the sticky toolbar (see Project). */
function AutopilotBar({ detail }: { detail: ProjectDetail }) {
  const projectId = detail.entry.id;
  const ap = detail.autopilot;
  if (!ap || ap.status === "stopped") return null;
  const s = AP_STATUS[ap.status] || AP_STATUS.stopped;

  return (
    <div class="card mb-3.5 border-emerald-500">
      <div class="flex items-center gap-2">
        <span>🤖</span>
        <b>Autopilot</b>
        <span class={`pill gap-1.5 ${s.color}`}>
          {s.live && <LiveDot />}
          {s.label}
        </span>
        <div class="flex-1" />
        <span class="text-sm text-zinc-500">{ap.completed || 0} done this session</span>
      </div>

      <div class="mt-2 text-sm">
        <span>{ap.message}</span>
        {ap.currentTicketId && (
          <a class="btn btn-sm ml-2" href={`#/project/${projectId}/ticket/${ap.currentTicketId}`}>
            view live →
          </a>
        )}
      </div>

      {ap.activity && ap.activity.length > 0 && (
        <div class="mt-2.5 flex flex-col gap-0.5 border-t border-zinc-800 pt-2.5 font-mono text-xs">
          {ap.activity.slice(0, 6).map((a, i) => (
            <div key={i}>
              <span class="text-zinc-500">{new Date(a.at).toLocaleTimeString()} </span>
              {a.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

