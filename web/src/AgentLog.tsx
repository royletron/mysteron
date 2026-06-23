import { useMemo, useState } from "preact/hooks";
import type { RunLine } from "./api";
import { Markdown } from "./Markdown";
import { Code } from "./Code";
import { langId } from "./highlight";

type Entry =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; arg: string; result?: string }
  | { type: "note"; text: string; tone: string }
  | { type: "stderr"; text: string };

const TOOL_ICONS: Record<string, string> = {
  Bash: "⌘",
  Read: "📄",
  Write: "✍️",
  Edit: "✏️",
  MultiEdit: "✏️",
  NotebookEdit: "📓",
  Glob: "🗂",
  Grep: "🔎",
  LS: "📁",
  Task: "🤖",
  Agent: "🤖",
  WebFetch: "🌐",
  WebSearch: "🌐",
  TodoWrite: "☑️",
};

function toolIcon(name: string): string {
  if (TOOL_ICONS[name]) return TOOL_ICONS[name];
  if (name.startsWith("mcp__henson__")) return "📋";
  if (name.startsWith("mcp__")) return "🔌";
  return "🔧";
}

/** Best-effort Prism language for a tool's detail, inferred from its name/args. */
function detailLang(name: string, arg: string, result: string): string | undefined {
  if (name === "Bash") return undefined; // terminal output, not code
  if (/^(Read|Write|Edit|MultiEdit|NotebookEdit)$/.test(name)) {
    const ext = arg.match(/\.([a-z0-9]+)\b/i)?.[1];
    const byExt = langId(ext?.toLowerCase());
    if (byExt) return byExt;
  }
  const head = result.trimStart();
  if (head.startsWith("{") || head.startsWith("[")) return "json";
  return undefined;
}

function parse(lines: RunLine[]): Entry[] {
  const out: Entry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.stream === "stderr") {
      out.push({ type: "stderr", text: l.text });
      continue;
    }
    if (l.stream === "stdout") {
      const last = out[out.length - 1];
      if (last?.type === "text") last.text += "\n" + l.text;
      else out.push({ type: "text", text: l.text });
      continue;
    }
    // system
    const head = l.text.trimStart();
    if (head.startsWith("→")) {
      const body = head.slice(1).trim();
      const sp = body.indexOf(" ");
      const name = sp < 0 ? body : body.slice(0, sp);
      const arg = sp < 0 ? "" : body.slice(sp + 1);
      let result: string | undefined;
      const next = lines[i + 1];
      if (next?.stream === "system" && next.text.trimStart().startsWith("←")) {
        result = next.text.trimStart().replace(/^←\s?/, "");
        i++;
      }
      out.push({ type: "tool", name, arg, result });
    } else if (head.startsWith("←")) {
      out.push({ type: "tool", name: "result", arg: "", result: head.replace(/^←\s?/, "") });
    } else if (head.startsWith("✓")) {
      out.push({ type: "note", text: head, tone: "text-emerald-400" });
    } else if (head.startsWith("✖")) {
      out.push({ type: "note", text: head, tone: "text-red-400" });
    } else if (head.startsWith("⚙")) {
      out.push({ type: "note", text: head, tone: "text-cyan-400" });
    } else if (head.startsWith("▶") || head.startsWith("cwd:") || head.startsWith("■")) {
      out.push({ type: "note", text: head, tone: "text-zinc-500" });
    } else {
      out.push({ type: "note", text: l.text, tone: "text-cyan-400" });
    }
  }
  return out;
}

function ToolEntry({ name, arg, result }: { name: string; arg: string; result?: string }) {
  const [open, setOpen] = useState(false);
  const hasDetail = Boolean(result && result.trim());
  const lang = hasDetail ? detailLang(name, arg, result!) : undefined;
  return (
    <div class="rounded-sm border border-zinc-800 bg-zinc-900/40">
      <button
        class={`flex w-full items-center gap-2 px-2 py-1 text-left ${hasDetail ? "cursor-pointer hover:bg-zinc-800/40" : "cursor-default"}`}
        disabled={!hasDetail}
        onClick={() => setOpen((o) => !o)}
      >
        <span class="shrink-0">{toolIcon(name)}</span>
        <span class="shrink-0 font-medium text-violet-300">{name}</span>
        {name === "Bash" && arg ? (
          <code class="truncate text-amber-300">{arg}</code>
        ) : (
          <span class="truncate text-zinc-400">{arg}</span>
        )}
        {hasDetail && <span class="ml-auto shrink-0 text-zinc-600">{open ? "▾" : "▸"}</span>}
      </button>
      {open && hasDetail && (
        <div class="border-t border-zinc-800 p-2">
          <Code code={result!} lang={lang} />
        </div>
      )}
    </div>
  );
}

/** Structured agent log: tool calls become collapsible rows with icons; prose renders as
 *  highlighted markdown. Replaces the old flat wall of coloured lines. */
export function AgentLog({ lines }: { lines: RunLine[] }) {
  const entries = useMemo(() => parse(lines), [lines]);
  return (
    <div class="flex flex-col gap-1.5 font-mono text-xs leading-relaxed">
      {entries.map((e, i) => {
        if (e.type === "tool") return <ToolEntry key={i} name={e.name} arg={e.arg} result={e.result} />;
        if (e.type === "stderr") return <div key={i} class="whitespace-pre-wrap break-words text-red-400">{e.text}</div>;
        if (e.type === "note") return <div key={i} class={`whitespace-pre-wrap break-words ${e.tone}`}>{e.text}</div>;
        return (
          <div key={i} class="text-zinc-100">
            <Markdown source={e.text} />
          </div>
        );
      })}
    </div>
  );
}
