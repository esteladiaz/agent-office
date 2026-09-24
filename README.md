# The Agent Keep

A pixel-art medieval hall where your running Claude Code and Cursor agents, and their subagents, sit at scribes' desks and animate based on what they're doing. It's an in-house take on Pixel Agents, with no dependencies (Node 22.5+ built-ins only).

```bash
node server.mjs          # then open http://127.0.0.1:7331
```

To try it without real agents, play fake Claude Code and Cursor sessions that spawn subagents:

```bash
CLAUDE_PROJECTS_DIR=./demo-projects/claude CURSOR_PROJECTS_DIR=./demo-projects/cursor PORT=7332 node server.mjs &
node demo.mjs            # open http://127.0.0.1:7332, re-run to replay
```

## How it works

- `server.mjs` checks both tools' transcript folders every 0.7s. It reads only the new lines of each file, turns them into one state per agent, and pushes that state to the page over Server-Sent Events.
- `index.html` draws the hall on a Canvas 2D. Every sprite is drawn in code with `fillRect`; there are no image assets.
- It reads files only. Neither tool's settings or hooks are changed.

### Claude Code

- Sessions: `~/.claude/projects/<slug>/<session>.jsonl`
- Subagents: `<slug>/<session>/subagents/agent-<id>.jsonl`, plus a `.meta.json` that gives the type, the description and the parent's `Agent` tool-call id.
- Lines have timestamps, tool-call ids and tool results, so "how long has this tool been running" is exact.
- Titles come from `custom-title` and `ai-title` lines.

### Cursor

- Sessions: `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`
- Subagents: `<id>/subagents/<subId>.jsonl`. There is no meta file. A subagent is linked to the parent's `Task` call whose `prompt` begins its first message; that call gives `subagent_type` and `description`. A forked subagent (whose file starts with its own `Task` call) is labeled from that call.
- Lines are `{role, message}` plus `{"type":"turn_ended"}`, with **no timestamps, tool ids or tool results**. The newest tool call counts as current until the next line appears, and the file's modification time stands in for timestamps.
- MCP tools are wrapped as `CallDynamicTool` or `CallMcpTool`; the real tool name comes from `toolName`.
- Chat titles are read from Cursor's own database (`…/Cursor/User/globalStorage/state.vscdb`, key `composerData:<id>`). The database is opened **read-only** for a single indexed lookup, at most once a minute per chat. Without it, titles fall back to `Cursor chat <id>`.

## Who's who

- **Monarch** (crown, cape, throne): a session. A **crimson carpet** means Claude Code; a **blue carpet** means Cursor.
- **Knight** (steel helm, plume): a `general-purpose` / `generalPurpose` subagent
- **Ranger** (green hood): an `Explore` / `explore` subagent
- **Wizard** (pointed hat): a `Plan` subagent
- **Monk** (brown hood): any other subagent type

The open tome on each desk shows what the agent is doing: ink appearing (scribing), pages turning (studying), glowing runes (conjuring), or a campaign map (commanding subagents). The tome is closed when the agent is waiting for you.

## States

| Tool call (Claude Code / Cursor) | State |
|---|---|
| Edit, Write, NotebookEdit / StrReplace, Write, Edit, Delete | scribing |
| Read, Grep, Glob, Web*, MCP tools / Read, Grep, Glob, rg, ReadLints, Web*, MCP tools | studying |
| Bash / Shell, AwaitShell, and anything unrecognized | conjuring |
| Agent / Task | commanding (subagents walk in through the gate) |
| AskUserQuestion, ExitPlanMode / AskQuestion | awaits thee (it's asking you something) |
| a tool call still unanswered after 10s | beset: stuck, maybe waiting for permission (a guess, not certain) |
| end of turn or an interrupt | awaits thee; after 10 min, slumbering |
| subagent finishes | it walks out through the gate |

## Security

- Binds to `127.0.0.1` only and rejects requests whose `Host` isn't loopback, which blocks DNS rebinding.
- Sends only titles, subagent descriptions, project and branch names, and tool names. Prompts, code and tool output never leave the server. The first line of each Cursor subagent is kept in server memory only, to link it to its parent.
- The default port is 7331. Avoid 4317 and 4318: they're the standard OpenTelemetry ports, and binding them on loopback can intercept a local telemetry collector.

## Settings (environment variables)

- `PORT` (default 7331)
- `ACTIVE_MINUTES`: hide sessions that have been quiet longer than this (default 30)
- `CLAUDE_PROJECTS_DIR`: Claude Code transcripts (default `~/.claude/projects`)
- `CURSOR_PROJECTS_DIR`: Cursor transcripts (default `~/.cursor/projects`)
- `CURSOR_STATE_DB`: Cursor's database, used for chat titles; set it empty to turn title lookup off

Neither tool documents its transcript format, so an update to either may change it. Unknown lines are skipped.
