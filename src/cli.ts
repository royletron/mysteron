#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import {
  createTicket,
  findEntry,
  listTickets,
  loadProjectConfig,
  loadRegistry,
  unregisterProject,
  type ProjectConfig,
} from "./core/index.js";
import { initProject } from "./core/project.js";
import { registerProject } from "./core/registry.js";
import { startStdioMcp } from "./mcp/server.js";
import { serve } from "./server/index.js";
import { joinHost } from "./worker/guest.js";
import { parseDuration } from "./core/worker-protocol.js";

type Flags = Record<string, string | boolean>;

/** Short, human-readable companion roster: "Kermit (soloist), Gonzo (backend)". */
function roster(config: ProjectConfig): string {
  return config.companions.map((c) => `${c.name} (${c.role})`).join(", ") || "(none)";
}

function parseArgs(argv: string[]): { positionals: string[]; flags: Flags } {
  const positionals: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a)) {
      // Short boolean flag(s), e.g. -v.
      for (const ch of a.slice(1)) flags[ch] = true;
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

const HELP = `🎭  Mysteron — manage AI agents across your projects.

Usage:
  mysteron init [path] [--name <name>] [--yolo] [--no-import]
                                                 Initialise Mysteron in a project folder
                                                 (imports existing docs unless --no-import)
  mysteron register <path>                         Register an existing Mysteron project
  mysteron unregister <id|path>                    Remove a project from the registry
  mysteron list                                    List registered projects
  mysteron serve [--port <n>] [--host <h>] [-v|--verbose]
                                                 Start the web UI + API (verbose logs requests/errors/runs)
  mysteron mcp [id|path]                           Run the MCP server (stdio) for a project
  mysteron ticket list <id|path>                   List a project's tickets
  mysteron ticket add <id|path> <title...>         Add a ticket (to backlog)
  mysteron join <host-url> --token <t> [--for 2h] [--name <label>] [--capacity 1]
                                                 Offer this machine as a guest worker to a host
  mysteron help                                    Show this help
`;

async function resolveRoot(idOrPath?: string): Promise<string> {
  const target = idOrPath ?? process.cwd();
  const entry = await findEntry(target);
  if (entry) return entry.path;
  return path.resolve(target);
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  const { positionals, flags } = parseArgs(rest);

  switch (cmd) {
    case "init": {
      const { config, importedDocs, adopted, repaired } = await initProject(
        positionals[0] ?? process.cwd(),
        {
          name: typeof flags.name === "string" ? flags.name : undefined,
          yolo: Boolean(flags.yolo),
          recipe: typeof flags.recipe === "string" ? flags.recipe : undefined,
          importDocs: flags["no-import"] ? false : undefined,
        },
      );
      if (adopted) {
        console.log(`Adopted existing Mysteron project "${config.name}" (recipe: ${config.recipe}).`);
        console.log(`  Companions: ${roster(config)}`);
        console.log(
          `  Shared board, docs and memory from .mysteron/ are reused — same identity (${config.id}) as elsewhere.`,
        );
        console.log(`  Registered on this machine. Run "mysteron serve" to view it.`);
        break;
      }
      console.log(`${repaired ? "Repaired" : "Initialised"} "${config.name}" (recipe: ${config.recipe})`);
      console.log(`  Companions: ${roster(config)}`);
      if (repaired) {
        console.log(`  (found a .mysteron/ folder without a config — wrote a new one, kept existing board/docs/memory)`);
      }
      console.log(`  plugins: ${config.plugins.join(", ") || "(none)"}  yolo: ${config.yolo}`);
      if (importedDocs.length) {
        console.log(`  imported ${importedDocs.length} existing doc(s):`);
        for (const d of importedDocs) {
          console.log(`    ${d.from} → docs/${d.importName}${d.kind === "spec" ? "  (used as SPEC)" : ""}`);
        }
      }
      console.log(`Run "mysteron serve" then open the web UI to manage the board.`);
      break;
    }
    case "register": {
      if (!positionals[0]) throw new Error("register requires a <path>");
      const abs = path.resolve(positionals[0]);
      const cfg = await loadProjectConfig(abs);
      const name = cfg?.name ?? path.basename(abs);
      const entry = await registerProject(abs, name, cfg?.id);
      if (cfg) {
        console.log(`Adopted ${entry.name} [${entry.id}] -> ${entry.path}\n  Companions: ${roster(cfg)}`);
      } else {
        console.log(
          `Registered ${entry.name} [${entry.id}] -> ${entry.path}\n  Note: no .mysteron/config.json here — run "mysteron init ${positionals[0]}" to set it up.`,
        );
      }
      break;
    }
    case "unregister": {
      if (!positionals[0]) throw new Error("unregister requires an <id|path>");
      const ok = await unregisterProject(positionals[0]);
      console.log(ok ? "Unregistered." : "Nothing matched.");
      break;
    }
    case "list": {
      const reg = await loadRegistry();
      if (reg.projects.length === 0) {
        console.log("No projects registered. Try: mysteron init");
        break;
      }
      for (const p of reg.projects) {
        const cfg = await loadProjectConfig(p.path);
        const comp = cfg ? roster(cfg) : "(uninitialised)";
        console.log(`🎭  ${p.name}  [${p.id}]  ${comp}\n    ${p.path}`);
      }
      break;
    }
    case "serve": {
      await serve({
        port: typeof flags.port === "string" ? Number(flags.port) : undefined,
        host: typeof flags.host === "string" ? flags.host : undefined,
        verbose: Boolean(flags.verbose || flags.v),
      });
      break;
    }
    case "mcp": {
      // Important: no stdout noise — stdio is the MCP transport.
      const root = await resolveRoot(positionals[0]);
      await startStdioMcp(root);
      break;
    }
    case "join": {
      if (!positionals[0]) throw new Error("join requires a host URL, e.g. mysteron join https://host --token <t>");
      await joinHost({
        hostUrl: positionals[0],
        token: typeof flags.token === "string" ? flags.token : undefined,
        label: typeof flags.name === "string" ? flags.name : undefined,
        forMs: typeof flags.for === "string" ? parseDuration(flags.for) : undefined,
        capacity: typeof flags.capacity === "string" ? Number(flags.capacity) : undefined,
      });
      break;
    }
    case "ticket": {
      const sub = positionals[0];
      const root = await resolveRoot(positionals[1]);
      if (sub === "list") {
        const tickets = await listTickets(root);
        for (const t of tickets) {
          console.log(`[${t.state}] ${t.title}  (${t.priority})  ${t.id}`);
        }
        if (tickets.length === 0) console.log("(no tickets)");
      } else if (sub === "add") {
        const title = positionals.slice(2).join(" ");
        if (!title) throw new Error('ticket add requires a title');
        const t = await createTicket(root, { title });
        console.log(`Added ticket ${t.id}: ${t.title}`);
      } else {
        console.log("Usage: mysteron ticket <list|add> <id|path> [title...]");
      }
      break;
    }
    case "help":
    case undefined:
    case "--help":
    case "-h":
      console.log(HELP);
      break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`mysteron: ${(err as Error).message}`);
  process.exitCode = 1;
});
