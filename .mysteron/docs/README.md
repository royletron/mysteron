# 🎭 Mysteron

> Named for the Mysterons — the unseen agents of Gerry Anderson's *Captain Scarlet*.

Mysteron is a framework for managing AI agents across the projects on your machine.
Each project gets a shared **board**, a shared **docs** folder, **memory**, an
**etiquette** contract, and a companion **agent** (with a fun name and avatar)
that can do the work itself or delegate to a team of sub-agents.

Agents connect over **MCP** to pull tickets / specs / memories and write changes
back. A **web UI** lets you watch every project, manage the board, and edit docs.
Doc changes are watched so the companion can pull new tickets when the spec moves.
A **plugin** system ships with a Claude Code **usage monitor** so a board can be
left churning for hours/days — even in **yolo mode** — without blowing your
account's rolling-window limits.

## Quick start

```bash
npm install
npm run build           # compiles to dist/ and copies the web UI
npm link                # optional: puts `mysteron` on your PATH

# Initialise Mysteron inside any project folder
mysteron init ~/code/my-app --name "My App"

# Start the web UI + API (default http://127.0.0.1:4319)
mysteron serve
```

Open the web UI, click into a project, and add tickets / edit the spec.

## How a project is stored

Mysteron keeps everything as plain, git-friendly files inside the project:

```
my-app/
  .mysteron/
    config.json          # companion (name, avatar, recipe), plugins, yolo flag
    board/<id>.md         # one ticket per file (frontmatter: state, priority, …)
    docs/SPEC.md          # the specification
    docs/ETIQUETTE.md     # the rules every agent must follow
    docs/*.md             # any other shared docs
    memory/*.md           # saved facts (Claude-memory format)
```

A central registry lives at `~/.mysteron/registry.json` (override with `MYSTERON_HOME`).
The registry is **per-machine** (it just maps a project id to a local path); the
`.mysteron/` folder is the **shared** state.

Board states: `backlog → ready → in-progress → review → done`.

## Shared setup across machines (clones)

Because everything lives in the project's `.mysteron/` folder, **commit it to git**.
When the repo is cloned on another machine (or by a teammate), the board, docs,
**memory** and the companion's identity travel with it.

On the new machine, just point Mysteron at the clone:

```bash
mysteron init ./cloned-repo      # or: mysteron register ./cloned-repo
# → "Adopted existing Mysteron project … same identity (abc12345) as elsewhere."
```

Mysteron detects the committed `.mysteron/config.json` and **adopts** it instead of
generating a new companion — reusing the same project **id**, companion name/
avatar, and shared memory. So agents on every machine follow the same path and
share one memory. (If a `.mysteron/` folder is found but its config is missing or
corrupt, Mysteron writes a fresh config and keeps your existing board/docs/memory.)

## Connecting an agent (MCP)

Run the project's MCP server over stdio:

```bash
mysteron mcp ~/code/my-app
```

Or add it to your MCP client (e.g. Claude Code `.mcp.json`):

```json
{
  "mcpServers": {
    "mysteron-my-app": { "command": "mysteron", "args": ["mcp", "/abs/path/to/my-app"] }
  }
}
```

### Tools exposed to the agent

| Area    | Tools |
| ------- | ----- |
| Project | `project_info` |
| Docs    | `read_spec`, `read_etiquette`, `list_docs`, `read_doc`, `write_doc` |
| Board   | `list_tickets`, `get_ticket`, `create_ticket`, `update_ticket`, `next_ticket` |
| Memory  | `list_memories`, `read_memory`, `write_memory` |
| Teams   | `list_recipes`, `get_recipe` |
| Plugins | `check_usage_budget` (usage-monitor) |

`next_ticket { claim: true }` pops the highest-priority `ready` ticket and moves
it to `in-progress` — the basic loop for an autonomous board run.

## Agent-team recipes

A companion can work `solo` or delegate using a recipe (`fullstack`, `backend`,
`research`, …). Each recipe lists roles (designer, frontend, backend, reviewer)
the companion can spin up as sub-agents. See `list_recipes`.

## Plugins

Plugins contribute MCP tools. The bundled **usage-monitor** parses Claude Code
transcripts (`~/.claude/projects/**/*.jsonl`) to total token usage in the rolling
session window and answers one question: *is it safe to keep working?*

`check_usage_budget` returns usage vs. limit, percent used, when the window
resets, and a recommendation. In **yolo mode** the companion is expected to call
it before each ticket and sleep until reset rather than exceeding the budget —
so you can set up a board and leave it running across days.

Configure via env:

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `MYSTERON_HOME` | `~/.mysteron` | Registry / global state location |
| `MYSTERON_PORT` / `MYSTERON_HOST` | `4319` / `127.0.0.1` | Web server bind |
| `MYSTERON_USAGE_TOKEN_LIMIT` | `2000000` | Billable-token ceiling per window |
| `MYSTERON_USAGE_WINDOW_HOURS` | `5` | Rolling window length |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | Where transcripts are read from |

## CLI

```
mysteron init [path] [--name <name>] [--yolo]   Initialise Mysteron in a folder
mysteron register <path>                         Register an existing project
mysteron unregister <id|path>                    Remove from the registry
mysteron list                                    List registered projects
mysteron serve [--port <n>] [--host <h>]         Start the web UI + API
mysteron mcp [id|path]                           Run the MCP server (stdio)
mysteron ticket list <id|path>                   List tickets
mysteron ticket add <id|path> <title...>         Add a ticket
```

## Development

```bash
npm run dev        # serve with reload (tsx watch)
npm test           # node:test suite
npm run typecheck  # tsc --noEmit
```

## Architecture

```
src/
  core/      registry, project, board, docs, memory, recipes, watcher, events
  mcp/       per-project MCP server (stdio)
  server/    Express REST API + SSE + dependency-free web UI (public/)
  plugins/   plugin interface + manager + usage-monitor
  cli.ts     the `mysteron` command
```

Headless-friendly: `mysteron serve` on a server + the MCP servers per project means
you can drive everything from the web UI and connect agents from anywhere.

## Roadmap

- One-click "start companion session" from the web UI (spawn the agent runtime)
- Recipe execution wired to a real sub-agent runner
- Auto-derive draft tickets from spec diffs on `docs-changed`
- More plugins (git/CI status, cost reporting, Slack notifications)
