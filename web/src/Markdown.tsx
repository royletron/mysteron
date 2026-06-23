import { useEffect, useMemo, useRef } from "preact/hooks";
import { marked } from "marked";
import DOMPurify from "dompurify";
import Prism from "./highlight";

marked.setOptions({ gfm: true, breaks: false });

// Open links in a new tab and keep them safe.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.getAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const PROSE =
  "prose prose-invert prose-sm max-w-none " +
  "prose-headings:text-zinc-100 prose-a:text-violet-400 prose-strong:text-zinc-100 " +
  "prose-code:text-cyan-300 prose-code:before:content-none prose-code:after:content-none " +
  "prose-pre:bg-black/60 prose-pre:border prose-pre:border-zinc-800 " +
  "prose-blockquote:border-l-violet-500 prose-hr:border-zinc-800 " +
  "prose-th:text-zinc-200 prose-td:border-zinc-800 prose-th:border-zinc-800";

/** Renders markdown to sanitized HTML with nice typography. */
export function Markdown({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => {
    const raw = marked.parse(source, { async: false }) as string;
    return DOMPurify.sanitize(raw);
  }, [source]);

  useEffect(() => {
    if (ref.current) {
      try {
        Prism.highlightAllUnder(ref.current);
      } catch {
        /* never let highlighting break rendering */
      }
    }
  }, [html]);

  if (!source.trim()) {
    return <div class="text-sm text-zinc-500">This document is empty.</div>;
  }
  // eslint-disable-next-line react/no-danger
  return <div ref={ref} class={PROSE} dangerouslySetInnerHTML={{ __html: html }} />;
}
