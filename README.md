# 👁 Mysteron

> ***This is the voice of the Mysterons.*** *We know that you can hear us,
> Earthman. Your projects are known to us. Our agents move among them — unseen,
> tireless, working while you sleep.*

> Named for the Mysterons — the unseen agents of Gerry Anderson's *Captain Scarlet*.

Mysteron is a framework for commanding AI agents — **companions** — across the
projects on your machine. Each project gets a shared **board**, a shared **docs**
folder, **memory**, an **etiquette** contract, and a roster of named companions
(each with a role and a [boring-avatars](https://boringavatars.com) avatar) chosen
from a **recipe** — work it solo, or as a team (designer / frontend / backend /
reviewer …).

You name a target, and the companions are dispatched. They work autonomously,
one task at a time, and report back. You need not watch them — but you can.

You assign a ticket to a companion and press ▶; the companion works it as its own
persistent Claude session, **one task at a time**. Companions connect over **MCP**
to pull tickets / specs / memories and write changes back; a **web UI** lets you
watch every project, manage the board, edit docs, and see what each companion is
doing live. Doc changes are watched so a companion can pull new tickets when the
spec moves. A **plugin** system ships with a Claude Code **usage monitor** so a
board can be left churning for hours/days — even in **yolo mode** — without
blowing your account's rolling-window limits. A trusted peer can even offer their
own machine + Claude account as a **guest companion**, fanning the board's work
out across accounts (see [Guest companions](#guest-companions-lend-a-machine--claude-account)).
The whole UI can be put behind an optional **password**.

## Quick start

Mysteron isn't published to npm yet — clone the repo and link it.

```bash
# 1. Clone and enter the repo
git clone <repo-url> mysteron
cd mysteron

# 2. Install dependencies (Node ≥ 20)
npm install

# 3. Build the server (tsc) and the web UI (Vite) into dist/
npm run build

# 4. Put `mysteron` on your PATH (symlinks this checkout's bin)
npm link
```

Now run the server:

```bash
# Start the web UI + API — defaults to http://127.0.0.1:4319
mysteron serve

# Bind elsewhere with --host / --port (or MYSTERON_HOST / MYSTERON_PORT):
mysteron serve --port 8080                 # different port, still localhost
mysteron serve --host 0.0.0.0 --port 8080  # expose on your network/LAN
mysteron serve -v                          # verbose: log requests + agent runs
```

> `--host 0.0.0.0` makes the UI reachable from other machines — only do this on a
> network you trust (there's no auth).

Finally, initialise Mysteron inside a project (run from anywhere):

```bash
# Pick a team recipe; defaults to `solo`. --name defaults to the folder name.
mysteron init ~/code/my-app --name "My App" --recipe fullstack

mysteron list                              # see registered projects
```

Open the web UI, click into the project, and add tickets / edit the spec. Already
have a clone with a committed `.mysteron/` folder? `mysteron init` (or `mysteron
register`) **adopts** it — see [Shared setup across machines](#shared-setup-across-machines-clones).

> **Rebuilding after a `git pull`:** `npm run build` again (or `npm start`, which
> builds then serves). For day-to-day UI/server hacking use `npm run dev` — see
> [Development](#development).

## How a project is stored

Mysteron keeps everything as plain, git-friendly files inside the project:

```
my-app/
  .mysteron/
    config.json            # recipe, companions[] (id/name/role/avatar), plugins, yolo
    board/<id>.md          # one ticket per file (frontmatter: state, priority, companionId, …)
    docs/SPEC.md           # the specification
    docs/ETIQUETTE.md      # the rules every companion must follow
    docs/*.md              # any other shared docs
    companions/<id>.md     # each companion's editable role brief
    memory/**/*.md         # shared context, mirroring the src tree (Claude-memory format)
    runs/<runId>.json      # run metadata — committed (companion, hostname, status)
    runs/<runId>.log       # run output — gitignored, local to the machine that ran it
```

A central registry lives at `~/.mysteron/registry.json` (override with `MYSTERON_HOME`).
The registry is **per-machine** (it just maps a project id to a local path); the
`.mysteron/` folder is the **shared** state.

Board states: `backlog → ready → in-progress → review → done`, plus `bin` — a
soft-delete holding area that `done` tickets are swept into automatically after
~48h.

**Ticket dependencies.** A ticket can declare `blockedBy: [<id>, …]` in its
frontmatter. It stays out of the runnable queue until every upstream ticket has
**landed in main** (is `done` and, if it produced a branch, merged) — so
`next_ticket` and the autopilot skip it and a dependency chain paces itself. The
inverse ("blocks") is derived and shown in the UI.

## Companions

A **companion** is a first-class, named agent that lives with the project
(committed in `.mysteron/config.json`, so every machine agrees who's who).

- **Roster from a recipe.** `mysteron init --recipe <id>` (or the New Project
  dialog) picks a team. `solo` → one *soloist*; `fullstack` → *designer /
  frontend / backend / reviewer*; see `mysteron` recipes for the rest. Each role
  becomes a companion with a generated name and a boring-avatars avatar.
- **Role briefs.** Each companion gets a seeded, editable brief at
  `.mysteron/companions/<id>.md` (also surfaced over MCP) describing what its role
  does — edit it in the **Companion** tab.
- **Assignment.** Tickets carry a `companionId`; new tickets default to the
  soloist when there's one. Assign in the ticket panel.
- **One task at a time.** A companion runs a single ticket at once (key for
  staying inside token limits) — the ▶ button is disabled while it's busy.
- **Persistent session.** Each companion keeps one Claude session
  (`--session-id <companion-id>`) so it carries context across the tickets it
  works. (`MYSTERON_AGENT_SESSION=0` to opt out.)
- **See what they're doing.** The Companion tab shows each companion as idle or
  *● working: \<ticket\> → view live*.

## Shared setup across machines (clones)

Because everything lives in the project's `.mysteron/` folder, **commit it to git**.
When the repo is cloned on another machine (or by a teammate), the board, docs,
**memory** and the whole companion roster travel with it.

On the new machine, just point Mysteron at the clone:

```bash
mysteron init ./cloned-repo      # or: mysteron register ./cloned-repo
# → "Adopted existing Mysteron project … same identity (abc12345) as elsewhere."
```

Mysteron detects the committed `.mysteron/config.json` and **adopts** it instead of
generating new companions — reusing the same project **id** and the whole
companion roster (names, roles, avatars) plus shared memory. So companions on
every machine are the same people. (If a `.mysteron/` folder is found but its
config is missing or corrupt, Mysteron writes a fresh config and keeps your
existing board/docs/memory.)

**Runs are per-machine.** A run's metadata (which companion, on which `hostname`,
status) is committed so history travels with the repo, but its verbose **log is
local and gitignored**. In the UI you see full logs for runs on this machine and
a "🖥 ran by … on \<hostname\>" note for runs that happened elsewhere.

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

By default Mysteron runs **Claude Code headless, streaming**, and attaches this
project's own MCP server so the companion can read docs/memory and move its
ticket to `review`:

```
claude -p "<prompt>" --output-format stream-json --verbose \
  --permission-mode acceptEdits \            # bypassPermissions when yolo is on
  --session-id <companion-id> \              # persistent per-companion session
  --mcp-config <mysteron> --strict-mcp-config \
  --allowedTools mcp__mysteron <…your allowed tools>
```

`--output-format stream-json` is what lets the live view show the agent's
thinking, tool calls, and result as they happen (plain `-p` would buffer until
the end). The agent runs with `cwd` set to the project, and these env vars are
exported: `MYSTERON_PROJECT`, `MYSTERON_PROJECT_PATH`, `MYSTERON_TICKET_ID`,
`MYSTERON_TICKET_TITLE`, `MYSTERON_TICKET_PROMPT`, `MYSTERON_YOLO`.

**Permissions.** With yolo off the companion runs in `acceptEdits` (can edit
files, can't run arbitrary commands headlessly); list extra tools it may use in
the **Companion → Permissions** editor (`--allowedTools` / `--disallowedTools`).
Yolo on uses `bypassPermissions` — every tool, no prompts.

Override the command to use any agent CLI (it receives the prompt on stdin as
well as in `MYSTERON_TICKET_PROMPT`):

```bash
export MYSTERON_AGENT_CMD='my-agent --task "$MYSTERON_TICKET_TITLE"'   # global
```

…or per-project in `.mysteron/config.json`:

```json
{ "agent": { "command": "my-agent", "args": ["--headless"] } }
```

Live output rides the project's single WebSocket (`/ws`); runs can be stopped via
`POST /api/runs/:runId/stop`. Each run persists committed metadata
(`.mysteron/runs/<runId>.json`) plus a gitignored local log (`<runId>.log`) and is
reloaded on startup, so a ticket's agent history survives a server restart and
syncs (metadata) across machines. A run left mid-flight by a killed server is
shown as `stopped` on reload.

## Board autopilot (the yolo autopilot)

The board has a **🤖 Start autopilot** control. Once started, Mysteron ticks and,
for each **free** companion, dispatches its next `ready` assigned ticket — so
companions work **in parallel, one task each** (the soloist also picks up
unassigned tickets). Before dispatching it checks the **usage budget** (the
usage-monitor plugin); when the budget is reached it **pauses** local companions,
waits for the rolling window to reset, then resumes — so a board can churn for
hours/days without exceeding your Claude account limits. While paused, any
connected **guest companions** keep working (on their own accounts) and absorb
ready tickets — including ones assigned to local companions — so the board keeps
moving instead of fully stalling (see [Guest companions](#guest-companions-lend-a-machine--claude-account)).
It goes **idle** when no free companion has work and keeps watching, so you can
keep adding/assigning tickets and it picks them up.

The board shows live status (`running / paused / idle`), how many companions are
working, completed-this-session, and a recent activity feed. Pair it with **yolo
mode** for hands-off, permission-free runs.

API: `POST /api/projects/:id/autopilot/start`, `…/stop`, `GET …/autopilot`.
Tune the loop timing with `MYSTERON_AUTOPILOT_IDLE_MS`, `MYSTERON_AUTOPILOT_BUDGET_MS`,
`MYSTERON_AUTOPILOT_BREATHER_MS`.

## Guest companions (lend a machine + Claude account)

A **guest** can offer their own machine and Claude account to a host for a while,
so the board's work **fans out across machines** — each guest runs tickets on
its own account and quota. Think CI self-hosted runners: the **host** is the
public coordinator (owns the board + repo); **guests** dial in from anywhere
(they don't need to be reachable).

> ⚠ **Trust.** A guest runs the host's tickets — i.e. arbitrary agent-driven
> code — on their own machine, against their own Claude account. Only invite
> people you trust, and only offer to hosts you trust. Offers are time-boxed and
> withdrawable, and the guest can keep yolo off / restrict tools. There's no
> sandbox yet — treat it like pairing on a shared checkout.

**How it works**

1. **Host** mints a guest **join token** in **Settings → Guest companions** and
   shares the one-line command it shows.
2. **Guest** offers their machine, either from the CLI or their own web app:
   ```bash
   mysteron join https://host:4319 --token <token> --for 2h [--name laptop] [--capacity 1]
   ```
   …or in their running Mysteron, **Settings → Offer this machine to a host**
   (host URL + token + duration). Either way the guest dials the host over a
   WebSocket, registers a time-boxed offer, and heartbeats until it expires or is
   withdrawn. The guest can watch the host's board read-only from that page.
3. When the **autopilot** runs, it hands **unassigned ready** tickets to idle
   guests (one each) — and does so **even when the host's own usage budget is
   spent**, since guests run on their own accounts. Local companions keep doing
   their assigned work as usual. **When the host's budget is maxed out**, guests
   also take **companion-assigned** tickets (the host can't run them anyway), and
   the **▶ play** button on a ticket **auto-offloads** to an idle guest instead of
   running locally — if no guest is free it blocks with a clear message rather
   than burning a run against the rate limit.
4. For each dispatched ticket: the host **pins a snapshot** of its full working
   tree — tracked files (incl. uncommitted edits) **and untracked-but-not-ignored
   files**, so the guest doesn't run against source the host hasn't committed yet;
   no shared git remote needed — and sends it with the composed prompt. The guest
   runs Claude locally — pointed at the host's **live MCP over HTTP** (token-gated,
   scoped to the run's project) so it sees the real board too — streams its output
   back to the host's live view, then returns a `git diff` of the result.
5. The host **lands that patch the way a local run would** under the project's
   git strategy: **current-branch** recipes fast-forward the checked-out branch
   onto the guest's commit (so it lands in your working tree) when that tree is
   clean; **new-branch** recipes — or a current-branch fallback when the tree is
   dirty or can't fast-forward — commit it to a dedicated `<prefix><ticket>`
   branch surfaced in the UI for a `git merge`. The commit is built in a throwaway
   worktree and applied with `git apply --3way` (against the pinned snapshot), so
   it merges cleanly even if the host moved on since dispatch. The returned diff
   is **always saved to `.git/mysteron-patches/`** first, so a failed apply leaves
   the work recoverable rather than lost. Landed work moves the ticket to
   **review**; an empty/failed result returns it to **ready**.

Connected guests appear live in the host's **Settings** and as a count next to
the header's live dot (click it for per-guest detail). Guest runs are clearly
**marked as running on another computer** — a ☁ badge on the board card, in the
ticket's live view, and in the run list — and the host **terminal** shows an
animated line while guests are working on its behalf, plus a one-liner as each
finishes. When a guest's work lands on a dedicated branch, that branch is shown
as a ⎇ chip on the run, and the project's **Branches** tab lists every open
branch PR-style (companion, ahead/behind, files changed) with one-click **Merge**
(no-ff into the checked-out branch; refuses on a dirty tree, aborts cleanly on
conflict) and **Delete**.

Endpoints: host `GET /api/workers`, `POST/DELETE /api/settings/guest` (token);
guest `GET/POST/DELETE /api/guest` (offer) and `GET /api/guest/board` (host board
proxy). The guest connection rides `/worker`; the working-tree snapshot is served
at `/api/worker/snapshot/:runId` (guest-token gated).

## Commits

Companions are told to stamp their commits with a trailer:

```
Mysteron-Companion: <companion name>
```

The **Commits** tab reads `git log` and attributes each commit to a companion via
that trailer — showing the companion's avatar next to its work (and falling back
to the git author otherwise).

**Commit strategy.** Where completed work lands is configurable per project
(`commit` in `config.json`), resolved over the recipe's git default: straight to
`main`, to a named branch, or a new branch per ticket (`mysteron/<id>`). The same
resolved strategy drives both the companion's prompt and the landing path
(`landGuestPatch`), so local and guest runs commit identically.

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
| `MYSTERON_HOME` | `~/.mysteron` | Registry / global state location |
| `MYSTERON_PORT` / `MYSTERON_HOST` | `4319` / `127.0.0.1` | Web server bind |
| `MYSTERON_USAGE_TOKEN_LIMIT` | `5000000` | Billable-token budget per window (estimate/API-key mode) |
| `MYSTERON_USAGE_WINDOW_HOURS` | `5` | Rolling window length |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | Where transcripts are read from |
| `MYSTERON_RATELIMIT_PROXY` | `1` | Set `0` to disable the usage capture proxy |
| `MYSTERON_MCP_NAG` | `1` | Set `0` to stop the once-a-day offer to register Mysteron's MCP with Claude Code |

## CLI

```
mysteron init [path] [--name <name>] [--recipe <id>] [--yolo] [--no-import]
                                               Initialise Mysteron in a folder
mysteron register <path>                         Register an existing project
mysteron unregister <id|path>                    Remove from the registry
mysteron list                                    List registered projects
mysteron serve [--port <n>] [--host <h>] [-v]    Start the web UI + API (-v/--verbose for request/run logs)
mysteron mcp [id|path]                           Run the MCP server (stdio)
mysteron ticket list <id|path>                   List tickets
mysteron ticket add <id|path> <title...>         Add a ticket
mysteron join <host-url> --token <t> [--for 2h] [--name <label>] [--capacity 1]
                                               Offer this machine as a guest worker to a host
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
then `mysteron serve`. The server sends `Cache-Control: no-cache` on `index.html`,
so a rebuild is always picked up without a hard refresh.

> **Running agents on Mysteron itself?** Use a non-watching server (`npm start` or
> `mysteron serve`), **not** `npm run dev`. `tsx watch` restarts the server whenever
> a `src/**` file changes — and a companion working a ticket in this repo edits
> `src/**`, which would restart the server and kill its own run. (For any *other*
> project this isn't an issue; the agent edits that project's files, not Mysteron's.)

## Architecture

```
src/
  core/      registry, project, board, docs, memory, companions, recipes, git, watcher, events
  mcp/       per-project MCP server (stdio)
  server/    Express REST API + WebSocket hub (+ /worker hub, guest registry); serves the built web UI
  runner/    agent run manager (per-companion lock, sessions, run persistence) + board autopilot
  worker/    guest-worker client (offer this machine to a host, run dispatched tickets)
  plugins/   plugin interface + manager + usage-monitor
  cli.ts     the `mysteron` command
web/         Preact + Vite + Tailwind web UI (builds to dist/server/public)
```

Live updates ride a single **WebSocket** per tab (separate from the HTTP/1.1
6-connections-per-origin pool, so many tabs/runs never starve REST calls).
Headless-friendly: `mysteron serve` on a server + per-project MCP means you can
drive everything from the web UI and connect companions from anywhere.

## Roadmap

- ~~Companions: roster from a recipe, boring avatars, role briefs~~ ✅
- ~~Assign tickets to companions; one task at a time; per-companion autopilot~~ ✅
- ~~Persistent per-companion Claude sessions~~ ✅
- ~~Committed run metadata + hostname; gitignored local logs~~ ✅
- ~~Commit attribution (`Mysteron-Companion` trailer) + commits view~~ ✅
- ~~Optional password protection~~ ✅
- ~~Guest companions: lend a machine + Claude account; fan work out via working-tree patches~~ ✅
- Guest companions: sandbox guest runs (container/VM) so untrusted offers are safe
- Recipe teams: delegate to real sub-agents (currently the lead companion owns the work)
- Condense/fork a companion's session when its context grows large
- Auto-derive draft tickets from spec diffs on `docs-changed`
- More plugins (git/CI status, cost reporting, Slack notifications)
