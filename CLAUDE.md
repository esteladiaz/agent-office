# The Agent Keep: notes for Claude

A local, zero-dependency visualizer for Claude Code and Cursor agents (and subagents). Default UI is a **theme-agnostic hierarchical tree** (project → parent thread → subagents), not pixel art. It's an in-house replacement for the third-party "Pixel Agents" extension. See README.md for usage.

## Ground rules

- **No dependencies.** Node built-ins only (`node:sqlite` for Cursor titles). No npm packages, no CDN scripts, no downloaded art in the default view.
- **Local and read-only.** Bind `127.0.0.1` only and keep the `Host` check (it blocks DNS rebinding). Only read transcript files; never modify Claude Code or Cursor settings, hooks or databases without an explicit go-ahead from the user.
- **The live feed carries no transcript content.** `/events` and `/state` send titles, subagent descriptions, project and branch names, tool names and states, plus whether a waiting agent is asking a question or yielding the turn. The same safe metadata applies to **departed** and **graveyard** rolls. `GET /transcript?key=` returns pages only when the page asks, and only for a key the server lists (active, recent, or archive). `POST /reply` sends a follow-up only for a Cursor Cloud agent in the active list and currently waiting.
- **Three tiers in the UI:** **Active** = live within `ACTIVE_MINUTES` (default 30); **Recent** = `departed` roll (last used within `GRAVEYARD_DAYS`, default 7); **Archive** = `graveyard` (older). Finished subagents stay nested under a live parent until the parent leaves. Runtime recent entries re-bucket to archive on snapshot when they age past `GRAVEYARD_DAYS`.
- **Display renames are local.** Overrides live in `AGENT_KEEP_DATA_DIR` / `~/Library/Application Support/TheAgentKeep/names.json` (atomic write). `POST /rename` applies to keys listed in active/recent/archive snapshots. Never write to transcripts, Cursor DB, or Cloud rename APIs.
- **Port 7331.** Avoid 4317 and 4318: an OpenTelemetry collector (OrbStack) listens there on this machine.
- The transcript formats are undocumented. Parse defensively and skip unknown lines.

## Layout

- `server.mjs` checks transcript folders every 0.7s, reads only the new lines of each file, keeps one state per agent, and streams snapshots over Server-Sent Events (`/events`; `/state` returns JSON for debugging). Snapshot includes `cloud: { enabled, lastPollAt, lastPollOk, apiCount, inHall, lastError }`.
- `index.html` uses a small `THEME` object for labels/colors; **Graph** (default, Canvas 2D force layout) and **Tree** views share tier/filter logic. Click a node or row → transcript panel. Server may set `parentKey` on cloud agents when a `bc-…` id appears in a local tool call (metadata only); otherwise cloud nodes hang off a **Cloud** hub.
- `demo.mjs` writes fake sessions to `demo-projects/` (gitignored). Run with:
  `CLAUDE_PROJECTS_DIR=./demo-projects/claude CURSOR_PROJECTS_DIR=./demo-projects/cursor CURSOR_STATE_DB= PORT=7332 node server.mjs` and `node demo.mjs`

## What's known about each source

**Claude Code (works, verified live):** `~/.claude/projects/<slug>/<session>.jsonl`, with subagents in `<session>/subagents/agent-<id>.jsonl` plus `.meta.json` (agentType, description, toolUseId). Lines carry timestamps, tool-call ids and tool results.

**Cursor local agents (works on recorded history; live behavior not yet verified):** `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`, with subagents in `<id>/subagents/<subId>.jsonl`. Lines are `{role, message}` plus `{"type":"turn_ended"}`, with no timestamps, tool ids or tool results. Subagents are linked by matching their first user message to a parent `Task` call's `prompt`. Titles are read (read-only) from `…/Cursor/User/globalStorage/state.vscdb`, table `cursorDiskKV`, key `composerData:<id>`, field `name`. **Open question:** does Cursor append lines while a turn runs, or only at the end? Check by watching a file's size during a local agent run.

**Cursor cloud agents:** IDs start with `bc-`. They run on Cursor's servers and write no local transcript, so Agent Keep uses the v1 Cloud Agents API only when `CURSOR_API_KEY` is set. Discovery polls `/v1/agents` every 10s; each active run uses its resumable `/stream` SSE endpoint for exact tool state. Prompts, assistant text, tool arguments and tool results are discarded. The browser receives the same safe metadata as local agents.

## Known limits

- Stuck state (>10s on a pending tool) is a guess. For Cursor it's rougher, since file modification time stands in for timestamps. Hooks would make it exact, but they change the tools' config, so they need the user's approval first.
- Cursor's built-in Browser Tab showed a blank gray page and never connected to the server. Simple Browser (Command Palette → "Simple Browser: Show") or a normal browser works.
