import { useEffect, useState } from "preact/hooks";
import {
  api,
  fmtBytes,
  fmtNum,
  type ProjectConfig,
  type ProjectDetail,
  type Recipe,
  type UsageBudget,
} from "./api";
import { useAsync } from "./hooks";
import { Markdown } from "./Markdown";
import { CodeEditor } from "./CodeEditor";
import { Modal } from "./ui";

type DocMode = "preview" | "split" | "edit";

// ---- Docs ---------------------------------------------------------------
export function DocsTab({ detail }: { detail: ProjectDetail }) {
  const projectId = detail.entry.id;
  const [docs, setDocs] = useState(detail.docs);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [saved, setSaved] = useState("");
  const [mode, setMode] = useState<DocMode>("preview");
  const [status, setStatus] = useState("");
  const [showNew, setShowNew] = useState(false);

  const dirty = content !== saved;

  const open = async (name: string) => {
    setSelected(name);
    setStatus("");
    const { content } = await api<{ content: string }>(`/api/projects/${projectId}/docs/${encodeURIComponent(name)}`);
    setContent(content);
    setSaved(content);
    setMode("preview");
  };

  const save = async () => {
    if (!selected || !dirty) return;
    const { doc } = await api<{ doc: { name: string; bytes: number; updated: string } }>(
      `/api/projects/${projectId}/docs/${encodeURIComponent(selected)}`,
      { method: "PUT", body: JSON.stringify({ content }) },
    );
    setSaved(content);
    setDocs((ds) => ds.map((d) => (d.name === doc.name ? doc : d)));
    setStatus("saved ✓");
    setTimeout(() => setStatus(""), 2000);
  };

  // ⌘/Ctrl-S saves when editing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && selected) {
        e.preventDefault();
        void save();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, content, saved]);

  const editor = (
    <CodeEditor
      class="input h-full min-h-[60vh] p-0 text-xs"
      value={content}
      onChange={setContent}
      onSave={save}
    />
  );
  const preview = (
    <div class="min-h-[60vh] overflow-auto rounded-sm border border-zinc-800 bg-zinc-950 p-4">
      <Markdown source={content} />
    </div>
  );

  return (
    <div class="grid grid-cols-[260px_1fr] gap-4">
      <div class="card self-start">
        {docs.length === 0 && <div class="text-sm text-zinc-500">No docs yet.</div>}
        {docs.map((d) => (
          <div
            key={d.name}
            onClick={() => open(d.name)}
            class={`cursor-pointer rounded-sm border px-2.5 py-2 ${
              selected === d.name ? "border-zinc-700 bg-zinc-800" : "border-transparent hover:bg-zinc-800/60"
            }`}
          >
            <div class="text-sm">
              {d.name}
              {selected === d.name && dirty && <span class="ml-1 text-amber-400">●</span>}
            </div>
            <div class="text-xs text-zinc-500">
              {fmtBytes(d.bytes)} · {new Date(d.updated).toLocaleString()}
            </div>
          </div>
        ))}
        <button class="btn btn-sm mt-2.5 w-full" onClick={() => setShowNew(true)}>
          + New doc
        </button>
      </div>

      <div class="card">
        {!selected ? (
          <div class="text-sm text-zinc-500">Select a doc to view and edit.</div>
        ) : (
          <>
            <div class="mb-2.5 flex items-center gap-2">
              <b>{selected}</b>
              {dirty && <span class="text-xs text-amber-400">● unsaved</span>}
              <div class="flex-1" />
              <div class="flex overflow-hidden rounded-sm border border-zinc-700">
                {(["preview", "split", "edit"] as DocMode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    class={`px-3 py-1 text-xs capitalize ${
                      mode === m ? "bg-violet-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-zinc-100"
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
              <span class="text-sm text-emerald-400">{status}</span>
              <button class="btn btn-primary btn-sm" onClick={save} disabled={!dirty}>
                Save
              </button>
            </div>

            {mode === "preview" && preview}
            {mode === "edit" && editor}
            {mode === "split" && (
              <div class="grid grid-cols-2 gap-3">
                {editor}
                {preview}
              </div>
            )}
            <div class="mt-1.5 text-right text-xs text-zinc-600">⌘/Ctrl+S to save</div>
          </>
        )}
      </div>

      {showNew && (
        <NewDocModal
          projectId={projectId}
          onClose={() => setShowNew(false)}
          onCreated={(name) => {
            setShowNew(false);
            setDocs((d) => (d.some((x) => x.name === name) ? d : [...d, { name, bytes: 0, updated: new Date().toISOString() }]));
            open(name);
          }}
        />
      )}
    </div>
  );
}

function NewDocModal({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string;
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const create = async () => {
    const n = name.trim();
    if (!n) return;
    try {
      const fileName = n.endsWith(".md") ? n : `${n}.md`;
      await api(`/api/projects/${projectId}/docs/${encodeURIComponent(fileName)}`, {
        method: "PUT",
        body: JSON.stringify({ content: `# ${fileName.replace(/\.md$/, "")}\n\n` }),
      });
      onCreated(fileName);
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };
  return (
    <Modal onClose={onClose}>
      <h2 class="mb-2 text-lg font-semibold">New doc</h2>
      <label class="field-label">File name</label>
      <input class="input" placeholder="DESIGN.md" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      {err && <p class="mt-2 text-sm text-red-400">{err}</p>}
      <div class="mt-4 flex justify-end gap-2">
        <button class="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button class="btn btn-primary" onClick={create}>
          Create
        </button>
      </div>
    </Modal>
  );
}

// ---- Memory -------------------------------------------------------------
export function MemoryTab({ detail }: { detail: ProjectDetail }) {
  return (
    <div class="card">
      <h2 class="text-lg font-semibold">Project memory</h2>
      <p class="text-sm text-zinc-400">
        Facts the companion has saved (one markdown file per fact, stored under .henson/memory).
      </p>
      {detail.memories.length === 0 && <div class="mt-2 text-sm text-zinc-500">No memories saved yet.</div>}
      {detail.memories.map((m) => (
        <div key={m.name} class="rounded-sm px-2.5 py-2 hover:bg-zinc-800/60">
          <div class="flex items-center gap-2">
            <b>{m.name}</b>
            {m.type && <span class="pill">{m.type}</span>}
          </div>
          <div class="text-xs text-zinc-500">{m.description || ""}</div>
        </div>
      ))}
    </div>
  );
}

// ---- Plugins & usage ----------------------------------------------------
export function PluginsTab({ detail }: { detail: ProjectDetail }) {
  const projectId = detail.entry.id;
  const usage = useAsync(() => api<UsageBudget>(`/api/projects/${projectId}/usage`), [projectId]);
  const plugins = useAsync(
    () => api<{ plugins: { id: string; name: string; description: string; active: boolean }[] }>(`/api/plugins?project=${projectId}`),
    [projectId],
  );

  const u = usage.data;
  const pct = u?.percentUsed ?? 0;
  const danger = u?.safetyMarginPercent != null && pct >= u.safetyMarginPercent;

  return (
    <div>
      <div class="card">
        {usage.loading && <div class="text-sm text-zinc-500">Loading usage…</div>}
        {u && !u.enabled && <div class="text-sm text-zinc-500">Usage monitor plugin is not enabled for this project.</div>}
        {u && u.enabled && (
          <>
            <div class="flex items-center gap-2">
              <h2 class="text-lg font-semibold">Claude usage</h2>
              <div class="flex-1" />
              <span class={`pill ${u.safeToContinue ? "border-emerald-500 text-emerald-400" : "border-red-500 text-red-400"}`}>
                {u.safeToContinue ? "safe to continue" : "pause work"}
              </span>
            </div>
            <p class="text-sm text-zinc-400">
              Rolling {u.windowHours}h window · resets ~{u.resetAt ? new Date(u.resetAt).toLocaleTimeString() : "—"}
            </p>
            <div class="mt-2 h-2.5 overflow-hidden rounded-full border border-zinc-800 bg-zinc-800">
              <div
                class={`h-full ${danger ? "bg-gradient-to-r from-amber-400 to-red-400" : "bg-gradient-to-r from-emerald-400 to-amber-400"}`}
                style={{ width: `${Math.min(100, pct)}%` }}
              />
            </div>
            <div class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <b class="text-zinc-400">Used</b>
              <span>
                {fmtNum(u.used)} / {fmtNum(u.limit)} tokens ({pct}%)
              </span>
              <b class="text-zinc-400">Remaining</b>
              <span>{fmtNum(u.remaining)}</span>
              <b class="text-zinc-400">Input / Output</b>
              <span>
                {fmtNum(u.breakdown?.input)} / {fmtNum(u.breakdown?.output)}
              </span>
              <b class="text-zinc-400">Cache (create/read)</b>
              <span>
                {fmtNum(u.breakdown?.cacheCreation)} / {fmtNum(u.breakdown?.cacheRead)}
              </span>
              <b class="text-zinc-400">Messages</b>
              <span>{fmtNum(u.breakdown?.messages)}</span>
            </div>
            <p class="mt-3 text-sm">{u.recommendation}</p>
          </>
        )}
      </div>

      <div class="card mt-4">
        <h2 class="text-lg font-semibold">Plugins</h2>
        {(plugins.data?.plugins ?? []).map((p) => (
          <div key={p.id} class="rounded-sm px-2.5 py-2 hover:bg-zinc-800/60">
            <div class="flex items-center gap-2">
              <b>{p.name}</b>
              <span class={`pill ${p.active ? "border-emerald-500 text-emerald-400" : ""}`}>
                {p.active ? "enabled" : "available"}
              </span>
            </div>
            <div class="text-xs text-zinc-500">{p.description}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Companion ----------------------------------------------------------
function gitLabel(git: Recipe["git"]): string {
  return git.strategy === "new-branch"
    ? `new branch per ticket${git.branchPrefix ? ` (${git.branchPrefix}…)` : ""}`
    : "discrete commits on current branch";
}

export function CompanionTab({ detail }: { detail: ProjectDetail }) {
  const c = detail.config;
  const path = detail.entry.path;
  const cmd = `henson mcp ${path}`;
  const mcpJson = JSON.stringify(
    { mcpServers: { [`henson-${detail.entry.name}`]: { command: "henson", args: ["mcp", path] } } },
    null,
    2,
  );
  const recipes = useAsync(() => api<{ recipes: Recipe[] }>("/api/recipes"), []);
  const [recipe, setRecipe] = useState(c.companion.recipe || "solo");
  const [companion, setCompanion] = useState({ name: c.companion.name, avatar: c.companion.avatar });
  const [saving, setSaving] = useState("");
  const [regenerating, setRegenerating] = useState(false);

  const choose = async (id: string) => {
    if (id === recipe || saving) return;
    setSaving(id);
    try {
      await api(`/api/projects/${detail.entry.id}/config`, { method: "PATCH", body: JSON.stringify({ recipe: id }) });
      setRecipe(id);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSaving("");
    }
  };

  const regenerate = async () => {
    if (regenerating) return;
    setRegenerating(true);
    try {
      const { config } = await api<{ config: ProjectConfig }>(`/api/projects/${detail.entry.id}/config`, {
        method: "PATCH",
        body: JSON.stringify({ regenerateCompanion: true }),
      });
      setCompanion({ name: config.companion.name, avatar: config.companion.avatar });
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <div>
      <div class="card">
        <div class="flex items-center gap-3">
          <div class="text-4xl leading-none">{companion.avatar}</div>
          <div>
            <h2 class="text-lg font-semibold">{companion.name}</h2>
            <div class="text-sm text-zinc-400">Companion for {detail.entry.name}</div>
          </div>
          <div class="flex-1" />
          <button class="btn" disabled={regenerating} onClick={regenerate} title="Roll a new name and avatar">
            {regenerating ? "Regenerating…" : "🎲 Regenerate"}
          </button>
        </div>
        <div class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <b class="text-zinc-400">Active recipe</b>
          <span>{recipe}</span>
          <b class="text-zinc-400">Yolo mode</b>
          <span>{c.yolo ? "⚡ on — may work autonomously within usage budget" : "off"}</span>
          <b class="text-zinc-400">Plugins</b>
          <span>{c.plugins.join(", ") || "(none)"}</span>
        </div>
      </div>

      <PermissionsCard projectId={detail.entry.id} config={c} />

      <div class="card mt-4">
        <h2 class="text-lg font-semibold">Connect an agent</h2>
        <p class="text-sm text-zinc-400">Give Claude Code (or any MCP client) access to this project's board, docs and memory:</p>
        <label class="field-label">Run the MCP server</label>
        <textarea class="input h-[42px] font-mono text-xs" readOnly value={cmd} />
        <label class="field-label">…or add to your MCP client config</label>
        <textarea class="input min-h-[140px] font-mono text-xs" readOnly value={mcpJson} />
      </div>

      <div class="card mt-4">
        <h2 class="text-lg font-semibold">Agent-team recipes</h2>
        <p class="text-sm text-zinc-400">Toggle the companion onto a recipe. It sets the team roles and how the agents use git.</p>
        {(recipes.data?.recipes ?? []).map((r) => {
          const active = r.id === recipe;
          return (
            <div
              key={r.id}
              onClick={() => choose(r.id)}
              class={`mt-1.5 cursor-pointer rounded-sm border px-2.5 py-2 ${
                active ? "border-violet-500 bg-violet-500/10" : "border-transparent hover:bg-zinc-800/60"
              }`}
            >
              <div class="flex items-center gap-2">
                <b>{r.name} </b>
                <span class="pill">{r.id}</span>
                <div class="flex-1" />
                {saving === r.id ? (
                  <span class="text-xs text-zinc-500">saving…</span>
                ) : active ? (
                  <span class="pill border-violet-500 text-violet-300">✓ active</span>
                ) : (
                  <span class="text-xs text-zinc-500">Use this</span>
                )}
              </div>
              <div class="text-xs text-zinc-500">{r.description}</div>
              <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
                {r.roles.map((role) => (
                  <span key={role.role} class="badge" title={role.description}>
                    {role.role}
                  </span>
                ))}
                <span class="badge" title="Git behaviour for this recipe">⎇ {gitLabel(r.git)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PermissionsCard({ projectId, config }: { projectId: string; config: ProjectConfig }) {
  const [allowed, setAllowed] = useState((config.allowedTools ?? []).join("\n"));
  const [disallowed, setDisallowed] = useState((config.disallowedTools ?? []).join("\n"));
  const [status, setStatus] = useState("");

  const toList = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
  const save = async () => {
    await api(`/api/projects/${projectId}/config`, {
      method: "PATCH",
      body: JSON.stringify({ allowedTools: toList(allowed), disallowedTools: toList(disallowed) }),
    });
    setStatus("saved ✓");
    setTimeout(() => setStatus(""), 2000);
  };

  return (
    <div class="card mt-4">
      <div class="flex items-center gap-2">
        <h2 class="text-lg font-semibold">Permissions</h2>
        <div class="flex-1" />
        <span class="text-sm text-emerald-400">{status}</span>
        <button class="btn btn-primary btn-sm" onClick={save}>
          Save
        </button>
      </div>
      <p class="text-sm text-zinc-400">
        {config.yolo
          ? "⚡ Yolo is on — the companion runs with bypassPermissions and may use any tool. These lists are ignored until yolo is off."
          : "With yolo off, the companion runs with --permission-mode acceptEdits (file edits allowed). List tools it may use without prompting, one per line."}
      </p>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="field-label">Allowed tools</label>
          <textarea
            class="input min-h-[120px] font-mono text-xs"
            placeholder={"Edit\nWrite\nBash(npm test:*)\nBash(git *)"}
            value={allowed}
            onInput={(e) => setAllowed((e.target as HTMLTextAreaElement).value)}
          />
        </div>
        <div>
          <label class="field-label">Disallowed tools</label>
          <textarea
            class="input min-h-[120px] font-mono text-xs"
            placeholder={"Bash(rm *)\nWebFetch"}
            value={disallowed}
            onInput={(e) => setDisallowed((e.target as HTMLTextAreaElement).value)}
          />
        </div>
      </div>
      <p class="mt-2 text-xs text-zinc-500">
        Tool names follow Claude Code syntax: a tool (<code>Edit</code>, <code>Write</code>, <code>Read</code>) or a
        scoped command like <code>Bash(npm test:*)</code>. Allowed → <code>--allowedTools</code>, disallowed →{" "}
        <code>--disallowedTools</code>.
      </p>
    </div>
  );
}
