import { useEffect, useRef } from "preact/hooks";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, drawSelection, highlightActiveLine } from "@codemirror/view";
import { history, defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { tags as t } from "@lezer/highlight";

// Token colours, tuned to match the app palette (violet accents, cyan code).
const highlight = HighlightStyle.define([
  { tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4], color: "#f4f4f5", fontWeight: "600" },
  { tag: t.strong, color: "#f4f4f5", fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "#a78bfa" },
  { tag: [t.monospace, t.literal], color: "#67e8f9" },
  { tag: t.quote, color: "#a1a1aa", fontStyle: "italic" },
  { tag: t.list, color: "#a78bfa" },
  { tag: t.contentSeparator, color: "#52525b" },
  // The markdown syntax markers themselves (#, *, `, >, -) stay quiet.
  { tag: [t.processingInstruction, t.meta], color: "#71717a" },
]);

// Chrome styling — transparent so it sits inside the existing zinc-950 panel.
const theme = EditorView.theme(
  {
    "&": { color: "#f4f4f5", backgroundColor: "transparent", fontSize: "12px" },
    "&.cm-focused": { outline: "none" },
    ".cm-content": {
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      lineHeight: "1.6",
      caretColor: "#a78bfa",
      padding: "8px 0",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#a78bfa" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
      backgroundColor: "#6d28d955",
    },
    ".cm-activeLine": { backgroundColor: "#ffffff08" },
    ".cm-scroller": { overflow: "auto" },
    ".cm-line": { padding: "0 8px" },
  },
  { dark: true },
);

export function CodeEditor({
  value,
  onChange,
  onSave,
  class: className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  onSave?: () => void;
  class?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>();
  // Keep the latest callbacks reachable without rebuilding the editor.
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    const saveKey = keymap.of([
      {
        key: "Mod-s",
        run: () => {
          onSaveRef.current?.();
          return true;
        },
      },
    ]);
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        drawSelection(),
        highlightActiveLine(),
        EditorView.lineWrapping,
        markdown({ codeLanguages: languages }),
        syntaxHighlighting(highlight),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        saveKey,
        theme,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current! });
    view.current = v;
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push external value changes (e.g. switching documents) into the editor.
  useEffect(() => {
    const v = view.current;
    if (v && value !== v.state.doc.toString()) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div ref={host} class={`overflow-auto ${className}`} />;
}
