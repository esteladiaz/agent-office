# Agent Keep

A local, zero-dependency dashboard for Claude Code and Cursor agents (and their subagents). It watches transcript folders and optional Cursor Cloud API metadata, then shows a hierarchical tree: **project → parent thread → subagents**. No npm packages — Node 22.5+ built-ins only.

```bash
node server.mjs          # then open http://127.0.0.1:7331
```

On macOS you can double-click **The Agent Keep** in `/Applications` instead; see [MAC-APP.md](MAC-APP.md).

To include Cursor Cloud agents, create a Cursor user API key in Dashboard → API Keys and keep it in a gitignored `.env.local`:

```bash
printf 'CURSOR_API_KEY=\n' > .env.local
chmod 600 .env.local
# Add the key after = in an editor, then:
node --env-file=.env.local server.mjs
```

The key stays in the Node process and is sent only to Cursor's API. It is never included in the page, `/state`, or Server-Sent Events.

To try it without real agents:

```bash
CLAUDE_PROJECTS_DIR=./demo-projects/claude CURSOR_PROJECTS_DIR=./demo-projects/cursor PORT=7332 node server.mjs &
node demo.mjs            # open http://127.0.0.1:7332, re-run to replay
```

## How it works

- `server.mjs` checks both tools' transcript folders every 0.7s. It reads only the new lines of each file, turns them into one state per agent, and pushes metadata to the page over Server-Sent Events (`/events`; `/state` for debugging).
- When `CURSOR_API_KEY` is set, it polls the Cursor Cloud Agents API every 10s and opens a resumable event stream for each active run. Prompts, tool arguments, tool results, and assistant text are **not** sent on the live feed.
- `index.html` defaults to a **force-directed graph** (Obsidian-style) with a **Tree** toggle for checklist-style hierarchy. Both views share Active / Recent / Archive tiers, search, and filters. Click a node or row to open the transcript side panel (`GET /transcript?key=`). Cursor Cloud agents that are waiting can take a reply via `POST /reply`. Claude Code and local Cursor have no send line in the UI.
- It never changes either tool's settings or hooks.

### Claude Code

- Sessions: `~/.claude/projects/<slug>/<session>.jsonl`
- Subagents: `<slug>/<session>/subagents/agent-<id>.jsonl`, plus `.meta.json` (agentType, description, toolUseId).
- Lines have timestamps, tool-call ids and tool results, so stuck-tool detection is exact.
- Titles come from `custom-title` and `ai-title` lines.

### Cursor (local)

- Sessions: `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`
- Subagents: `<id>/subagents/<subId>.jsonl`. Subagents link by matching the first user message to a parent `Task` call's `prompt`.
- Lines are `{role, message}` plus `{"type":"turn_ended"}`, with **no timestamps or tool ids**. File modification time stands in for timestamps.
- Chat titles are read from Cursor's database (`…/Cursor/User/globalStorage/state.vscdb`, key `composerData:<id>`), read-only.

### Cursor Cloud

- Discovery: `GET /v1/agents` on a poll interval (default 10s).
- Live state: resumable run stream per active run.
- Cloud agents without a project name appear under a **Cloud** group in the tree.

## UI tiers

| Tab | Server data | Meaning |
|---|---|---|
| **Active** | `agents` | Live within `ACTIVE_MINUTES` (default 30). Finished subagents stay nested under their parent (up to 24 per thread). |
| **Recent** | `departed` | Left the active set but last used within `GRAVEYARD_DAYS` (default 7). |
| **Archive** | `graveyard` | Last used older than `GRAVEYARD_DAYS`, including stat-only history scans. |

Runtime **Recent** entries are re-bucketed into **Archive** on each snapshot when they age past `GRAVEYARD_DAYS` (no restart required).

Env: `GRAVEYARD_DAYS=7`, `DEPARTED_MAX=60`, `GRAVEYARD_MAX=100`, `HISTORY_SCAN_MS=180000` (3 minutes). `/state` and `/events` carry metadata only for all tiers, plus a `cloud` object (integration on/off, last poll, API count).

## States (plain labels)

| Internal / tool pattern | UI label |
|---|---|
| Edit, Write, … | Working: editing |
| Read, Grep, … | Working: reading/searching |
| Bash, Shell, … | Working: running commands |
| Agent / Task | Working: delegating |
| (no pending tool) | Working: thinking |
| Waiting + question | Waiting on you: question |
| Waiting + turn | Waiting on you: your turn |
| Tool pending > 10s | Stuck (>10s) — heuristic |
| Waiting > 10 min | Idle / asleep |
| Done | Done |

## Security

- Binds to `127.0.0.1` only and rejects non-loopback `Host` (DNS rebinding).
- Live feed: titles, descriptions, project/branch, tool names, state — no transcript bodies.
- `GET /transcript` returns one agent's pages only when that key is listed in Active, Recent, or Archive.
- Default port **7331** (avoid 4317/4318 — OpenTelemetry on this machine).

## Settings (environment variables)

- `PORT` (default 7331)
- `ACTIVE_MINUTES` (default 30)
- `GRAVEYARD_DAYS` (default 7)
- `DEPARTED_MAX`, `GRAVEYARD_MAX`, `HISTORY_SCAN_MS`
- `CLAUDE_PROJECTS_DIR`, `CURSOR_PROJECTS_DIR`, `CURSOR_STATE_DB`
- `CURSOR_API_KEY`, `CLOUD_POLL_MS` (default 10000)

Neither tool documents its transcript format; unknown lines are skipped.

## Display name overrides

You can rename any listed agent (parent thread or subagent) in the UI. Renames are **local to Agent Keep** only — stored in `names.json` under `~/Library/Application Support/TheAgentKeep/` on macOS (or `AGENT_KEEP_DATA_DIR`). They do not change Claude Code, Cursor, or Cloud agent names in those products. `POST /rename` with `{ key, name }` updates the override; an empty `name` clears it.
