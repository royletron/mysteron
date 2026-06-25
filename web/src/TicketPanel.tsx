import { useState } from "preact/hooks";
import { CodeEditor } from "./CodeEditor";
import {
  RUN_STATUS,
  STATE_LABELS,
  api,
  fmtCost,
  fmtWhen,
  type Companion,
  type RunSummary,
  type Ticket,
  type TicketPriority,
  type TicketState,
} from "./api";
import { useAsync } from "./hooks";
import { LiveDot, RunTimer, RunMachine } from "./ui";
import { Lock } from "lucide-preact";
import type { AppEvent } from "./App";

function agentViewUrl(projectId: string, ticketId: string, run = false): string {
  return `#/project/${projectId}/ticket/${ticketId}${run ? "/run" : ""}`;
}

/**
 * GitHub-style side panel for a ticket: editable details plus the ticket's agent
 * run history. Replaces the old centered edit modal. Pass `ticket=null` for a new
 * ticket (the history section is hidden until the ticket exists).
 */
export function TicketPanel({
  projectId,
  ticket,
  companions,
  allTickets = [],
  evt,
  onClose,
  onSaved,
}: {
  projectId: string;
  ticket: Ticket | null;
  companions: Companion[];
  /** Every ticket on the board, for picking dependencies. */
  allTickets?: Ticket[];
  evt: AppEvent;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = Boolean(ticket);
  const [title, setTitle] = useState(ticket?.title ?? "");
  const [body, setBody] = useState(ticket?.body ?? "");
  const [state, setState] = useState<TicketState>(ticket?.state ?? "backlog");
  const [priority, setPriority] = useState<TicketPriority>(ticket?.priority ?? "medium");
  const [labels, setLabels] = useState((ticket?.labels ?? []).join(", "));
  const [companionId, setCompanionId] = useState(ticket?.companionId ?? "");
  const [blockedBy, setBlockedBy] = useState<string[]>(ticket?.blockedBy ?? []);
  const [err, setErr] = useState("");

  const save = async () => {
    if (!title.trim()) {
      setErr("Title is required");
      return;
    }
    const payload = {
      title: title.trim(),
      body,
      state,
      priority,
      companionId: companionId || undefined,
      labels: labels.split(",").map((s) => s.trim()).filter(Boolean),
      blockedBy,
    };
    try {
      if (isEdit && ticket) {
        await api(`/api/projects/${projectId}/tickets/${ticket.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await api(`/api/projects/${projectId}/tickets`, { method: "POST", body: JSON.stringify(payload) });
      }
      onSaved();
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  const del = async () => {
    if (ticket && confirm("Delete this ticket?")) {
      await api(`/api/projects/${projectId}/tickets/${ticket.id}`, { method: "DELETE" });
      onSaved();
    }
  };

  return (
    <div
      class="fixed inset-0 z-40 bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div class="drawer">
        <header class="flex items-center gap-3 border-b border-zinc-800 px-5 py-3">
          <h2 class="text-lg font-semibold">{isEdit ? "Ticket" : "New ticket"}</h2>
          {ticket && <span class="font-mono text-xs text-zinc-500">{ticket.id}</span>}
          <div class="flex-1" />
          <button class="btn btn-ghost btn-sm text-lg leading-none" title="Close" onClick={onClose}>
            ✕
          </button>
        </header>

        <div class="flex-1 overflow-auto px-5 py-4">
          <label class="field-label !mt-0">Title</label>
          <input class="input" value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
          <label class="field-label">Description</label>
          <CodeEditor
            class="input min-h-[120px] text-xs"
            value={body}
            onChange={setBody}
            onSave={save}
            placeholder="Describe the ticket… (markdown supported)"
          />
          <div class="flex gap-2.5">
            <div class="flex-1">
              <label class="field-label">State</label>
              <select
                class="input"
                value={state}
                onChange={(e) => setState((e.target as HTMLSelectElement).value as TicketState)}
              >
                {(Object.keys(STATE_LABELS) as TicketState[]).map((s) => (
                  <option key={s} value={s}>
                    {STATE_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
            <div class="flex-1">
              <label class="field-label">Priority</label>
              <select
                class="input"
                value={priority}
                onChange={(e) => setPriority((e.target as HTMLSelectElement).value as TicketPriority)}
              >
                {(["low", "medium", "high"] as TicketPriority[]).map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <label class="field-label">Companion</label>
          <select
            class="input"
            value={companionId}
            onChange={(e) => setCompanionId((e.target as HTMLSelectElement).value)}
          >
            <option value="">Unassigned</option>
            {companions.map((comp) => (
              <option key={comp.id} value={comp.id}>
                {comp.name} — {comp.role}
              </option>
            ))}
          </select>
          <label class="field-label">Labels</label>
          <input
            class="input"
            placeholder="comma, separated, labels"
            value={labels}
            onInput={(e) => setLabels((e.target as HTMLInputElement).value)}
          />

          <Dependencies
            ticket={ticket}
            allTickets={allTickets}
            blockedBy={blockedBy}
            onChange={setBlockedBy}
          />

          {err && <p class="mt-2 text-sm text-red-400">{err}</p>}

          {isEdit && ticket ? (
            <Attachments projectId={projectId} ticketId={ticket.id} initial={ticket.attachments ?? []} />
          ) : (
            <>
              <label class="field-label">Images</label>
              <p class="text-xs text-zinc-500">Create the ticket first, then reopen it to attach images.</p>
            </>
          )}

          {isEdit && ticket && <AgentHistory projectId={projectId} ticketId={ticket.id} evt={evt} />}
        </div>

        <footer class="flex items-center gap-2 border-t border-zinc-800 px-5 py-3">
          {isEdit && (
            <button class="btn btn-danger" onClick={del}>
              Delete
            </button>
          )}
          <div class="flex-1" />
          <button class="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button class="btn btn-primary" onClick={save}>
            {isEdit ? "Save" : "Create"}
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * Dependency editor. "Blocked by" = the tickets this one waits on (they must be
 * done and merged to main before it leaves the queue). "Blocks" = the downstream
 * tickets waiting on this one — read-only, since it's the inverse of their own
 * "blocked by". Pick from any other ticket on the board.
 */
function Dependencies({
  ticket,
  allTickets,
  blockedBy,
  onChange,
}: {
  ticket: Ticket | null;
  allTickets: Ticket[];
  blockedBy: string[];
  onChange: (ids: string[]) => void;
}) {
  const byId = new Map(allTickets.map((t) => [t.id, t]));
  // Candidates: every other ticket not already a dependency. Excluding self keeps
  // a ticket from blocking itself; the server treats a missing id as satisfied.
  const candidates = allTickets.filter((t) => t.id !== ticket?.id && !blockedBy.includes(t.id));
  const blocks = ticket?.blocks ?? [];

  const add = (id: string) => {
    if (id && !blockedBy.includes(id)) onChange([...blockedBy, id]);
  };
  const remove = (id: string) => onChange(blockedBy.filter((x) => x !== id));

  return (
    <div class="mt-3">
      <label class="field-label !mt-0 flex items-center gap-1.5">
        <Lock size={12} /> Blocked by
      </label>
      <p class="mb-1.5 text-xs text-zinc-500">
        This ticket waits in the queue until these are done and merged to main.
      </p>
      {blockedBy.length > 0 && (
        <div class="mb-2 flex flex-col gap-1">
          {blockedBy.map((id) => {
            const dep = byId.get(id);
            const satisfied = dep?.state === "done";
            return (
              <div
                key={id}
                class="flex items-center gap-2 rounded-sm border border-zinc-800 bg-zinc-900/60 px-2.5 py-1 text-xs"
              >
                <span class={satisfied ? "text-emerald-400" : "text-amber-400"} title={satisfied ? "Landed" : "Not yet in main"}>
                  {satisfied ? "✓" : "⏳"}
                </span>
                <span class="flex-1 truncate">{dep ? dep.title : id}</span>
                {dep && <span class="text-zinc-500">{STATE_LABELS[dep.state]}</span>}
                <button class="text-zinc-500 hover:text-red-400" title="Remove dependency" onClick={() => remove(id)}>
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}
      {candidates.length > 0 ? (
        <select
          class="input"
          value=""
          onChange={(e) => {
            const sel = e.target as HTMLSelectElement;
            add(sel.value);
            sel.value = "";
          }}
        >
          <option value="">+ Add a dependency…</option>
          {candidates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title} ({STATE_LABELS[t.state]})
            </option>
          ))}
        </select>
      ) : (
        <p class="text-xs text-zinc-600">No other tickets to depend on.</p>
      )}

      {blocks.length > 0 && (
        <>
          <label class="field-label">Blocks</label>
          <p class="mb-1.5 text-xs text-zinc-500">Tickets waiting on this one before they can run.</p>
          <div class="flex flex-col gap-1">
            {blocks.map((b) => (
              <div key={b.id} class="flex items-center gap-2 rounded-sm border border-zinc-800 px-2.5 py-1 text-xs text-zinc-400">
                <span class="flex-1 truncate">{b.title}</span>
                <span class="text-zinc-500">{STATE_LABELS[b.state]}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Image attachments for a ticket: upload, preview thumbnails, remove. The agent
 *  reads these before starting (see buildPrompt's "Attached images" section). */
function Attachments({ projectId, ticketId, initial }: { projectId: string; ticketId: string; initial: string[] }) {
  const [items, setItems] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const base = `/api/projects/${projectId}/tickets/${ticketId}/attachments`;

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setErr("");
    try {
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) continue;
        const res = await fetch(`${base}?name=${encodeURIComponent(file.name)}`, {
          method: "POST",
          headers: { "Content-Type": file.type },
          body: file,
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
        const { ticket } = (await res.json()) as { ticket: Ticket };
        setItems(ticket.attachments ?? []);
      }
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    const { ticket } = await api<{ ticket: Ticket }>(`${base}/${encodeURIComponent(name)}`, { method: "DELETE" });
    setItems(ticket.attachments ?? []);
  };

  return (
    <div class="mt-3">
      <label class="field-label">Images</label>
      <p class="mb-1.5 text-xs text-zinc-500">Attached images are shown to the agent — it reads them before starting.</p>
      {items.length > 0 && (
        <div class="mb-2 grid grid-cols-3 gap-2">
          {items.map((name) => (
            <div key={name} class="group relative">
              <img
                src={`${base}/${encodeURIComponent(name)}`}
                alt={name}
                class="h-20 w-full rounded-sm border border-zinc-800 object-cover"
              />
              <button
                class="absolute right-1 top-1 rounded-sm bg-black/70 px-1 text-xs text-zinc-300 opacity-0 hover:text-red-400 group-hover:opacity-100"
                title="Remove"
                onClick={() => remove(name)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <label class="btn btn-sm cursor-pointer">
        {busy ? "Uploading…" : "+ Add images"}
        <input
          type="file"
          accept="image/*"
          multiple
          class="hidden"
          disabled={busy}
          onChange={(e) => {
            const t = e.target as HTMLInputElement;
            void upload(t.files);
            t.value = "";
          }}
        />
      </label>
      {err && <p class="mt-1 text-xs text-red-400">{err}</p>}
    </div>
  );
}

/** The ticket's agent run history, fetched live and linking out to the agent view. */
function AgentHistory({ projectId, ticketId, evt }: { projectId: string; ticketId: string; evt: AppEvent }) {
  const matchSeq = evt.projectId === projectId ? evt.seq : -1;
  const { data, loading } = useAsync(
    () => api<{ runs: RunSummary[] }>(`/api/projects/${projectId}/runs`),
    [projectId, ticketId, matchSeq],
  );
  const runs = (data?.runs ?? []).filter((r) => r.ticketId === ticketId);
  const active = runs.some((r) => r.status === "running");

  const runRow = (r: RunSummary) => {
    const s = RUN_STATUS[r.status];
    return (
      <a
        key={r.id}
        href={agentViewUrl(projectId, ticketId)}
        title={r.command}
        class="flex flex-col gap-1 rounded-sm border border-zinc-800 px-2.5 py-1.5 text-xs text-zinc-400 hover:border-violet-500"
      >
        <span class="flex items-center justify-between gap-2">
          <span class={`inline-flex items-center gap-1.5 ${s?.color}`}>
            {s?.live && <LiveDot />}
            {s?.label || r.status}
          </span>
          <span class="flex items-center gap-2 text-zinc-500">
            <span>{r.companion}</span>
            <span>·</span>
            <span>{fmtWhen(r.startedAt)}</span>
            <RunTimer run={r} prefix="· " />
            {r.costUsd != null && <span title={r.numTurns != null ? `${r.numTurns} turns` : undefined}>· {fmtCost(r.costUsd)}</span>}
          </span>
        </span>
        <span class="flex items-center justify-end gap-2">
          {r.branch && (
            <span class="inline-flex items-center gap-1 text-violet-300" title={`Work committed to branch ${r.branch} — git merge ${r.branch}`}>
              ⎇ {r.branch}
            </span>
          )}
          <RunMachine run={r} />
        </span>
      </a>
    );
  };

  return (
    <div class="mt-5 border-t border-zinc-800 pt-4">
      <div class="mb-2 flex items-center justify-between">
        <span class="text-xs uppercase tracking-wide text-zinc-500">Agent history</span>
        <a
          class="btn btn-sm text-emerald-400"
          href={agentViewUrl(projectId, ticketId, !active)}
          title={active ? "An agent is already working — open the live view" : "Run an agent on this ticket"}
        >
          {active ? (
            <>
              <LiveDot /> view live
            </>
          ) : (
            "▶ Run agent"
          )}
        </a>
      </div>
      {loading && !data ? (
        <div class="pulse text-sm text-zinc-500">Loading…</div>
      ) : runs.length === 0 ? (
        <div class="text-sm text-zinc-500">No agent runs yet. Press “Run agent” to start the companion.</div>
      ) : (
        <div class="flex flex-col gap-1.5">{runs.map(runRow)}</div>
      )}
    </div>
  );
}
