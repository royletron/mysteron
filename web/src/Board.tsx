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
import { navigate } from "./hooks";
import { Avatar } from "./Avatar";
import { LiveDot, CloudGlyph } from "./ui";
import { Loader2, MoreHorizontal, Lock } from "lucide-preact";

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
  // Tickets whose active run is executing on a guest machine → its label.
  const guestByTicket = new Map(
    (detail.activeRuns ?? []).filter((r) => r.guestLabel).map((r) => [r.ticketId, r.guestLabel as string]),
  );
  const [dragOver, setDragOver] = useState<TicketState | null>(null);

  const moveTicket = async (ticketId: string, state: TicketState) => {
    await api(`/api/projects/${projectId}/tickets/${ticketId}`, {
      method: "PATCH",
      body: JSON.stringify({ state }),
    });
    reload();
  };

  // Move every ticket in a column to another state (or the bin), with a confirm.
  const bulkMove = async (from: TicketState, to: TicketState) => {
    const count = (detail.board[from] || []).length;
    if (!count) return;
    const dest = to === "bin" ? "the bin" : STATE_LABELS[to];
    if (!confirm(`Move all ${count} ticket${count === 1 ? "" : "s"} from ${STATE_LABELS[from]} to ${dest}?`)) return;
    await api(`/api/projects/${projectId}/tickets/bulk-move`, {
      method: "POST",
      body: JSON.stringify({ from, to }),
    });
    reload();
  };

  // Columns plus the bin — every place a column's tickets can be sent in bulk.
  const targets: TicketState[] = [...detail.states, "bin"];

  return (
    <div>
      <AutopilotBar detail={detail} />

      <div class="mb-3.5 hidden text-sm text-zinc-500 md:block">
        Drag a card between columns to change its state.
      </div>

      <div class="-mx-4 grid grid-flow-col auto-cols-[minmax(250px,1fr)] gap-3.5 overflow-x-auto px-4 pb-2.5 md:-mx-6 md:px-6">
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
                <div class="flex items-center gap-1.5">
                  <span class="rounded-full bg-zinc-800 px-2 py-0.5">{tickets.length}</span>
                  {tickets.length > 0 && (
                    <ColumnMenu
                      from={state}
                      targets={targets.filter((t) => t !== state)}
                      onMove={bulkMove}
                    />
                  )}
                </div>
              </div>
              {tickets.map((t) => (
                <TicketCard
                  key={t.id}
                  projectId={projectId}
                  t={t}
                  companion={t.companionId ? byId.get(t.companionId) : undefined}
                  busy={Boolean(t.companionId && busy.has(t.companionId))}
                  running={running.has(t.id)}
                  guestLabel={guestByTicket.get(t.id)}
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

/** A per-column "⋯" menu offering a bulk move of every ticket in the column to
 *  another column or the bin. */
function ColumnMenu({
  from,
  targets,
  onMove,
}: {
  from: TicketState;
  targets: TicketState[];
  onMove: (from: TicketState, to: TicketState) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div class="relative">
      <button
        class="btn btn-sm btn-ghost px-1 py-0.5 text-zinc-500 hover:text-violet-400"
        title="Move all tickets in this column"
        onClick={() => setOpen((o) => !o)}
      >
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <>
          <div class="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div class="absolute right-0 z-30 mt-1 min-w-[160px] rounded-sm border border-zinc-700 bg-zinc-900 py-1 text-zinc-200 shadow-lg shadow-black/40">
            <div class="px-2.5 py-1 text-[10px] uppercase tracking-wide text-zinc-500">Move all to</div>
            {targets.map((to) => (
              <button
                key={to}
                class="block w-full px-2.5 py-1 text-left text-xs normal-case hover:bg-zinc-800 hover:text-violet-400"
                onClick={() => {
                  setOpen(false);
                  onMove(from, to);
                }}
              >
                {to === "bin" ? "🗑 Bin" : STATE_LABELS[to]}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function TicketCard({
  projectId,
  t,
  companion,
  busy,
  running,
  guestLabel,
  onEdit,
}: {
  projectId: string;
  t: Ticket;
  companion?: Companion;
  busy: boolean;
  running: boolean;
  guestLabel?: string;
  onEdit: () => void;
}) {
  return (
    <div
      draggable
      onDragStart={(e) => e.dataTransfer?.setData("text/plain", t.id)}
      onClick={onEdit}
      class={`mb-2.5 cursor-grab rounded-sm border border-zinc-800 bg-zinc-800/70 p-2.5 ${
        running ? "card-running" : "hover:border-violet-500"
      }`}
    >
      <div class="flex items-start justify-between gap-2">
        <div class="text-sm font-medium">{t.title}</div>
        <button
          class={`btn btn-sm shrink-0 px-2 py-0.5 ${
            running ? "text-red-400 opacity-100" : "text-emerald-400 opacity-60 hover:opacity-100"
          }`}
          disabled={busy}
          title={
            running
              ? guestLabel
                ? `Running on guest machine “${guestLabel}”`
                : "Agent is running on this ticket"
              : busy
                ? `${companion?.name ?? "Companion"} is busy with another ticket`
                : "Run an agent on this ticket (opens a live view)"
          }
          onClick={(e) => {
            e.stopPropagation();
            if (!busy) navigate(`#/project/${projectId}/ticket/${t.id}/run`);
          }}
        >
          {running ? <Loader2 size={14} class="animate-spin" /> : "▶"}
        </button>
      </div>
      <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
        <span class="tag">{t.priority}</span>
        {(() => {
          const pending = (t.dependencies ?? []).filter((d) => !d.satisfied);
          if (!t.blocked || pending.length === 0) return null;
          return (
            <span
              class="tag inline-flex items-center gap-1 text-amber-400"
              title={`Blocked by: ${pending.map((d) => d.title).join(", ")}`}
            >
              <Lock size={11} /> Blocked by {pending.length}
            </span>
          );
        })()}
        {guestLabel && (
          <span class="tag inline-flex items-center gap-1 text-sky-400" title={`Running on guest machine “${guestLabel}”`}>
            <CloudGlyph size={11} /> {guestLabel}
          </span>
        )}
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

