#!/usr/bin/env node
// The Agent Keep: watches Claude Code and Cursor agent transcripts and streams
// per-agent state (never transcript content) to a local pixel-art page.
// Zero dependencies: node built-ins only (node:sqlite for Cursor chat titles).

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const CLAUDE_ROOT = process.env.CLAUDE_PROJECTS_DIR || path.join(HOME, '.claude', 'projects');
const CURSOR_ROOT = process.env.CURSOR_PROJECTS_DIR || path.join(HOME, '.cursor', 'projects');
const CURSOR_DB = process.env.CURSOR_STATE_DB ?? defaultCursorDb();
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 7331);
const SCAN_MS = 700;
const ACTIVE_MS = Number(process.env.ACTIVE_MINUTES || 30) * 60_000; // hide sessions quiet longer than this
const TAIL_BYTES = 512 * 1024; // first read of an existing file only looks at its tail
const DONE_LINGER_MS = 6_000; // finished subagents stay visible briefly before walking out
const TITLE_REFRESH_MS = 60_000;

const INDEX_HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html');

let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch { /* titles fall back to ids */ }

function defaultCursorDb() {
  const rel = ['Cursor', 'User', 'globalStorage', 'state.vscdb'];
  if (process.platform === 'darwin') return path.join(HOME, 'Library', 'Application Support', ...rel);
  if (process.platform === 'win32') return path.join(process.env.APPDATA || '', ...rel);
  return path.join(HOME, '.config', ...rel);
}

/** @type {Map<string, FileCursor>} file path -> read position */
const cursors = new Map();
/** @type {Map<string, Agent>} agent key -> state */
const agents = new Map();
/** Claude Agent tool_use id -> key of the agent that issued it (for parent links). */
const spawnedBy = new Map();
/** Finished agent key -> file size when it finished; revived only if the file grows. */
const tombstones = new Map();

let dirty = true;

// ---------- transcript discovery ----------

/**
 * @typedef {{ source: 'claude'|'cursor', file: string, kind: 'session'|'subagent', slug: string,
 *   sessionId: string, agentId?: string, size: number, mtimeMs: number }} Transcript
 */

const readdir = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
function safeStat(f) { try { return fs.statSync(f); } catch { return null; } }

function pushIfActive(out, t, cutoff) {
  const st = safeStat(t.file);
  if (st && st.mtimeMs >= cutoff) out.push({ ...t, size: st.size, mtimeMs: st.mtimeMs });
}

// ~/.claude/projects/<slug>/<session>.jsonl  +  <slug>/<session>/subagents/agent-<id>.jsonl (+ .meta.json)
function listClaude(cutoff) {
  const out = [];
  for (const p of readdir(CLAUDE_ROOT)) {
    if (!p.isDirectory()) continue;
    const dir = path.join(CLAUDE_ROOT, p.name);
    for (const e of readdir(dir)) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        pushIfActive(out, { source: 'claude', file: path.join(dir, e.name), kind: 'session', slug: p.name, sessionId: e.name.slice(0, -6) }, cutoff);
      } else if (e.isDirectory()) {
        const subDir = path.join(dir, e.name, 'subagents');
        for (const s of readdir(subDir)) {
          if (!s.name.startsWith('agent-') || !s.name.endsWith('.jsonl')) continue;
          pushIfActive(out, { source: 'claude', file: path.join(subDir, s.name), kind: 'subagent', slug: p.name, sessionId: e.name, agentId: s.name.slice(6, -6) }, cutoff);
        }
      }
    }
  }
  return out;
}

// ~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl  +  <id>/subagents/<subId>.jsonl
function listCursor(cutoff) {
  const out = [];
  for (const p of readdir(CURSOR_ROOT)) {
    if (!p.isDirectory() || p.name.startsWith('.')) continue;
    const dir = path.join(CURSOR_ROOT, p.name, 'agent-transcripts');
    for (const e of readdir(dir)) {
      if (!e.isDirectory()) continue;
      const base = path.join(dir, e.name);
      pushIfActive(out, { source: 'cursor', file: path.join(base, `${e.name}.jsonl`), kind: 'session', slug: p.name, sessionId: e.name }, cutoff);
      for (const s of readdir(path.join(base, 'subagents'))) {
        if (!s.name.endsWith('.jsonl')) continue;
        pushIfActive(out, { source: 'cursor', file: path.join(base, 'subagents', s.name), kind: 'subagent', slug: p.name, sessionId: e.name, agentId: s.name.slice(0, -6) }, cutoff);
      }
    }
  }
  return out;
}

