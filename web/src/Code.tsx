import { useMemo } from "preact/hooks";
import Prism, { langId } from "./highlight";

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}

/** A syntax-highlighted code block. Falls back to escaped plain text for unknown languages. */
export function Code({ code, lang, class: className = "" }: { code: string; lang?: string; class?: string }) {
  const id = langId(lang);
  const html = useMemo(
    () => (id ? Prism.highlight(code, Prism.languages[id], id) : escapeHtml(code)),
    [code, id],
  );
  return (
    <pre
      class={`code-hl overflow-x-auto whitespace-pre-wrap break-words rounded-sm bg-black/50 p-2 font-mono text-xs leading-relaxed ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
