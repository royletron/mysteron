import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline/promises";
import { mysteronHome } from "./core/paths.js";
import { findEntry } from "./core/registry.js";
import { loadProjectConfig } from "./core/project.js";

const exec = promisify(execFile);
const DAY_MS = 24 * 60 * 60 * 1000;
const stampPath = () => path.join(mysteronHome(), ".mcp-nag");

/**
 * Once a day, if the Mysteron MCP isn't registered with Claude Code, offer to add
 * it (user scope) so the operator's interactive Claude sessions get this project's
 * board / docs / memory tools. Best-effort and quiet: no-op off a TTY, when opted
 * out (MYSTERON_MCP_NAG=0), within the 24h window, when there's no Mysteron project
 * at the cwd, or when the `claude` CLI isn't installed. Never throws — a nag must
 * never break the command the user actually ran. Skip entirely for `mysteron mcp`
 * (its stdio IS the MCP transport, so any prompt would corrupt it).
 */
export async function maybeOfferMcpInstall(): Promise<void> {
  try {
    if (process.env.MYSTERON_MCP_NAG === "0") return;
    if (!process.stdin.isTTY || !process.stdout.isTTY) return;
    if (await throttled()) return;

    // Only offer when the cwd is a real Mysteron project (so we register a board
    // that actually exists).
    const root = (await findEntry(process.cwd()).catch(() => undefined))?.path ?? process.cwd();
    if (!(await loadProjectConfig(root))) return;

    const state = await mcpState();
    if (state === "no-claude") return; // no Claude Code → nothing to install into
    await stampNow(); // we checked today — don't re-nag for 24h regardless of outcome
    if (state === "present") return;

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (
      await rl.question(
        "\nClaude Code doesn't have Mysteron's MCP registered, so interactive Claude\n" +
          "sessions can't see this project's board. Register it now (user scope)? [Y/n] ",
      )
    )
      .trim()
      .toLowerCase();
    rl.close();

    if (answer && answer !== "y" && answer !== "yes") {
      console.log(`Skipped. Add it later:  claude mcp add -s user mysteron -- mysteron mcp ${root}`);
      console.log("(set MYSTERON_MCP_NAG=0 to stop asking)");
      return;
    }

    await exec("claude", ["mcp", "add", "-s", "user", "mysteron", "--", "mysteron", "mcp", root]);
    console.log("✓ Registered Mysteron's MCP with Claude Code (user scope).");
  } catch (err) {
    if (process.env.MYSTERON_VERBOSE) console.error(`[mysteron] MCP install offer skipped: ${(err as Error).message}`);
  }
}

async function throttled(): Promise<boolean> {
  try {
    const last = Number((await fs.readFile(stampPath(), "utf8")).trim());
    return Number.isFinite(last) && Date.now() - last < DAY_MS;
  } catch {
    return false;
  }
}

async function stampNow(): Promise<void> {
  await fs.mkdir(mysteronHome(), { recursive: true });
  await fs.writeFile(stampPath(), String(Date.now()), "utf8");
}

/** Is the `mysteron` MCP registered with Claude Code? `get` exits non-zero if absent. */
async function mcpState(): Promise<"present" | "absent" | "no-claude"> {
  try {
    await exec("claude", ["mcp", "get", "mysteron"], { timeout: 8000 });
    return "present";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "no-claude" : "absent";
  }
}
