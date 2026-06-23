import { useState } from "preact/hooks";
import {
  AP_STATUS,
  PRIORITY_BORDER,
  STATE_LABELS,
  api,
  type Companion,
  type ProjectDetail,
  type Ticket,
  type TicketState,
} from "./api";
import { TicketPanel } from "./TicketPanel";
import { Avatar } from "./Avatar";
import { LiveDot } from "./ui";
import type { AppEvent } from "./App";

function runTicketUrl(projectId: string, ticketId: string): string {
  return `${location.origin}${location.pathname}#/project/${projectId}/ticket/${ticketId}/run`;
}

export function Board({ detail, evt, reload }: { detail: ProjectDetail; evt: AppEvent; reload: () => void }) {
  const projectId = detail.entry.id;
  const byId = new Map(detail.config.companions.map((c) => [c.id, c]));
  const busy = new Set(detail.busyCompanions ?? []);
  const [dragOver, setDragOver] = useState<TicketState | null>(null);
  const [editing, setEditing] = useState<Ticket | "new" | null>(null);

  const moveTicket = async (ticketId: string, state: TicketState) => {
    await api(`/api/projects/${projectId}/tickets/${ticketId}`, {
      method: "PATCH",
      body: JSON.stringify({ state }),
    });
    reload();
  };

  return (
    <div>
      <AutopilotBar detail={detail} reload={reload} />

      <div class="mb-3.5 flex items-center gap-3">
        <button class="btn btn-primary" onClick={() => setEditing("new")}>
          + Add ticket
        </button>
        <span class="text-sm text-zinc-500">Drag a card between columns to change its state.</span>
      </div>

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
                  onEdit={() => setEditing(t)}
                />
              ))}
            </div>
          );
        })}
      </div>

      {editing && (
        <TicketPanel
          projectId={projectId}
          ticket={editing === "new" ? null : editing}
          companions={detail.config.companions}
          evt={evt}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function TicketCard({
  projectId,
  t,
  companion,
  busy,
  onEdit,
}: {
  projectId: string;
  t: Ticket;
  companion?: Companion;
  busy: boolean;
  onEdit: () => void;
}) {
  return (
    <div
      draggable
      onDragStart={(e) => e.dataTransfer?.setData("text/plain", t.id)}
      onClick={onEdit}
      class={`mb-2.5 cursor-grab rounded-sm border border-l-[3px] border-zinc-800 bg-zinc-800/70 p-2.5 hover:border-violet-500 ${PRIORITY_BORDER[t.priority]}`}
    >
      <div class="flex items-start justify-between gap-2">
        <div class="text-sm font-medium">{t.title}</div>
        <button
          class="btn btn-sm shrink-0 px-2 py-0.5 text-emerald-400 opacity-60 hover:opacity-100"
          disabled={busy}
          title={busy ? `${companion?.name ?? "Companion"} is busy with another ticket` : "Run an agent on this ticket (opens a live view)"}
          onClick={(e) => {
            e.stopPropagation();
            if (!busy) window.open(runTicketUrl(projectId, t.id), "_blank");
          }}
        >
          {busy ? <LiveDot /> : "▶"}
        </button>
      </div>
      <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
        <span class="tag">{t.priority}</span>
        {companion ? (
          <span class="tag inline-flex items-center gap-1">
            <span class={busy ? "pulse-ring" : ""}>
              <Avatar companion={companion} size={14} />
            </span>{" "}
            {companion.name}
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

function AutopilotBar({ detail, reload }: { detail: ProjectDetail; reload: () => void }) {
  const projectId = detail.entry.id;
  const ap = detail.autopilot || { status: "stopped" };
  const active = ap.status && ap.status !== "stopped";
  const readyCount = (detail.board.ready || []).length;
  const s = AP_STATUS[ap.status] || AP_STATUS.stopped;

  const start = async () => {
    await api(`/api/projects/${projectId}/autopilot/start`, { method: "POST" });
    reload();
  };
  const stop = async () => {
    await api(`/api/projects/${projectId}/autopilot/stop`, { method: "POST" });
    reload();
  };

  return (
    <div class={`card mb-3.5 ${active ? "border-emerald-500" : ""}`}>
      <div class="flex items-center gap-2">
        <span>🤖</span>
        <b>Autopilot</b>
        {active && (
          <span class={`pill gap-1.5 ${s.color}`}>
            {s.live && <LiveDot />}
            {s.label}
          </span>
        )}
        <div class="flex-1" />
        {active && <span class="text-sm text-zinc-500">{ap.completed || 0} done this session</span>}
        {active ? (
          <button class="btn btn-danger btn-sm" onClick={stop}>
            ■ Stop autopilot
          </button>
        ) : (
          <button class="btn btn-primary btn-sm" onClick={start}>
            ▶ Start autopilot
          </button>
        )}
      </div>

      {active ? (
        <div class="mt-2 text-sm">
          <span>{ap.message}</span>
          {ap.currentTicketId && (
            <a class="btn btn-sm ml-2" href={`#/project/${projectId}/ticket/${ap.currentTicketId}`}>
              view live →
            </a>
          )}
        </div>
      ) : (
        <div class="mt-2 text-sm text-zinc-500">
          Pulls ready tickets one at a time and runs the companion on each, pausing for Claude usage limits
          {detail.config.yolo ? "" : " (tip: enable yolo for hands-off runs)"}. {readyCount} ready.
        </div>
      )}

      {active && ap.activity && ap.activity.length > 0 && (
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

