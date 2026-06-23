import Prism from "prismjs";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-json";
import "prismjs/components/prism-python";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-diff";
import "prismjs/components/prism-markdown";

const ALIAS: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  py: "python",
  md: "markdown",
  html: "markup",
  xml: "markup",
  patch: "diff",
};

/** Map a file extension or fence tag to a Prism language id, if we support it. */
export function langId(hint?: string): string | undefined {
  if (!hint) return undefined;
  const id = ALIAS[hint] ?? hint;
  return Prism.languages[id] ? id : undefined;
}

export default Prism;
