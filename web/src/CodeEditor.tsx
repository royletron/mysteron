import { useRef } from "preact/hooks";

/**
 * A plain, robust controlled textarea editor. (We previously embedded CodeMirror
 * here for syntax highlighting, but its imperative DOM + per-keystroke re-renders
 * deadlocked the tab. A textarea can't loop, and the Docs tab still renders a live
 * markdown preview alongside it.) Same props as before, so call sites are unchanged.
 */
export function CodeEditor({
  value,
  onChange,
  onSave,
  readOnly = false,
  placeholder,
  class: className = "",
}: {
  value: string;
  onChange?: (value: string) => void;
  onSave?: () => void;
  language?: "markdown" | "text";
  readOnly?: boolean;
  placeholder?: string;
  class?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      onSave?.();
      return;
    }
    // Tab inserts two spaces rather than moving focus.
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      const ta = ref.current!;
      const { selectionStart: s, selectionEnd: en } = ta;
      const next = value.slice(0, s) + "  " + value.slice(en);
      onChange?.(next);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = s + 2;
      });
    }
  };

  return (
    <textarea
      ref={ref}
      class={`font-mono text-xs leading-relaxed ${className}`}
      value={value}
      readOnly={readOnly}
      placeholder={placeholder}
      spellcheck={false}
      onInput={(e) => onChange?.((e.target as HTMLTextAreaElement).value)}
      onKeyDown={onKeyDown}
    />
  );
}