// ---------- incremental reading ----------

/** @typedef {{ offset: number, partial: string }} FileCursor */

function readNewLines(t) {
  let cur = cursors.get(t.file);
  let start;
  let skipFirst = false;
  if (!cur) {
    start = Math.max(0, t.size - TAIL_BYTES);
    skipFirst = start > 0; // we landed mid-line
    cur = { offset: start, partial: '' };
    cursors.set(t.file, cur);
  } else {
    if (t.size < cur.offset) { cur.offset = 0; cur.partial = ''; } // truncated/rewritten
    start = cur.offset;
  }
  if (t.size <= start) return [];
  const len = t.size - start;
  const buf = Buffer.alloc(len);
  let fd;
  try {
    fd = fs.openSync(t.file, 'r');
    fs.readSync(fd, buf, 0, len, start);
  } catch { return []; } finally { if (fd !== undefined) fs.closeSync(fd); }
  cur.offset = t.size;
  const text = cur.partial + buf.toString('utf8');
  const lines = text.split('\n');
  cur.partial = lines.pop() ?? '';
  if (skipFirst) lines.shift();
  const parsed = [];
  for (const l of lines) {
    if (!l) continue;
    try { parsed.push(JSON.parse(l)); } catch { /* unknown or partial line: ignore */ }
  }
  return parsed;
}

// ---------- state model ----------

/**
 * @typedef {Object} Agent
 * @property {string} key
 * @property {'claude'|'cursor'} source
 * @property {'session'|'subagent'} kind
 * @property {string} sessionKey
 * @property {string|null} parentKey
 * @property {string} project      basename of the workspace
 * @property {string} title        session title or subagent description
 * @property {string|null} agentType
 * @property {string|null} branch
 * @property {string} state        thinking | typing | reading | running | delegating | waiting | done
 * @property {string|null} tool    current tool name
 * @property {Map<string,{name:string,ts:number}>} pending  unanswered tool calls
 * @property {number} lastTs
 * @property {number|null} doneAt
 */

// Tool names from both Claude Code and Cursor.
const TOOL_STATE = {
  Edit: 'typing', MultiEdit: 'typing', Write: 'typing', NotebookEdit: 'typing', StrReplace: 'typing', Delete: 'typing', EditNotebook: 'typing',
  Read: 'reading', ReadFile: 'reading', Grep: 'reading', Glob: 'reading', LS: 'reading', rg: 'reading', ReadLints: 'reading',
  WebFetch: 'reading', WebSearch: 'reading', ToolSearch: 'reading', GetDynamicTools: 'reading', GetMcpTools: 'reading', SearchConversations: 'reading',
  Bash: 'running', BashOutput: 'running', Monitor: 'running', KillShell: 'running', Shell: 'running', AwaitShell: 'running', Await: 'running',
  Agent: 'delegating', Task: 'delegating',
  AskUserQuestion: 'waiting', ExitPlanMode: 'waiting', AskQuestion: 'waiting',
  TodoWrite: 'thinking', UpdateCurrentStep: 'thinking', CreatePlan: 'thinking',
};

function stateForTool(name) {
  if (TOOL_STATE[name]) return TOOL_STATE[name];
  if (name.startsWith('mcp__')) return 'reading';
  return 'running';
}

function setTool(a, name) {
  a.tool = name; a.state = stateForTool(name); a.doneAt = null;
}

function ensureAgent(t) {
  const sessionKey = `${t.source}:${t.slug}/${t.sessionId}`;
  const key = t.kind === 'session' ? sessionKey : `${sessionKey}/${t.agentId}`;
  let a = agents.get(key);
  if (!a) {
    a = {
      key, source: t.source, file: t.file, kind: t.kind, sessionKey, parentKey: t.kind === 'session' ? null : sessionKey,
      id: t.kind === 'session' ? t.sessionId : t.agentId,
      project: projectFromSlug(t.slug), title: '', agentType: null, branch: null,
      state: 'thinking', tool: null, pending: new Map(), lastTs: t.mtimeMs, doneAt: null,
    };
    if (t.source === 'claude' && t.kind === 'subagent') loadClaudeMeta(a, t);
    agents.set(key, a);
    dirty = true;
  }
  return a;
}

function finishTurn(a, ts) {
  a.pending.clear();
  a.tool = null;
  if (a.kind === 'subagent') { a.state = 'done'; a.doneAt = a.doneAt ?? ts ?? Date.now(); }
  else a.state = 'waiting';
}

