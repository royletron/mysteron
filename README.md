# 🎭 Henson

> Named for Jim Henson — the best puppeteer that ever lived.

Henson is a framework for managing AI agents across the projects on your machine.
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
npm run build           # builds the server (tsc) and the web UI (Vite) into dist/
npm link                # optional: puts `henson` on your PATH

# Initialise Henson inside any project folder
henson init ~/code/my-app --name "My App"

# Start the web UI + API (default http://127.0.0.1:4319)
henson serve
```

Open the web UI, click into a project, and add tickets / edit the spec.

## How a project is stored

Henson keeps everything as plain, git-friendly files inside the project:

```
my-app/
  .henson/
    config.json          # companion (name, avatar, recipe), plugins, yolo flag
    board/<id>.md         # one ticket per file (frontmatter: state, priority, …)
    docs/SPEC.md          # the specification
    docs/ETIQUETTE.md     # the rules every agent must follow
    docs/*.md             # any other shared docs
    memory/*.md           # saved facts (Claude-memory format)
    runs/<runId>.json     # agent-run history (local; gitignored by default)
```

A central registry lives at `~/.henson/registry.json` (override with `HENSON_HOME`).
The registry is **per-machine** (it just maps a project id to a local path); the
`.henson/` folder is the **shared** state.

Board states: `backlog → ready → in-progress → review → done`.

## Shared setup across machines (clones)

Because everything lives in the project's `.henson/` folder, **commit it to git**.
When the repo is cloned on another machine (or by a teammate), the board, docs,
**memory** and the companion's identity travel with it.

On the new machine, just point Henson at the clone:

```bash
henson init ./cloned-repo      # or: henson register ./cloned-repo
# → "Adopted existing Henson project … same identity (abc12345) as elsewhere."
```

Henson detects the committed `.henson/config.json` and **adopts** it instead of
generating a new companion — reusing the same project **id**, companion name/
avatar, and shared memory. So agents on every machine follow the same path and
share one memory. (If a `.henson/` folder is found but its config is missing or
corrupt, Henson writes a fresh config and keeps your existing board/docs/memory.)

## Connecting an agent (MCP)

Run the project's MCP server over stdio:

```bash
henson mcp ~/code/my-app
```

Or add it to your MCP client (e.g. Claude Code `.mcp.json`):

```json
{
  "mcpServers": {
    "henson-my-app": { "command": "henson", "args": ["mcp", "/abs/path/to/my-app"] }
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

## Running agents on tickets (the ▶ play button)

Each ticket on the board has a **▶ play button**. Pressing it:

1. Moves the ticket to `in-progress` and assigns it to the companion.
2. Launches an agent in the project directory to work the ticket (the prompt
   includes the ticket, the etiquette, and a SPEC excerpt).
3. Opens the ticket's **live view** in a new tab — a dedicated page
   (`#/project/<id>/ticket/<ticketId>`) that streams the agent's stdout/stderr
   in real time (via SSE), with **Stop** and **Run again** controls and a history
   of past runs you can replay.

### What agent gets launched

By default Henson runs **Claude Code headless**:

```
claude -p "<ticket prompt>" --permission-mode acceptEdits   # or bypassPermissions in yolo
```

The agent runs with `cwd` set to the project, and these env vars are exported:
`HENSON_PROJECT`, `HENSON_PROJECT_PATH`, `HENSON_TICKET_ID`, `HENSON_TICKET_TITLE`,
`HENSON_TICKET_PROMPT`, `HENSON_YOLO`.

Override the command to use any agent CLI (it receives the prompt on stdin as
well as in `HENSON_TICKET_PROMPT`):

```bash
export HENSON_AGENT_CMD='my-agent --task "$HENSON_TICKET_TITLE"'   # global
```

…or per-project in `.henson/config.json`:

```json
{ "agent": { "command": "my-agent", "args": ["--headless"] } }
```

Runs stream over `GET /api/runs/:runId/stream` and can be stopped via
`POST /api/runs/:runId/stop`. Each run is also **persisted** to
`.henson/runs/<runId>.json` (output included) and reloaded on startup, so a
ticket's agent history survives a server restart — the live view's run list lets
you replay any past run. A run left mid-flight by a killed server is shown as
`stopped` on reload.

> To have the agent update the ticket itself (move it to `review`, leave notes),
> give it this project's MCP server — see *Connecting an agent* above.

## Board autopilot (the yolo autopilot)

The board has a **🤖 Start autopilot** control. Once started, Henson:

1. Pulls the highest-priority `ready` ticket and runs an agent on it (claiming it
   to `in-progress`), waits for that run to finish, then pulls the next.
2. Before each ticket it checks the **usage budget** (the usage-monitor plugin).
   When the budget is reached it **pauses**, waits for the rolling window to
   reset, and then resumes — so a board can churn for hours/days without
   exceeding your Claude account limits.
3. Goes **idle** when there are no `ready` tickets and keeps watching, so you can
   keep adding tickets and it picks them up.

The board shows live status (`running / paused / idle`), the current ticket (with
a "view live →" link to its log), tickets completed this session, and a recent
activity feed. Pair it with **yolo mode** (`henson init --yolo`) for hands-off,
permission-free runs.

API: `POST /api/projects/:id/autopilot/start`, `…/stop`, `GET …/autopilot`.
Tune the loop timing with `HENSON_AUTOPILOT_IDLE_MS`, `HENSON_AUTOPILOT_BUDGET_MS`,
`HENSON_AUTOPILOT_BREATHER_MS`.

## Agent-team recipes

A companion can work `solo` or delegate using a recipe (`fullstack`, `backend`,
`research`, …). Each recipe lists roles (designer, frontend, backend, reviewer)
the companion can spin up as sub-agents. See `list_recipes`.

Toggle the companion onto a recipe from the **Companion** tab (or `PATCH
/api/projects/:id/config { recipe }`). The chosen recipe also sets **git
behaviour**: most recipes keep small discrete commits on the current branch
(`current-branch`) so agents sharing one checkout don't litter it with branches,
while `research` cuts a throwaway `spike/` branch (`new-branch`). The strategy is
woven into the agent's prompt.

Don't like the companion you were dealt? Hit **🎲 Regenerate** on the Companion
tab (or `PATCH /api/projects/:id/config { regenerateCompanion: true }`) to roll a
fresh fun name and avatar. The recipe and other settings are kept.

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
| `HENSON_HOME` | `~/.henson` | Registry / global state location |
| `HENSON_PORT` / `HENSON_HOST` | `4319` / `127.0.0.1` | Web server bind |
| `HENSON_USAGE_TOKEN_LIMIT` | `2000000` | Billable-token ceiling per window |
| `HENSON_USAGE_WINDOW_HOURS` | `5` | Rolling window length |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | Where transcripts are read from |

## CLI

```
henson init [path] [--name <name>] [--yolo]   Initialise Henson in a folder
henson register <path>                         Register an existing project
henson unregister <id|path>                    Remove from the registry
henson list                                    List registered projects
henson serve [--port <n>] [--host <h>] [-v]    Start the web UI + API (-v/--verbose for request/run logs)
henson mcp [id|path]                           Run the MCP server (stdio)
henson ticket list <id|path>                   List tickets
henson ticket add <id|path> <title...>         Add a ticket
```

## Development

```bash
npm run dev        # API (tsx watch :4319) + web UI (Vite HMR :5319) together
npm start          # clean build, then serve the built app on :4319
npm test           # node:test suite
npm run typecheck  # tsc --noEmit for server + web
npm run build      # rm -rf dist → tsc (server) → vite (web → dist/server/public)
```

For UI work, run `npm run dev` (one command runs both servers via `concurrently`)
and open `http://localhost:5319` — Vite HMR proxies `/api` to the API server. For
a production-style run, `npm start` (always a fresh build) or `npm run build`
then `henson serve`. The server sends `Cache-Control: no-cache` on `index.html`,
so a rebuild is always picked up without a hard refresh.

## Architecture

```
src/
  core/      registry, project, board, docs, memory, recipes, watcher, events
  mcp/       per-project MCP server (stdio)
  server/    Express REST API + SSE; serves the built web UI
  runner/    agent run manager + board autopilot
  plugins/   plugin interface + manager + usage-monitor
  cli.ts     the `henson` command
web/         Preact + Vite + Tailwind web UI (builds to dist/server/public)
```

Headless-friendly: `henson serve` on a server + the MCP servers per project means
you can drive everything from the web UI and connect agents from anywhere.

## Roadmap

- ~~Start an agent on a ticket from the web UI with a live view~~ ✅
- ~~A board-level "play" that pulls `ready` tickets one-by-one (yolo autopilot)~~ ✅
- Recipe execution wired to a real sub-agent runner (teams, not just solo)
- ~~Persist run history to disk so it survives restarts~~ ✅
- Persist autopilot session history to disk (still in-memory per server process)
- Auto-derive draft tickets from spec diffs on `docs-changed`
- More plugins (git/CI status, cost reporting, Slack notifications)
