import { useState } from "preact/hooks";
import { api, STATE_LABELS, type DiscoveredDoc, type ProjectListItem, type Recipe, type TicketState } from "./api";
import { useAsync } from "./hooks";
import { ErrorBox, Loading, Modal } from "./ui";
import { Avatar } from "./Avatar";
import type { AppEvent } from "./App";

// Card omits "backlog" (it's the unstarted pile) and shows four equal-width counts.
const CARD_COUNTS: TicketState[] = ["ready", "in-progress", "review", "done"];

export function Home({ evt }: { evt: AppEvent }) {
  const { data, error, loading, reload } = useAsync(
    () => api<{ projects: ProjectListItem[] }>("/api/projects"),
    [evt.seq],
  );
  const [showNew, setShowNew] = useState(false);

  return (
    <div>
      <div class="mb-6 flex items-center gap-4">
        <h1 class="text-xl font-semibold">Projects</h1>
        <div class="flex-1" />
        <button class="btn btn-primary" onClick={() => setShowNew(true)}>
          + New project
        </button>
      </div>

      {loading && !data && <Loading />}
      {error && <ErrorBox message={`Failed to load: ${error}`} />}
      {data && data.projects.length === 0 && (
        <div class="p-10 text-center text-zinc-500">
          <p>No projects yet.</p>
          <p>Initialise Mysteron in a project to get a companion, a board, and shared docs.</p>
        </div>
      )}

      {data && data.projects.length > 0 && (
        <div class="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-4">
          {data.projects.map((p) => (
            <ProjectCard key={p.id} p={p} />
          ))}
        </div>
      )}

      {showNew && (
        <NewProjectModal
          onClose={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

function ProjectCard({ p }: { p: ProjectListItem }) {
  const companions = p.companions ?? [];
  const lead = companions.find((c) => c.role === "soloist") ?? companions[0];
  return (
    <a href={`#/project/${p.id}`} class="card block transition hover:-translate-y-0.5 hover:border-violet-500">
      <div class="flex items-center gap-3">
        <Avatar seed={p.name} variant="marble" size={36} />
        <div>
          <div class="text-base font-semibold">{p.name}</div>
          <div class="text-sm text-zinc-400">
            {companions.length === 0
              ? "(uninitialised)"
              : companions.length === 1
                ? `${lead.name} · ${lead.role}`
                : `${companions.length} companions · ${p.recipe}`}
          </div>
        </div>
      </div>

      <div class="mt-3 flex flex-wrap gap-1.5">
        {p.autopilot && p.autopilot !== "stopped" && (
          <span class="badge border-emerald-500 text-emerald-400">🤖 autopilot: {p.autopilot}</span>
        )}
        {p.yolo && <span class="badge border-amber-400 text-amber-400">⚡ yolo</span>}
        {p.pendingDocSync && <span class="badge border-cyan-400 text-cyan-400">docs changed — review tickets</span>}
        {(p.plugins || []).map((pl) => (
          <span key={pl} class="badge">
            {pl}
          </span>
        ))}
        {!p.valid && <span class="badge">⚠ not initialised</span>}
      </div>

      <div class="mt-3.5 grid grid-cols-4 gap-2">
        {CARD_COUNTS.map((s) => (
          <div key={s} class="flex flex-col items-center">
            <b class={`text-lg ${s === "done" ? "text-emerald-400" : ""}`}>{p.counts?.[s] ?? 0}</b>
            <span class="text-center text-[10px] uppercase tracking-wide text-zinc-500">{STATE_LABELS[s]}</span>
          </div>
        ))}
      </div>

      <div class="mt-3 break-all font-mono text-[11px] text-zinc-500">{p.path}</div>
    </a>
  );
}

function NewProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [recipe, setRecipe] = useState("solo");
  const [found, setFound] = useState<DiscoveredDoc[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [err, setErr] = useState("");
  const recipes = useAsync(() => api<{ recipes: Recipe[] }>("/api/recipes"), []);
  const chosen = recipes.data?.recipes.find((r) => r.id === recipe);

  const scan = async () => {
    if (!path.trim()) return;
    setScanning(true);
    setFound(null);
    try {
      const { docs } = await api<{ docs: DiscoveredDoc[] }>("/api/discover", {
        method: "POST",
        body: JSON.stringify({ path: path.trim() }),
      });
      setFound(docs);
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setScanning(false);
    }
  };

  const submit = async () => {
    setErr("");
    try {
      await api("/api/projects/init", {
        method: "POST",
        body: JSON.stringify({ path: path.trim(), name: name.trim() || undefined, recipe }),
      });
      onCreated();
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  return (
    <Modal onClose={onClose}>
      <h2 class="mb-1 text-lg font-semibold">New Mysteron project</h2>
      <p class="text-sm text-zinc-400">
        Initialise Mysteron inside an existing folder. Creates a .mysteron/ board and a randomly-named companion,
        and imports any docs the project already has (README, SPEC, anything under docs/).
      </p>
      <div class="flex items-end gap-2">
        <div class="flex-1">
          <label class="field-label">Project path</label>
          <input
            class="input"
            placeholder="/absolute/path/to/your/project"
            value={path}
            onInput={(e) => setPath((e.target as HTMLInputElement).value)}
            onBlur={scan}
          />
        </div>
        <button class="btn btn-sm" onClick={scan}>
          Scan
        </button>
      </div>
      <label class="field-label">Name</label>
      <input
        class="input"
        placeholder="(optional — defaults to folder name)"
        value={name}
        onInput={(e) => setName((e.target as HTMLInputElement).value)}
      />

      <label class="field-label">Team recipe</label>
      <select class="input" value={recipe} onChange={(e) => setRecipe((e.target as HTMLSelectElement).value)}>
        {(recipes.data?.recipes ?? [{ id: "solo", name: "Solo" } as Recipe]).map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
      {chosen && (
        <p class="mt-1 text-xs text-zinc-500">
          {chosen.description} Companions: {chosen.roles.map((x) => x.role).join(", ")}.
        </p>
      )}

      {scanning && <p class="mt-2 text-sm text-zinc-500">Scanning…</p>}
      {found && found.length > 0 && (
        <div class="mt-3">
          <label class="field-label">Found {found.length} existing doc(s) — these will be imported:</label>
          {found.map((d) => (
            <div key={d.relPath} class="flex items-center justify-between rounded-sm px-2 py-1 hover:bg-zinc-800/60">
              <span class="text-sm">{d.relPath}</span>
              <span class="pill ml-2">{d.kind === "spec" ? "→ SPEC.md" : `→ ${d.importName}`}</span>
            </div>
          ))}
        </div>
      )}
      {found && found.length === 0 && <p class="mt-2 text-sm text-zinc-500">No existing docs found here.</p>}

      {err && <p class="mt-2 text-sm text-red-400">{err}</p>}

      <div class="mt-4 flex justify-end gap-2">
        <button class="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button class="btn btn-primary" onClick={submit}>
          Create
        </button>
      </div>
    </Modal>
  );
}