// Slugs are paths with '/' turned into '-', which is ambiguous when folder names
// contain '-'. Walk the real filesystem to find the folder the slug came from.
const slugCache = new Map();
function projectFromSlug(slug) {
  if (slugCache.has(slug)) return slugCache.get(slug);
  const tokens = slug.replace(/^-/, '').split('-');
  let dir = path.sep, i = 0, name = slug;
  while (i < tokens.length && tokens.length < 40) {
    let found = false;
    for (let j = tokens.length; j > i; j--) {
      const part = tokens.slice(i, j).join('-');
      for (const cand of [part, '.' + part]) {
        if (part && safeStat(path.join(dir, cand))?.isDirectory()) { dir = path.join(dir, cand); name = cand; i = j; found = true; break; }
      }
      if (found) break;
    }
    if (!found) { name = tokens.slice(i).join('-') || name; break; }
  }
  slugCache.set(slug, name);
  return name;
}

// ---------- Claude Code lines ----------

function loadClaudeMeta(a, t) {
  const metaFile = t.file.replace(/\.jsonl$/, '.meta.json');
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    a.agentType = meta.agentType ?? null;
    a.title = meta.description ?? '';
    a.toolUseId = meta.toolUseId ?? null;
    a.metaLoaded = true;
  } catch { a.metaLoaded = false; }
}

function tsOf(line) {
  const n = line.timestamp ? Date.parse(line.timestamp) : NaN;
  return Number.isFinite(n) ? n : null;
}

function applyClaude(a, line) {
  const ts = tsOf(line);
  if (ts) a.lastTs = Math.max(a.lastTs, ts);
  if (line.cwd) a.project = path.basename(line.cwd);
  if (line.gitBranch) a.branch = line.gitBranch;

  switch (line.type) {
    case 'custom-title':
      if (line.customTitle) { a.title = line.customTitle; a.hasCustomTitle = true; }
      return;
    case 'ai-title':
      if (line.aiTitle && !a.hasCustomTitle) a.title = line.aiTitle;
      return;
    case 'assistant': {
      const content = line.message?.content ?? [];
      for (const b of content) {
        if (b.type === 'tool_use') {
          a.pending.set(b.id, { name: b.name, ts: ts ?? Date.now() });
          if (b.name === 'Agent' || b.name === 'Task') spawnedBy.set(b.id, a.key);
        }
      }
      const stop = line.message?.stop_reason;
      if (content.some(b => b.type === 'tool_use')) {
        setTool(a, [...a.pending.values()].pop().name);
      } else if (stop === 'end_turn' || stop === 'stop_sequence') {
        finishTurn(a, ts);
      } else {
        a.state = 'thinking'; a.tool = null; a.doneAt = null;
      }
      return;
    }
    case 'user': {
      const c = line.message?.content;
      if (typeof c === 'string') {
        if (c.startsWith('[Request interrupted')) finishTurn(a, ts);
        else { a.state = 'thinking'; a.tool = null; a.doneAt = null; }
        return;
      }
      if (!Array.isArray(c)) return;
      let sawResult = false;
      for (const b of c) {
        if (b.type === 'tool_result') {
          sawResult = true;
          a.pending.delete(b.tool_use_id);
          markClaudeSubagentReturned(b.tool_use_id, ts);
        } else if (b.type === 'text' && b.text?.startsWith('[Request interrupted')) {
          finishTurn(a, ts); return;
        }
      }
      if (sawResult) {
        if (a.pending.size) setTool(a, [...a.pending.values()].pop().name);
        else { a.state = 'thinking'; a.tool = null; }
      } else if (!line.isMeta) {
        a.state = 'thinking'; a.tool = null; a.doneAt = null;
      }
      return;
    }
    case 'system':
      if (line.subtype === 'stop_hook_summary' && a.pending.size === 0) finishTurn(a, ts);
      return;
  }
}

function markClaudeSubagentReturned(toolUseId, ts) {
  for (const a of agents.values()) {
    if (a.source === 'claude' && a.kind === 'subagent' && a.toolUseId === toolUseId && a.state !== 'done') {
      a.state = 'done'; a.tool = null; a.doneAt = ts ?? Date.now(); dirty = true;
    }
  }
}

// ---------- Cursor lines ----------
// Cursor writes {role, message:{content}} lines plus {"type":"turn_ended"}. There are no
// timestamps, tool ids or tool results, so the newest tool call is the current one until
// the next line lands, and file mtime stands in for time.

