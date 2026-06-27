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

Board states: `backlog → ready → in-progress → review → done`, plus `bin`
(a soft-delete holding area; `done` tickets are swept here automatically after
~48h). A ticket can also declare `blockedBy: [<id>, …]` — it waits in the queue
until each upstream ticket has landed in main (see _Ticket dependencies_ below).

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

`next_ticket { claim: true }` pops the highest-priority *unblocked* `ready`
ticket and moves it to `in-progress` — the basic loop for an autonomous board run.

## Running tickets — autopilot, guests & isolation

Beyond the manual MCP loop, Mysteron runs tickets for you:

- **Board autopilot (the yolo loop).** From the web UI you can start a project's
  autopilot: it polls the board, and for each free companion dispatches its next
  ready ticket to a Claude Code run, moving on as runs finish. It checks the
  usage budget first — when the host's Claude window is maxed it **pauses local
  runs** until the window resets (and keeps the board moving via guests, below).
  This is the "set up a board and leave it churning across days" mode.
- **Guest companions.** Another machine can offer itself as a guest worker
  (`mysteron join <host-url> --token …`, or from its own web UI). The host fans
  ready tickets out to idle guests, which run on their **own machine + Claude
  account** — so work continues even when the host is budget-maxed.
- **Worktree isolation.** A local run executes in a per-run `git worktree` taken
  off a snapshot of the working tree (host `node_modules` is symlinked in, or
  reinstalled when the lockfile changed), then its diff is landed back through the
  project's commit strategy. Guests do the equivalent over a snapshot tar + patch.
  So parallel companions never step on each other's edits, and local and guest
  runs commit through **one identical landing path**.

### Commit strategies

How completed work lands is configurable per project (`commit` in `config.json`),
resolved over the recipe's default: commit straight to `main`, to a named branch,
or a new branch per ticket (`mysteron/<id>`). The same resolved strategy drives
both the agent's prompt and the landing path, so every run commits the same way.

### Ticket dependencies

A ticket's `blockedBy` lists upstream tickets that must **land in main** (be
`done` and, if they produced a branch, merged) before it becomes runnable. The
autopilot and `next_ticket` skip blocked tickets, so a dependency chain pauses
itself in the queue until its prerequisites are satisfied.

## Agent-team recipes

A companion can work `solo` or delegate using a recipe (`fullstack`, `backend`,
`research`, …). Each recipe lists roles (designer, frontend, backend, reviewer)
the companion can spin up as sub-agents, and a default git strategy. See
`list_recipes`. (Note: recipes currently shape the lead companion's prompt and
git behaviour; spawning real role sub-agents is tracked as a `v2` ticket.)

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
mysteron init [path] [--name <name>] [--recipe <id>] [--yolo]   Initialise Mysteron in a folder
mysteron register <path>                         Register an existing project
mysteron unregister <id|path>                    Remove from the registry
mysteron list                                    List registered projects
mysteron serve [--port <n>] [--host <h>] [-v]    Start the web UI + API
mysteron mcp [id|path]                           Run the MCP server (stdio)
mysteron ticket list <id|path>                   List tickets
mysteron ticket add <id|path> <title...>         Add a ticket
mysteron join <host-url> --token <t> [--for 2h] [--name <label>]   Offer this machine as a guest worker
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
  core/      registry, project, board, docs, memory, companions, recipes, git, watcher, events
  mcp/       per-project MCP server (stdio)
  server/    Express REST API + WebSocket hub (+ /worker guest registry); serves the built web UI
  runner/    agent run manager (per-companion lock, sessions, worktree isolation, persistence) + autopilot
  worker/    guest-worker client (offer this machine to a host, run dispatched tickets)
  plugins/   plugin interface + manager + usage-monitor
  cli.ts     the `mysteron` command
web/         Preact + Vite + Tailwind web UI (builds to dist/server/public)
```

Headless-friendly: `mysteron serve` on a server + the MCP servers per project means
you can drive everything from the web UI and connect agents from anywhere.

## Roadmap

Shipped since the first cut: companions roster + avatars, per-companion autopilot,
persistent Claude sessions, guest workers, worktree isolation, commit strategies,
ticket dependencies. Open work (see the board — bigger reworks carry the `v2` label):

- Recipe teams: delegate to **real** sub-agents (today the lead companion owns the work)
- A sensible dispatch **queue/scheduler** + retry policy (attempt cap, backoff, dead-letter)
- Auto-derive draft tickets from spec diffs on `docs-changed`
- Atomic/serialized writes for the shared board/docs/memory
- More plugins (git/CI status, cost reporting, Slack notifications)
