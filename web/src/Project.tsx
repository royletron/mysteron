import { useEffect, useRef, useState } from "preact/hooks";
import { api, type ProjectDetail, type Ticket } from "./api";
import { navigate, useAsync } from "./hooks";
import { ErrorBox, Loading } from "./ui";
import { Board } from "./Board";
import { TicketPanel } from "./TicketPanel";
import { DocsTab, MemoryTab, PluginsTab, CompanionTab, CommitsTab, BinTab } from "./tabs";
import { Avatar } from "./Avatar";
import type { AppEvent } from "./App";

const TABS: [string, string][] = [
  ["board", "Board"],
  ["docs", "Docs"],
  ["memory", "Memory"],
  ["commits", "Commits"],
  ["plugins", "Plugins & usage"],
  ["agent", "Companion"],
  ["bin", "Bin"],
];

export function Project({ projectId, tab: urlTab, evt }: { projectId: string; tab?: string; evt: AppEvent }) {
  const tab = urlTab || "board";
  const [savingYolo, setSavingYolo] = useState(false);
  const [editing, setEditing] = useState<Ticket | "new" | null>(null);

  // The tab bar is sticky under the 52px app header. We only want its solid
  // backdrop once it's actually stuck — otherwise its black bg covers the page
  // gradient. A zero-height sentinel sits just above the bar; when it scrolls
  // past the 52px line (rootMargin top), the bar is stuck.
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(([e]) => setStuck(!e.isIntersecting), {
      rootMargin: "-52px 0px 0px 0px",
      threshold: 0,
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  const matchSeq = evt.projectId === projectId ? evt.seq : -1;
  const { data, error, loading, reload } = useAsync(
    () => api<ProjectDetail>(`/api/projects/${projectId}`),
    [projectId, matchSeq],
  );

  if (loading && !data) return <Loading />;
  if (error || !data)
    return (
      <div>
        <ErrorBox message={`Could not load project: ${error}`} />
        <div class="text-center">
          <a href="#/" class="btn btn-ghost">
            ← back
          </a>
        </div>
      </div>
    );

  const c = data.config;
  const apActive = Boolean(data.autopilot && data.autopilot.status !== "stopped");

  const setAutopilot = async (action: "start" | "stop") => {
    await api(`/api/projects/${projectId}/autopilot/${action}`, { method: "POST" });
    reload();
  };

  const unregister = async () => {
    if (!confirm(`Unregister "${data.entry.name}"? This only removes it from Mysteron's registry — files stay on disk.`))
      return;
    await api(`/api/projects/${projectId}`, { method: "DELETE" });
    location.hash = "#/";
  };

  const toggleYolo = async () => {
    const turningOn = !c.yolo;
    if (
      turningOn &&
      !confirm(
        "Enable yolo mode?\n\nThe companion will run with --permission-mode bypassPermissions — it can edit files AND run commands (tests, git, installs) without asking. Only enable for projects you're happy to let run autonomously.",
      )
    )
      return;
    setSavingYolo(true);
    try {
      await api(`/api/projects/${projectId}/config`, { method: "PATCH", body: JSON.stringify({ yolo: turningOn }) });
      reload();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSavingYolo(false);
    }
  };

  return (
    <div>
      <div class="mb-4 flex items-center gap-3">
        <a href="#/" class="btn btn-ghost btn-sm">
          ←
        </a>
        <Avatar seed={data.entry.name} variant="marble" size={34} />
        <div>
          <h1 class="text-xl font-semibold">{data.entry.name}</h1>
          <div class="text-sm text-zinc-400">
            {c.companions.length} companion{c.companions.length === 1 ? "" : "s"} · recipe: {c.recipe}
          </div>
        </div>
        <div class="flex-1" />
        <button
          class={`btn btn-sm ${c.yolo ? "border-amber-400 text-amber-400" : "text-zinc-400"}`}
          onClick={toggleYolo}
          disabled={savingYolo}
          title="Yolo: run the companion autonomously (bypass permission prompts) within the usage budget"
        >
          <span class={`inline-block h-2 w-2 rounded-full ${c.yolo ? "bg-amber-400" : "bg-zinc-600"}`} />
          {c.yolo ? "⚡ Yolo on" : "Yolo off"}
        </button>
        <button class="btn btn-danger btn-sm" onClick={unregister}>
          Unregister
        </button>
      </div>

      {data.pendingDocSync && (
        <div class="card mb-3.5 flex items-center gap-3 border-cyan-400">
          <span>📝 Docs changed since last review — the companion should re-read the spec and pull any new tickets.</span>
          <div class="flex-1" />
          <button
            class="btn btn-sm"
            onClick={async () => {
              await api(`/api/projects/${projectId}/sync-clear`, { method: "POST" });
              reload();
            }}
          >
            Mark reviewed
          </button>
        </div>
      )}

      <div ref={sentinelRef} aria-hidden class="h-px" />
      <div
        class={`sticky top-[52px] z-10 -mx-6 mb-4 flex items-center gap-1.5 px-6 transition-colors ${
          stuck ? "border-b border-zinc-800 bg-zinc-950/80 backdrop-blur" : ""
        }`}
      >
        {TABS.map(([key, label]) => (
          <a
            key={key}
            href={`#/project/${projectId}/${key}`}
            class={`cursor-pointer border-b-2 px-4 py-2 ${
              tab === key ? "border-violet-500 text-zinc-100" : "border-transparent text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {label}
          </a>
        ))}
        <div class="flex-1" />
        {tab === "board" && (
          <div class="flex items-center gap-2">
            <button class="btn btn-primary btn-sm" onClick={() => setEditing("new")}>
              + Add ticket
            </button>
            {apActive ? (
              <button class="btn btn-danger btn-sm" onClick={() => setAutopilot("stop")}>
                ■ Stop autopilot
              </button>
            ) : (
              <button
                class="btn btn-sm"
                title="Pulls ready tickets one at a time and runs the companion on each, within the usage budget"
                onClick={() => setAutopilot("start")}
              >
                🤖 Start autopilot
              </button>
            )}
          </div>
        )}
      </div>

      {tab === "board" && <Board detail={data} onEdit={setEditing} reload={reload} />}
      {tab === "docs" && <DocsTab detail={data} />}
      {tab === "memory" && <MemoryTab detail={data} />}
      {tab === "commits" && <CommitsTab detail={data} />}
      {tab === "plugins" && <PluginsTab detail={data} />}
      {tab === "agent" && <CompanionTab detail={data} />}
      {tab === "bin" && <BinTab detail={data} reload={reload} />}

      {editing && (
        <TicketPanel
          projectId={projectId}
          ticket={editing === "new" ? null : editing}
          companions={c.companions}
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