function cursorTool(b) {
  const inp = b.input && typeof b.input === 'object' ? b.input : {};
  if (b.name === 'CallDynamicTool' || b.name === 'CallMcpTool') {
    const n = inp.toolName || b.name;
    const ns = inp.namespace || inp.server || '';
    const args = inp.arguments && typeof inp.arguments === 'object' ? inp.arguments : {};
    return { name: !ns || ns === 'cursor' ? n : `mcp__${ns}__${n}`, args };
  }
  return { name: b.name, args: inp };
}

const textOf = (content) => content.filter(b => b?.type === 'text').map(b => b.text || '').join('\n');

function applyCursor(a, line, t) {
  if (line.type === 'turn_ended') { finishTurn(a, t.mtimeMs); return; }
  const content = line.message?.content;
  if (!Array.isArray(content)) return;
  a.pending.clear();
  if (line.role === 'user') {
    // Kept in memory only, to match a subagent to the Task call that spawned it.
    if (a.kind === 'subagent' && a.firstText === undefined) a.firstText = textOf(content).slice(0, 2000);
    a.state = 'thinking'; a.tool = null; a.doneAt = null;
    return;
  }
  if (line.role !== 'assistant') return;
  const uses = content.filter(b => b?.type === 'tool_use').map(cursorTool);
  if (a.kind === 'subagent' && a.firstText === undefined) {
    // A forked subagent's file starts with its own Task call rather than a prompt.
    a.firstText = '';
    const fork = uses.find(u => u.name === 'Task');
    if (fork) { a.agentType = fork.args.subagent_type || 'fork'; a.title ||= fork.args.description || ''; a.matched = true; }
  }
  if (!uses.length) { a.state = 'thinking'; a.tool = null; a.doneAt = null; return; }
  for (const u of uses) {
    if (u.name === 'Task' && a.kind === 'session' && typeof u.args.prompt === 'string') {
      (a.taskPrompts ??= []).push({ head: u.args.prompt.slice(0, 120), type: u.args.subagent_type || null, description: u.args.description || '' });
      if (a.taskPrompts.length > 50) a.taskPrompts.shift();
    }
  }
  const last = uses.at(-1);
  a.pending.set('current', { name: last.name, ts: t.mtimeMs });
  setTool(a, last.name);
}

function matchCursorSubagent(a) {
  if (a.matched || !a.firstText) return;
  const parent = agents.get(a.sessionKey);
  const hit = parent?.taskPrompts?.find(p => p.head && a.firstText.includes(p.head));
  if (!hit) return;
  a.matched = true;
  a.agentType = hit.type || 'task';
  if (!a.title) a.title = hit.description;
  dirty = true;
}

// Cursor keeps chat names in its settings database, keyed by the transcript id.
function cursorTitle(id) {
  if (!sqlite || !CURSOR_DB || !fs.existsSync(CURSOR_DB)) return null;
  let db;
  try {
    db = new sqlite.DatabaseSync(CURSOR_DB, { readOnly: true });
    const row = db.prepare("SELECT json_extract(value, '$.name') AS name FROM cursorDiskKV WHERE key = ?").get(`composerData:${id}`);
    return row?.name || null;
  } catch { return null; } finally { try { db?.close(); } catch { /* ignore */ } }
}

function refreshCursorTitle(a, now) {
  if (a.titleCheckedAt && now - a.titleCheckedAt < TITLE_REFRESH_MS) return;
  a.titleCheckedAt = now;
  const name = cursorTitle(a.id);
  if (name && (a.kind === 'session' || !a.title) && name !== a.title) { a.title = name; dirty = true; }
  if (!a.title && a.kind === 'session') a.title = `Cursor chat ${a.id.slice(0, 8)}`;
}

// ---------- scan loop ----------

