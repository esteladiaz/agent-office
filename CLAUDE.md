# The Agent Keep: notes for Claude

A local, zero-dependency visualizer that shows running Claude Code and Cursor agents (and their subagents) as characters in a pixel-art medieval hall. It's an in-house replacement for the third-party "Pixel Agents" extension: third-party extensions aren't allowed on this laptop. See README.md for usage.

## Ground rules

- **No dependencies.** Node built-ins only (`node:sqlite` for Cursor titles). No npm packages, no CDN scripts, no downloaded art: every sprite is drawn in code in `index.html`.
- **Local and read-only.** Bind `127.0.0.1` only and keep the `Host` check (it blocks DNS rebinding). Only read transcript files; never modify Claude Code or Cursor settings, hooks or databases without an explicit go-ahead from the user.
- **No transcript content leaves the server.** The page receives titles, subagent descriptions, project and branch names, tool names and states, never prompts, code or tool output.
- **Port 7331.** Avoid 4317 and 4318: an OpenTelemetry collector (OrbStack) listens there on this machine.
- The transcript formats are undocumented. Parse defensively and skip unknown lines.

## Layout

- `server.mjs` checks transcript folders every 0.7s, reads only the new lines of each file, keeps one state per agent, and streams snapshots over Server-Sent Events (`/events`; `/state` returns JSON for debugging).
- `index.html` has the Canvas 2D renderer, a state-to-animation map, and a table.
- `demo.mjs` writes fake Claude Code and Cursor sessions to `demo-projects/` (gitignored). Run with:
  `CLAUDE_PROJECTS_DIR=./demo-projects/claude CURSOR_PROJECTS_DIR=./demo-projects/cursor CURSOR_STATE_DB= PORT=7332 node server.mjs` and `node demo.mjs`

## What's known about each source

**Claude Code (works, verified live):** `~/.claude/projects/<slug>/<session>.jsonl`, with subagents in `<session>/subagents/agent-<id>.jsonl` plus `.meta.json` (agentType, description, toolUseId). Lines carry timestamps, tool-call ids and tool results.

**Cursor local agents (works on recorded history; live behavior not yet verified):** `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`, with subagents in `<id>/subagents/<subId>.jsonl`. Lines are `{role, message}` plus `{"type":"turn_ended"}`, with no timestamps, tool ids or tool results. Subagents are linked by matching their first user message to a parent `Task` call's `prompt`. Titles are read (read-only) from `…/Cursor/User/globalStorage/state.vscdb`, table `cursorDiskKV`, key `composerData:<id>`, field `name`. **Open question:** does Cursor append lines while a turn runs, or only at the end? Check by watching a file's size during a local agent run.

**Cursor cloud agents (not supported yet; the next piece of work):** IDs start with `bc-`. They run on Cursor's servers (remote `/home/ubuntu/.cursor-server` workspaces) and write **no local transcript**. The only local trace is chat messages ("bubbles") synced into the same `state.vscdb` (`bubbleId:bc-<id>:<bubbleId>`, `composerData:bc-<id>`). That sync is partial and lagged: on 2026-09-23 the newest synced message was about 1h15m behind active work. It's not a reliable live signal. Per-agent files also sync to `~/Library/Application Support/Cursor/AgentStores/cursor_agent_stores/<id>/files/`; treat these as private work notes and don't display them.

Options discussed, none chosen yet:
1. Cursor's Cloud Agents API, polled every ~10s, needs a Cursor API key. **Not yet approved.** Whether a key is acceptable, and under which company account, is the user's decision. Check the endpoints against Cursor's current docs before writing any code.
2. Read synced bubbles from `state.vscdb`. No key needed, but too laggy to be useful.
3. Leave cloud agents out of scope.

If cloud agents get added, give them their own "house" (carpet color) in `HOUSE` in `index.html`, alongside `claude` (crimson) and `cursor` (blue).

## Known limits

- "Beset" (stuck or waiting for permission) is a guess: a tool call still unanswered after 10s. For Cursor it's rougher, since file modification time stands in for timestamps. Hooks would make it exact, but they change the tools' config, so they need the user's approval first.
- Cursor's built-in Browser Tab showed a blank gray page and never connected to the server. Simple Browser (Command Palette → "Simple Browser: Show") or a normal browser works.
