# 🎭 Henson

> Named for Jim Henson — the best puppeteer that ever lived.

Henson is a framework for managing AI agents — **companions** — across the
projects on your machine. Each project gets a shared **board**, a shared **docs**
folder, **memory**, an **etiquette** contract, and a roster of named companions
(each with a role and a [boring-avatars](https://boringavatars.com) avatar) chosen
from a **recipe** — work it solo, or as a team (designer / frontend / backend /
reviewer …).

You assign a ticket to a companion and press ▶; the companion works it as its own
persistent Claude session, **one task at a time**. Companions connect over **MCP**
to pull tickets / specs / memories and write changes back; a **web UI** lets you
watch every project, manage the board, edit docs, and see what each companion is
doing live. Doc changes are watched so a companion can pull new tickets when the
spec moves. A **plugin** system ships with a Claude Code **usage monitor** so a
board can be left churning for hours/days — even in **yolo mode** — without
blowing your account's rolling-window limits.

## Quick start

```bash
npm install
npm run build           # builds the server (tsc) and the web UI (Vite) into dist/
npm link                # optional: puts `henson` on your PATH

# Initialise Henson inside any project folder (pick a team recipe; defaults to solo)
henson init ~/code/my-app --name "My App" --recipe fullstack

# Start the web UI + API (default http://127.0.0.1:4319)
henson serve
```

Open the web UI, click into a project, and add tickets / edit the spec.

## How a project is stored

Henson keeps everything as plain, git-friendly files inside the project:

```
my-app/
  .henson/
    config.json            # recipe, companions[] (id/name/role/avatar), plugins, yolo
    board/<id>.md          # one ticket per file (frontmatter: state, priority, companionId, …)
    docs/SPEC.md           # the specification
    docs/ETIQUETTE.md      # the rules every companion must follow
    docs/*.md              # any other shared docs
    companions/<id>.md     # each companion's editable role brief
    memory/*.md            # saved facts (Claude-memory format)
    runs/<runId>.json      # run metadata — committed (companion, hostname, status)
    runs/<runId>.log       # run output — gitignored, local to the machine that ran it
```

A central registry lives at `~/.henson/registry.json` (override with `HENSON_HOME`).
The registry is **per-machine** (it just maps a project id to a local path); the
`.henson/` folder is the **shared** state.

Board states: `backlog → ready → in-progress → review → done`.

## Companions

A **companion** is a first-class, named agent that lives with the project
(committed in `.henson/config.json`, so every machine agrees who's who).

- **Roster from a recipe.** `henson init --recipe <id>` (or the New Project
  dialog) picks a team. `solo` → one *soloist*; `fullstack` → *designer /
  frontend / backend / reviewer*; see `henson` recipes for the rest. Each role
  becomes a companion with a generated name and a boring-avatars avatar.
- **Role briefs.** Each companion gets a seeded, editable brief at
  `.henson/companions/<id>.md` (also surfaced over MCP) describing what its role
  does — edit it in the **Companion** tab.
- **Assignment.** Tickets carry a `companionId`; new tickets default to the
  soloist when there's one. Assign in the ticket panel.
- **One task at a time.** A companion runs a single ticket at once (key for
  staying inside token limits) — the ▶ button is disabled while it's busy.
- **Persistent session.** Each companion keeps one Claude session
  (`--session-id <companion-id>`) so it carries context across the tickets it
  works. (`HENSON_AGENT_SESSION=0` to opt out.)
- **See what they're doing.** The Companion tab shows each companion as idle or
  *● working: \<ticket\> → view live*.

## Shared setup across machines (clones)

Because everything lives in the project's `.henson/` folder, **commit it to git**.
When the repo is cloned on another machine (or by a teammate), the board, docs,
**memory** and the whole companion roster travel with it.

On the new machine, just point Henson at the clone:

```bash
henson init ./cloned-repo      # or: henson register ./cloned-repo
# → "Adopted existing Henson project … same identity (abc12345) as elsewhere."
```

Henson detects the committed `.henson/config.json` and **adopts** it instead of
generating new companions — reusing the same project **id** and the whole
companion roster (names, roles, avatars) plus shared memory. So companions on
every machine are the same people. (If a `.henson/` folder is found but its
config is missing or corrupt, Henson writes a fresh config and keeps your
existing board/docs/memory.)

**Runs are per-machine.** A run's metadata (which companion, on which `hostname`,
status) is committed so history travels with the repo, but its verbose **log is
local and gitignored**. In the UI you see full logs for runs on this machine and
a "🖥 ran by … on \<hostname\>" note for runs that happened elsewhere.

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

Each ticket on the board has a **▶ play button** (disabled while its companion is
busy with another ticket). Pressing it:

1. Moves the ticket to `in-progress`, claimed by its assigned companion.
2. Launches that companion in the project directory to work the ticket (the
   prompt includes the companion's role brief, the ticket, the etiquette, and a
   SPEC excerpt), in the companion's persistent Claude session.
3. Opens the ticket's **live view** in a new tab — a dedicated page
   (`#/project/<id>/ticket/<ticketId>`) that streams the agent's parsed output in
   real time **over a WebSocket**, with **Stop** / **Run again** controls and a
   history of past runs you can replay.

### What agent gets launched

By default Henson runs **Claude Code headless, streaming**, and attaches this
project's own MCP server so the companion can read docs/memory and move its
ticket to `review`:

```
claude -p "<prompt>" --output-format stream-json --verbose \
  --permission-mode acceptEdits \            # bypassPermissions when yolo is on
  --session-id <companion-id> \              # persistent per-companion session
  --mcp-config <henson> --strict-mcp-config \
  --allowedTools mcp__henson <…your allowed tools>
```

`--output-format stream-json` is what lets the live view show the agent's
thinking, tool calls, and result as they happen (plain `-p` would buffer until
the end). The agent runs with `cwd` set to the project, and these env vars are
exported: `HENSON_PROJECT`, `HENSON_PROJECT_PATH`, `HENSON_TICKET_ID`,
`HENSON_TICKET_TITLE`, `HENSON_TICKET_PROMPT`, `HENSON_YOLO`.

**Permissions.** With yolo off the companion runs in `acceptEdits` (can edit
files, can't run arbitrary commands headlessly); list extra tools it may use in
the **Companion → Permissions** editor (`--allowedTools` / `--disallowedTools`).
Yolo on uses `bypassPermissions` — every tool, no prompts.

Override the command to use any agent CLI (it receives the prompt on stdin as
well as in `HENSON_TICKET_PROMPT`):

```bash
export HENSON_AGENT_CMD='my-agent --task "$HENSON_TICKET_TITLE"'   # global
```

…or per-project in `.henson/config.json`:

```json
{ "agent": { "command": "my-agent", "args": ["--headless"] } }
```

Live output rides the project's single WebSocket (`/ws`); runs can be stopped via
`POST /api/runs/:runId/stop`. Each run persists committed metadata
(`.henson/runs/<runId>.json`) plus a gitignored local log (`<runId>.log`) and is
reloaded on startup, so a ticket's agent history survives a server restart and
syncs (metadata) across machines. A run left mid-flight by a killed server is
shown as `stopped` on reload.

## Board autopilot (the yolo autopilot)

The board has a **🤖 Start autopilot** control. Once started, Henson ticks and,
for each **free** companion, dispatches its next `ready` assigned ticket — so
companions work **in parallel, one task each** (the soloist also picks up
unassigned tickets). Before dispatching it checks the **usage budget** (the
usage-monitor plugin); when the budget is reached it **pauses** all companions,
waits for the rolling window to reset, then resumes — so a board can churn for
hours/days without exceeding your Claude account limits. It goes **idle** when no
free companion has work and keeps watching, so you can keep adding/assigning
tickets and it picks them up.

The board shows live status (`running / paused / idle`), how many companions are
working, completed-this-session, and a recent activity feed. Pair it with **yolo
mode** for hands-off, permission-free runs.

API: `POST /api/projects/:id/autopilot/start`, `…/stop`, `GET …/autopilot`.
Tune the loop timing with `HENSON_AUTOPILOT_IDLE_MS`, `HENSON_AUTOPILOT_BUDGET_MS`,
`HENSON_AUTOPILOT_BREATHER_MS`.

## Commits

Companions are told to stamp their commits with a trailer:

```
Henson-Companion: <companion name>
```

The **Commits** tab reads `git log` and attributes each commit to a companion via
that trailer — showing the companion's avatar next to its work (and falling back
to the git author otherwise).

## Agent-team recipes

A companion can work `solo` or delegate using a recipe (`fullstack`, `backend`,
`research`, …). Each recipe lists roles (designer, frontend, backend, reviewer)
the companion can spin up as sub-agents. See `list_recipes`.

A recipe defines the roster: choose it at `init`, or switch later from the
**Companion** tab (`PATCH /api/projects/:id/config { recipe }`), which rebuilds
the companions for the new roles. The recipe also sets **git behaviour**: most
keep small discrete commits on the current branch (`current-branch`) so
companions sharing one checkout don't litter it with branches, while `research`
cuts a throwaway `spike/` branch (`new-branch`). The strategy is woven into the
companion's prompt.

Don't like a companion's name? Hit **🎲** on its row in the Companion tab (`PATCH
/api/projects/:id/config { regenerateCompanionId }`) to roll a fresh name and
avatar — its id and Claude session are kept, so continuity isn't lost.

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
henson init [path] [--name <name>] [--recipe <id>] [--yolo] [--no-import]
                                               Initialise Henson in a folder
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

> **Running agents on Henson itself?** Use a non-watching server (`npm start` or
> `henson serve`), **not** `npm run dev`. `tsx watch` restarts the server whenever
> a `src/**` file changes — and a companion working a ticket in this repo edits
> `src/**`, which would restart the server and kill its own run. (For any *other*
> project this isn't an issue; the agent edits that project's files, not Henson's.)

## Architecture

```
src/
  core/      registry, project, board, docs, memory, companions, recipes, git, watcher, events
  mcp/       per-project MCP server (stdio)
  server/    Express REST API + WebSocket hub; serves the built web UI
  runner/    agent run manager (per-companion lock, sessions, run persistence) + board autopilot
  plugins/   plugin interface + manager + usage-monitor
  cli.ts     the `henson` command
web/         Preact + Vite + Tailwind web UI (builds to dist/server/public)
```

Live updates ride a single **WebSocket** per tab (separate from the HTTP/1.1
6-connections-per-origin pool, so many tabs/runs never starve REST calls).
Headless-friendly: `henson serve` on a server + per-project MCP means you can
drive everything from the web UI and connect companions from anywhere.

## Roadmap

- ~~Companions: roster from a recipe, boring avatars, role briefs~~ ✅
- ~~Assign tickets to companions; one task at a time; per-companion autopilot~~ ✅
- ~~Persistent per-companion Claude sessions~~ ✅
- ~~Committed run metadata + hostname; gitignored local logs~~ ✅
- ~~Commit attribution (`Henson-Companion` trailer) + commits view~~ ✅
- Recipe teams: delegate to real sub-agents (currently the lead companion owns the work)
- Condense/fork a companion's session when its context grows large
- Auto-derive draft tickets from spec diffs on `docs-changed`
- More plugins (git/CI status, cost reporting, Slack notifications)