function scan() {
  const seen = new Set();
  const cutoff = Date.now() - ACTIVE_MS;
  // Sessions first so parent links resolve before their subagents' first lines.
  const files = [...listClaude(cutoff), ...listCursor(cutoff)]
    .sort((x, y) => (x.kind === y.kind ? 0 : x.kind === 'session' ? -1 : 1));
  for (const t of files) {
    const k = `${t.source}:${t.slug}/${t.sessionId}` + (t.kind === 'subagent' ? `/${t.agentId}` : '');
    if (tombstones.get(k) === t.size) continue; // finished and nothing new since
    tombstones.delete(k);
    const a = ensureAgent(t);
    seen.add(a.key);
    if (a.source === 'claude' && a.kind === 'subagent' && !a.metaLoaded) loadClaudeMeta(a, t);
    const lines = readNewLines(t);
    for (const l of lines) (a.source === 'claude' ? applyClaude(a, l) : applyCursor(a, l, t));
    if (lines.length) { dirty = true; if (a.source === 'cursor') a.lastTs = Math.max(a.lastTs, t.mtimeMs); }
  }
  const now = Date.now();
  for (const [key, a] of agents) {
    if (a.source === 'claude' && a.kind === 'subagent' && a.toolUseId && spawnedBy.has(a.toolUseId)) {
      a.parentKey = spawnedBy.get(a.toolUseId);
    }
    if (a.source === 'cursor') {
      if (a.kind === 'subagent') matchCursorSubagent(a);
      refreshCursorTitle(a, now);
    }
    const tooOld = now - a.lastTs > ACTIVE_MS;
    const doneLongAgo = a.state === 'done' && now - Math.max(a.doneAt ?? 0, a.lastTs) > DONE_LINGER_MS;
    if (doneLongAgo) tombstones.set(key, cursors.get(a.file)?.offset);
    if (!seen.has(key) || tooOld || doneLongAgo) { agents.delete(key); dirty = true; }
  }
  // A subagent whose session vanished has nowhere to sit.
  for (const [key, a] of agents) {
    if (a.kind === 'subagent' && !agents.has(a.sessionKey)) { agents.delete(key); dirty = true; }
  }
}

function snapshot() {
  const now = Date.now();
  return {
    now,
    agents: [...agents.values()].map(a => {
      const oldestPending = [...a.pending.values()].reduce((m, p) => Math.min(m, p.ts), Infinity);
      const pendingForMs = Number.isFinite(oldestPending) ? now - oldestPending : 0;
      return {
        key: a.key,
        source: a.source,
        kind: a.kind,
        parentKey: a.parentKey,
        sessionKey: a.sessionKey,
        project: a.project,
        title: a.title,
        agentType: a.agentType,
        branch: a.branch,
        state: a.state,
        tool: a.tool,
        pendingForMs,
        idleForMs: now - a.lastTs,
      };
    }),
  };
}

// ---------- http + SSE ----------

const clients = new Set();

function allowedHost(req) {
  // Blocks DNS-rebinding: only answer requests addressed to loopback names.
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  return host === '127.0.0.1' || host === 'localhost';
}

const server = http.createServer((req, res) => {
  if (!allowedHost(req)) {
    console.warn(`Refused ${req.url}: Host "${req.headers.host}" is not 127.0.0.1 or localhost`);
    res.writeHead(403, { 'content-type': 'text/plain' }).end('Open this page at http://127.0.0.1:' + PORT);
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
    });
    fs.createReadStream(INDEX_HTML).pipe(res);
    return;
  }
  if (url.pathname === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/favicon.ico') {
    res.writeHead(200, { 'content-type': 'image/svg+xml' }).end(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M2 1h12v8l-6 6-6-6z" fill="#d9a441"/><path d="M3 2h10v7l-5 5-5-5z" fill="#8f1d2c"/><path d="M7 3h2v9H7zM4 6h8v2H4z" fill="#d9a441"/></svg>');
    return;
  }
  if (url.pathname === '/state') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(snapshot(), null, 2));
    return;
  }
  res.writeHead(404).end();
});

let ticks = 0;
setInterval(() => {
  try { scan(); } catch (err) { console.error('scan failed:', err); }
  ticks++;
  // Push on change, plus every ~3s so "for 42s" counters keep moving.
  if (dirty || ticks % 4 === 0) {
    dirty = false;
    const msg = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const c of clients) c.write(msg);
  }
}, SCAN_MS);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. The Agent Keep may already be running: open http://${HOST}:${PORT}`);
    console.error(`To run another copy, pick a different port:  PORT=${PORT + 2} node server.mjs`);
    process.exit(1);
  }
  throw err;
});

scan();
server.listen(PORT, HOST, () => {
  console.log(`The Agent Keep is watching:`);
  console.log(`  Claude Code  ${CLAUDE_ROOT}`);
  console.log(`  Cursor       ${CURSOR_ROOT}${sqlite && fs.existsSync(CURSOR_DB) ? '' : '  (chat titles unavailable)'}`);
  console.log(`Open http://${HOST}:${PORT}`);
});
