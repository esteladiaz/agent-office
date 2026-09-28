#!/usr/bin/env node
// The Agent Keep: watches Claude Code and Cursor agent transcripts and streams
// per-agent state to a local pixel-art page. The live feed stays metadata.
// GET /transcript returns one agent's pages for a key in the hall or the departed roll.
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
const CURSOR_API_KEY = process.env.CURSOR_API_KEY || '';
const CURSOR_API_BASE_URL = process.env.CURSOR_API_BASE_URL || 'https://api.cursor.com';
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 7331);
const SCAN_MS = 700;
const CLOUD_POLL_MS = Number(process.env.CLOUD_POLL_MS || 10_000);
const ACTIVE_MS = Number(process.env.ACTIVE_MINUTES || 30) * 60_000; // hide sessions quiet longer than this
const TAIL_BYTES = 512 * 1024; // first read of an existing file only looks at its tail
const DONE_LINGER_MS = 6_000; // after this, stop scanning a finished subagent file (parent keeps it in hall)
const FINISHED_SUBAGENTS_MAX = 24; // per live parent session; oldest finished drop to departed
const GRAVEYARD_MS = Number(process.env.GRAVEYARD_DAYS || 7) * 86_400_000;
const DEPARTED_MAX = Number(process.env.DEPARTED_MAX || 60);
const GRAVEYARD_MAX = Number(process.env.GRAVEYARD_MAX || 100);
const HISTORY_SCAN_MS = Number(process.env.HISTORY_SCAN_MS || 180_000);
const TITLE_REFRESH_MS = 60_000;
const CLOUD_RECONNECT_MS = 1_000;

const INDEX_HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html');
const NAME_MAX = 120;

function defaultAgentKeepDataDir() {
  if (process.env.AGENT_KEEP_DATA_DIR) return process.env.AGENT_KEEP_DATA_DIR;
  if (process.platform === 'darwin') return path.join(HOME, 'Library', 'Application Support', 'TheAgentKeep');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || HOME, 'TheAgentKeep');
  return path.join(HOME, '.local', 'share', 'the-agent-keep');
}

const AGENT_KEEP_DATA_DIR = defaultAgentKeepDataDir();
const NAMES_FILE = path.join(AGENT_KEEP_DATA_DIR, 'names.json');

/** @type {Record<string, string>} agent key -> display name override */
let nameOverrides = {};

function loadNameOverrides() {
  try {
    const parsed = JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8'));
    nameOverrides = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (err) {
    if (err?.code !== 'ENOENT') console.warn(`name overrides: ${err.message}`);
    nameOverrides = {};
  }
}

function saveNameOverrides() {
  fs.mkdirSync(AGENT_KEEP_DATA_DIR, { recursive: true });
  const tmp = path.join(AGENT_KEEP_DATA_DIR, `names.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(nameOverrides, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, NAMES_FILE);
}

function applyTitleOverride(out, canonicalTitle) {
  const raw = canonicalTitle ?? out.title ?? '';
  const custom = nameOverrides[out.key];
  if (custom) {
    out.originalTitle = raw;
    out.title = custom;
    out.renamed = true;
  }
  return out;
}

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
/** Agents that left the hall this run (metadata + transcript lookup). */
const departed = new Map();
/** Threads quiet longer than GRAVEYARD_DAYS (metadata + transcript lookup). */
const graveyard = new Map();
/** Stat-only catalog of older local/cloud sessions not in the live hall. */
const historyDeparted = new Map();
const historyGraveyard = new Map();
let lastHistoryScan = 0;
/** Claude Agent tool_use id -> key of the agent that issued it (for parent links). */
const spawnedBy = new Map();
/** Cursor Cloud agent id (bc-…) -> local agent key that referenced it in a tool call (metadata only). */
const cloudSpawnedBy = new Map();
const CLOUD_ID_RE = /\bbc-[a-zA-Z0-9]+\b/g;

function noteCloudSpawnRefs(parentKey, payload) {
  if (!parentKey || payload == null) return;
  let text;
  try {
    text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  } catch { return; }
  if (!text.includes('bc-')) return;
  CLOUD_ID_RE.lastIndex = 0;
  let m;
  while ((m = CLOUD_ID_RE.exec(text)) !== null) {
    if (!cloudSpawnedBy.has(m[0])) cloudSpawnedBy.set(m[0], parentKey);
  }
}

function linkCloudAgentParent(a) {
  if (a.source !== 'cloud' || !a.id) return;
  const parent = cloudSpawnedBy.get(a.id);
  if (!parent || !agents.has(parent)) return;
  if (a.parentKey !== parent) { a.parentKey = parent; dirty = true; }
}
/** Finished agent key -> file size when it finished; revived only if the file grows. */
const tombstones = new Map();
/** Cloud session key -> active run stream. */
const cloudWatches = new Map();
/** Terminal cloud runs must not reconnect while the agent list catches up. */
const finishedCloudRuns = new Set();
/** Cloud agents whose durable metadata (repository) has been loaded. */
const hydratedCloudAgents = new Set();

let dirty = true;
let cloudPollInFlight = false;
let lastCloudPollAt = null;
let lastCloudPollOk = false;
let lastCloudApiCount = null;
let lastCloudInHall = 0;
let lastCloudLastError = null;

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

function pushIfExists(out, t) {
  const st = safeStat(t.file);
  if (st) out.push({ ...t, size: st.size, mtimeMs: st.mtimeMs });
}

function listAllClaudeSessions() {
  const out = [];
  for (const p of readdir(CLAUDE_ROOT)) {
    if (!p.isDirectory()) continue;
    for (const e of readdir(path.join(CLAUDE_ROOT, p.name))) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        pushIfExists(out, { source: 'claude', file: path.join(CLAUDE_ROOT, p.name, e.name), kind: 'session', slug: p.name, sessionId: e.name.slice(0, -6) });
      }
    }
  }
  return out;
}

function listAllCursorSessions() {
  const out = [];
  for (const p of readdir(CURSOR_ROOT)) {
    if (!p.isDirectory() || p.name.startsWith('.')) continue;
    const dir = path.join(CURSOR_ROOT, p.name, 'agent-transcripts');
    for (const e of readdir(dir)) {
      if (!e.isDirectory()) continue;
      const file = path.join(dir, e.name, `${e.name}.jsonl`);
      pushIfExists(out, { source: 'cursor', file, kind: 'session', slug: p.name, sessionId: e.name });
    }
  }
  return out;
}

function subagentCountForSession(t) {
  let subDir;
  if (t.source === 'claude') {
    subDir = path.join(CLAUDE_ROOT, t.slug, t.sessionId, 'subagents');
  } else {
    subDir = path.join(CURSOR_ROOT, t.slug, 'agent-transcripts', t.sessionId, 'subagents');
  }
  let n = 0;
  for (const s of readdir(subDir)) {
    if (s.name.endsWith('.jsonl')) n++;
  }
  return n;
}

function lastUsedOf(a) {
  return Math.max(a.lastTs ?? 0, a.doneAt ?? 0, a.lastUsedAt ?? 0);
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
 * @property {'claude'|'cursor'|'cloud'} source
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
  read_file: 'reading', codebase_search: 'reading', grep: 'reading', glob: 'reading', web_search: 'reading',
  apply_patch: 'typing', edit_file: 'typing', write_file: 'typing', delete_file: 'typing',
  run_terminal_cmd: 'running', shell: 'running',
  spawn_subagent: 'delegating', task: 'delegating',
};

const QUESTION_TOOLS = new Set(['AskUserQuestion', 'AskQuestion', 'ExitPlanMode']);

function stateForTool(name) {
  if (TOOL_STATE[name]) return TOOL_STATE[name];
  if (name.startsWith('mcp__') || name.toLowerCase() === 'mcp') return 'reading';
  return 'running';
}

function questionText(input) {
  if (!input || typeof input !== 'object') return '';
  if (typeof input.question === 'string' && input.question.trim()) return input.question.trim().slice(0, 2000);
  if (typeof input.prompt === 'string' && input.prompt.trim()) return input.prompt.trim().slice(0, 2000);
  if (Array.isArray(input.questions)) {
    return input.questions
      .map(q => typeof q === 'string' ? q : (q?.prompt || q?.question || ''))
      .filter(Boolean).join('\n').trim().slice(0, 2000);
  }
  return '';
}

function setTool(a, name, input) {
  a.tool = name; a.state = stateForTool(name); a.doneAt = null;
  noteCloudSpawnRefs(a.key, input);
  if (QUESTION_TOOLS.has(name)) {
    a.asked = true;
    a.summons = 'question';
    const q = questionText(input);
    if (q) a.question = q;
  } else {
    a.asked = false;
    a.summons = null;
    a.question = null;
  }
}

function resumeWork(a) {
  a.state = 'thinking'; a.tool = null; a.doneAt = null;
  a.summons = null; a.asked = false; a.question = null;
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
    departed.delete(key);
    graveyard.delete(key);
    historyDeparted.delete(key);
    historyGraveyard.delete(key);
    dirty = true;
  }
  return a;
}

function trimRoll(map, max) {
  if (map.size <= max) return;
  const sorted = [...map.entries()].sort((a, b) => lastUsedOf(b[1]) - lastUsedOf(a[1]));
  map.clear();
  for (const [k, v] of sorted.slice(0, max)) map.set(k, v);
}

function trimDeparted() { trimRoll(departed, DEPARTED_MAX); }
function trimGraveyard() { trimRoll(graveyard, GRAVEYARD_MAX); }
function trimHistoryDeparted() { trimRoll(historyDeparted, DEPARTED_MAX); }
function trimHistoryGraveyard() { trimRoll(historyGraveyard, GRAVEYARD_MAX); }

function rollRecordFromAgent(a, reason, rolledAt = Date.now()) {
  const lastUsedAt = lastUsedOf(a);
  return {
    key: a.key,
    source: a.source,
    kind: a.kind,
    sessionKey: a.sessionKey,
    parentKey: a.parentKey,
    project: a.project,
    title: a.title,
    agentType: a.agentType,
    branch: a.branch,
    state: 'done',
    reason,
    lastUsedAt,
    rolledAt,
    departedAt: rolledAt,
    file: a.file ?? null,
    id: a.id ?? null,
    cloudRunId: a.cloudRunId ?? null,
    pages: a.pages,
    subagentCount: a.subagentCount ?? null,
    summons: null,
    question: null,
    tool: null,
  };
}

function placeOnRoll(a, reason) {
  const rec = rollRecordFromAgent(a, reason);
  departed.delete(a.key);
  graveyard.delete(a.key);
  if (lastUsedOf(a) < Date.now() - GRAVEYARD_MS) {
    graveyard.set(a.key, rec);
    trimGraveyard();
  } else {
    departed.set(a.key, rec);
    trimDeparted();
  }
}

function removeAgent(key, reason) {
  const a = agents.get(key);
  if (!a) return;
  placeOnRoll(a, reason);
  if (a.source === 'cloud') {
    stopCloudWatch(key);
    if (a.id) hydratedCloudAgents.delete(a.id);
  }
  agents.delete(key);
  dirty = true;
}

/** When a parent session leaves the hall, its subagents leave with it. */
function removeSessionTree(sessionKey, reason) {
  const keys = [...agents.keys()].filter(k => {
    const a = agents.get(k);
    return k === sessionKey || (a?.kind === 'subagent' && a.sessionKey === sessionKey);
  });
  for (const k of keys) removeAgent(k, reason);
}

function trimFinishedSubagents(sessionKey) {
  const done = [...agents.values()]
    .filter(a => a.kind === 'subagent' && a.sessionKey === sessionKey && a.state === 'done')
    .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
  for (const a of done.slice(FINISHED_SUBAGENTS_MAX)) removeAgent(a.key, 'cap');
}

function parentSessionLive(sessionKey) {
  const p = agents.get(sessionKey);
  return p?.kind === 'session';
}

function shouldKeepFinishedSubagent(a, now) {
  if (a.kind !== 'subagent' || a.state !== 'done') return false;
  if (!parentSessionLive(a.sessionKey)) return false;
  return true;
}

function agentForKey(key) {
  return agents.get(key)
    || departed.get(key)
    || graveyard.get(key)
    || historyDeparted.get(key)
    || historyGraveyard.get(key)
    || null;
}

function buildHistorySessionEntry(t, lastUsedAt) {
  const key = `${t.source}:${t.slug}/${t.sessionId}`;
  let title = '';
  if (t.source === 'cursor') title = cursorTitle(t.sessionId) || '';
  if (!title && t.source === 'cursor') title = `Cursor chat ${t.sessionId.slice(0, 8)}`;
  return {
    key,
    source: t.source,
    kind: 'session',
    sessionKey: key,
    parentKey: null,
    project: projectFromSlug(t.slug),
    title,
    agentType: null,
    branch: null,
    state: 'done',
    reason: 'quiet',
    lastUsedAt,
    rolledAt: lastUsedAt,
    departedAt: lastUsedAt,
    file: t.file,
    id: t.sessionId,
    cloudRunId: null,
    pages: null,
    subagentCount: subagentCountForSession(t),
    summons: null,
    question: null,
    tool: null,
  };
}

function catalogCloudRollItem(item, lastUsedAt) {
  const key = `cloud:${item.id}`;
  if (agents.has(key) || departed.has(key) || graveyard.has(key)) return;
  const entry = {
    key,
    source: 'cloud',
    kind: 'session',
    sessionKey: key,
    parentKey: null,
    project: cloudProject(item),
    title: item.name || `Cloud agent ${item.id.slice(0, 8)}`,
    agentType: null,
    branch: null,
    state: 'done',
    reason: 'cloud_removed',
    lastUsedAt,
    rolledAt: lastUsedAt,
    departedAt: lastUsedAt,
    file: null,
    id: item.id,
    cloudRunId: item.latestRunId || null,
    pages: null,
    subagentCount: 0,
    summons: null,
    question: null,
    tool: null,
  };
  if (lastUsedAt < Date.now() - GRAVEYARD_MS) historyGraveyard.set(key, entry);
  else historyDeparted.set(key, entry);
}

function refreshHistoryCatalog(now = Date.now()) {
  const activeCut = now - ACTIVE_MS;
  const graveCut = now - GRAVEYARD_MS;
  historyDeparted.clear();
  historyGraveyard.clear();
  const liveKeys = new Set(agents.keys());

  for (const t of [...listAllClaudeSessions(), ...listAllCursorSessions()]) {
    const key = `${t.source}:${t.slug}/${t.sessionId}`;
    if (liveKeys.has(key)) continue;
    if (departed.has(key) || graveyard.has(key)) continue;
    const lastUsedAt = t.mtimeMs;
    if (lastUsedAt >= activeCut) continue;
    const entry = buildHistorySessionEntry(t, lastUsedAt);
    if (lastUsedAt >= graveCut) historyDeparted.set(key, entry);
    else historyGraveyard.set(key, entry);
  }
  trimHistoryDeparted();
  trimHistoryGraveyard();
  lastHistoryScan = now;
  dirty = true;
}

function finishTurn(a, ts) {
  const asked = a.asked;
  a.pending.clear();
  a.tool = null;
  a.asked = false;
  if (a.kind === 'subagent') {
    a.state = 'done'; a.doneAt = a.doneAt ?? ts ?? Date.now();
    a.summons = null; a.question = null;
  } else {
    a.state = 'waiting';
    a.summons = asked ? 'question' : 'turn';
  }
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
      let lastUse = null;
      for (const b of content) {
        if (b.type === 'tool_use') {
          lastUse = b;
          a.pending.set(b.id, { name: b.name, ts: ts ?? Date.now() });
          if (b.name === 'Agent' || b.name === 'Task') spawnedBy.set(b.id, a.key);
          noteCloudSpawnRefs(a.key, b.input);
        }
      }
      const stop = line.message?.stop_reason;
      if (lastUse) setTool(a, lastUse.name, lastUse.input);
      else if (stop === 'end_turn' || stop === 'stop_sequence') finishTurn(a, ts);
      else { a.state = 'thinking'; a.tool = null; a.doneAt = null; }
      return;
    }
    case 'user': {
      const c = line.message?.content;
      if (typeof c === 'string') {
        if (c.startsWith('[Request interrupted')) finishTurn(a, ts);
        else resumeWork(a);
        return;
      }
      if (!Array.isArray(c)) return;
      let sawResult = false;
      for (const b of c) {
        if (b.type === 'tool_result') {
          sawResult = true;
          a.pending.delete(b.tool_use_id);
          noteCloudSpawnRefs(a.key, b.content);
          markClaudeSubagentReturned(b.tool_use_id, ts);
        } else if (b.type === 'text' && b.text?.startsWith('[Request interrupted')) {
          finishTurn(a, ts); return;
        }
      }
      if (sawResult) {
        if (a.pending.size) setTool(a, [...a.pending.values()].pop().name);
        else resumeWork(a);
      } else if (!line.isMeta) resumeWork(a);
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
    resumeWork(a);
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
  setTool(a, last.name, last.args);
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

// ---------- Cursor Cloud API ----------

function cloudApiUrl(route) {
  const base = new URL(CURSOR_API_BASE_URL);
  const loopback = base.hostname === '127.0.0.1' || base.hostname === 'localhost' || base.hostname === '::1';
  if (base.protocol !== 'https:' && !loopback) throw new Error('CURSOR_API_BASE_URL must use HTTPS');
  return new URL(route, base);
}

async function cloudRequest(route, options = {}) {
  const headers = new Headers(options.headers);
  headers.set('authorization', `Basic ${Buffer.from(`${CURSOR_API_KEY}:`).toString('base64')}`);
  const response = await fetch(cloudApiUrl(route), { ...options, headers });
  if (!response.ok) {
    const error = new Error(`Cursor Cloud API ${response.status} ${response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return response;
}

function cloudProject(agent) {
  const raw = agent.repos?.[0]?.url;
  if (!raw) return 'Cursor Cloud';
  try { return path.basename(new URL(raw).pathname.replace(/\.git$/, '')) || 'Cursor Cloud'; }
  catch { return path.basename(raw.replace(/\.git$/, '')) || 'Cursor Cloud'; }
}

function ensureCloudAgent(item) {
  const key = `cloud:${item.id}`;
  let a = agents.get(key);
  if (!a) {
    a = {
      key, source: 'cloud', file: null, kind: 'session', sessionKey: key, parentKey: null, id: item.id,
      project: 'Cursor Cloud', title: item.name || `Cloud agent ${item.id.slice(0, 8)}`,
      agentType: null, branch: null, state: item.status === 'ACTIVE' ? 'thinking' : 'waiting',
      tool: null, pending: new Map(), lastTs: Date.parse(item.updatedAt) || Date.now(), doneAt: null,
    };
    agents.set(key, a);
    departed.delete(key);
    graveyard.delete(key);
    historyDeparted.delete(key);
    historyGraveyard.delete(key);
    dirty = true;
  }
  linkCloudAgentParent(a);
  const runChanged = a.cloudRunId && item.latestRunId && a.cloudRunId !== item.latestRunId;
  if (runChanged) {
    a.pending.clear();
    a.state = 'thinking';
    a.tool = null;
    a.pageOpen = false;
    a.seenCalls = new Set();
  }
  a.title = item.name || a.title;
  a.cloudStatus = item.status;
  a.cloudRunId = item.latestRunId || null;
  a.lastTs = Math.max(a.lastTs, Date.parse(item.updatedAt) || 0);
  return a;
}

async function hydrateCloudAgent(a) {
  if (hydratedCloudAgents.has(a.id)) return;
  hydratedCloudAgents.add(a.id);
  try {
    const response = await cloudRequest(`/v1/agents/${encodeURIComponent(a.id)}`);
    const detail = await response.json();
    a.project = cloudProject(detail);
    dirty = true;
  } catch (err) {
    hydratedCloudAgents.delete(a.id);
    reportCloudPoll(`metadata for ${a.id} failed: ${err.message}`);
  }
}

async function listCloudAgents() {
  const items = [];
  let cursor = null;
  do {
    const query = new URLSearchParams({ limit: '100', includeArchived: 'false' });
    if (cursor) query.set('cursor', cursor);
    const response = await cloudRequest(`/v1/agents?${query}`);
    const body = await response.json();
    if (Array.isArray(body.items)) items.push(...body.items);
    cursor = typeof body.nextCursor === 'string' && body.nextCursor ? body.nextCursor : null;
  } while (cursor);
  return items;
}

// One line per change, so a quiet hall says why without flooding the log.
let lastCloudReport = '';
function reportCloudPoll(message) {
  if (message === lastCloudReport) return;
  lastCloudReport = message;
  console.log(`cursor-cloud: ${message}`);
}

function stopCloudWatch(key) {
  const watch = cloudWatches.get(key);
  if (!watch) return;
  watch.stopped = true;
  watch.controller?.abort();
  cloudWatches.delete(key);
}

function applyCloudEvent(a, event, data) {
  a.lastTs = Date.now();
  if (event === 'assistant' && data.text) noteCloudPage(a, 'scribe', data.text);
  if (event === 'thinking' || event === 'assistant') {
    if (!a.pending.size) { a.state = 'thinking'; a.tool = null; }
  } else if (event === 'tool_call') {
    if (!data.callId || !data.name) return false;
    if (data.status === 'running') {
      const callId = data.callId || data.name;
      a.seenCalls ??= new Set();
      if (!a.seenCalls.has(callId)) {
        a.seenCalls.add(callId);
        noteCloudPage(a, 'tool', toolGlance(data.name, data.args));
        const asked = questionText(data.args);
        if (asked) noteCloudPage(a, 'question', asked);
      }
      a.pending.set(data.callId, { name: data.name, ts: Date.now() });
      setTool(a, data.name, data.args);
    } else if (data.status === 'completed') {
      a.pending.delete(data.callId);
      if (a.pending.size) setTool(a, [...a.pending.values()].at(-1).name);
      else { a.state = 'thinking'; a.tool = null; }
    }
  } else if (event === 'result') {
    if (data.text) {
      a.pageOpen = false;
      const last = a.pages?.at(-1);
      if (!(last?.role === 'scribe' && last.text.trim() === String(data.text).trim())) noteCloudPage(a, 'scribe', data.text);
    }
    const branch = data.git?.branches?.[0];
    if (branch?.repoUrl) a.project = path.basename(branch.repoUrl.replace(/\.git$/, ''));
    if (branch?.branch) a.branch = branch.branch;
    finishTurn(a, Date.now());
    finishedCloudRuns.add(`${a.id}/${data.runId || a.cloudRunId}`);
    dirty = true;
    return true;
  } else if (event === 'done') {
    finishTurn(a, Date.now());
    finishedCloudRuns.add(`${a.id}/${a.cloudRunId}`);
    dirty = true;
    return true;
  }
  dirty = true;
  return false;
}

async function consumeCloudStream(response, a, watch) {
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += Buffer.from(chunk).toString('utf8').replace(/\r\n/g, '\n');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = 'message', dataText = '', id = null;
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataText += line.slice(5).trim();
        else if (line.startsWith('id:')) id = line.slice(3).trim();
      }
      if (id) watch.lastEventId = id;
      if (!dataText) continue;
      let data;
      try { data = JSON.parse(dataText); } catch { continue; }
      if (applyCloudEvent(a, event, data)) return true;
    }
  }
  return false;
}

async function watchCloudRun(a, runId) {
  const prior = cloudWatches.get(a.key);
  if (prior?.runId === runId) return;
  if (prior) stopCloudWatch(a.key);
  const watch = { runId, controller: null, lastEventId: null, stopped: false };
  cloudWatches.set(a.key, watch);

  while (!watch.stopped && !finishedCloudRuns.has(`${a.id}/${runId}`)) {
    watch.controller = new AbortController();
    try {
      const headers = { accept: 'text/event-stream' };
      if (watch.lastEventId) headers['last-event-id'] = watch.lastEventId;
      const response = await cloudRequest(
        `/v1/agents/${encodeURIComponent(a.id)}/runs/${encodeURIComponent(runId)}/stream`,
        { headers, signal: watch.controller.signal },
      );
      if (await consumeCloudStream(response, a, watch)) break;
    } catch (err) {
      if (watch.stopped || err.name === 'AbortError') break;
      if (err.status === 410) {
        finishTurn(a, Date.now());
        finishedCloudRuns.add(`${a.id}/${runId}`);
        dirty = true;
        break;
      }
      console.warn(`Cursor Cloud stream for ${a.id} failed: ${err.message}`);
    }
    if (!watch.stopped) await new Promise(resolve => setTimeout(resolve, CLOUD_RECONNECT_MS));
  }
  if (cloudWatches.get(a.key) === watch) cloudWatches.delete(a.key);
}

async function pollCloudAgents() {
  if (!CURSOR_API_KEY || cloudPollInFlight) return;
  cloudPollInFlight = true;
  try {
    lastCloudLastError = null;
    const items = await listCloudAgents();
    lastCloudApiCount = items.length;
    const seen = new Set();
    const currentRuns = new Set();
    let hidden = 0;
    for (const item of items) {
      if (!item.id) continue;
      const updatedAt = Date.parse(item.updatedAt) || 0;
      if (item.status !== 'ACTIVE' && Date.now() - updatedAt > ACTIVE_MS) {
        catalogCloudRollItem(item, updatedAt);
        hidden++;
        continue;
      }
      const a = ensureCloudAgent(item);
      seen.add(a.key);
      void hydrateCloudAgent(a);
      if (item.status === 'ACTIVE' && item.latestRunId) {
        const runKey = `${a.id}/${item.latestRunId}`;
        currentRuns.add(runKey);
        if (!finishedCloudRuns.has(runKey)) {
          if (a.state === 'waiting') resumeWork(a);
          void watchCloudRun(a, item.latestRunId);
        }
      } else {
        stopCloudWatch(a.key);
        if (item.status === 'IDLE' && a.state !== 'waiting' && !(a.replyUntil > Date.now())) finishTurn(a, updatedAt || Date.now());
      }
    }
    for (const [key, a] of agents) {
      if (a.source === 'cloud' && !seen.has(key)) removeAgent(key, 'cloud_removed');
    }
    for (const runKey of finishedCloudRuns) {
      if (!currentRuns.has(runKey)) finishedCloudRuns.delete(runKey);
    }
    lastCloudInHall = seen.size;
    lastCloudPollOk = true;
    lastCloudPollAt = Date.now();
    reportCloudPoll(`${items.length} agent(s) from the API, ${seen.size} in the hall` +
      (hidden ? `, ${hidden} quiet longer than ${ACTIVE_MS / 60_000}m (raise ACTIVE_MINUTES to see them)` : ''));
  } catch (err) {
    const hint = err.status === 401 || err.status === 403
      ? ' — check CURSOR_API_KEY in Cursor Dashboard → API Keys'
      : '';
    lastCloudPollOk = false;
    lastCloudPollAt = Date.now();
    lastCloudLastError = `${err.message}${hint}`;
    reportCloudPoll(`request failed: ${err.message}${hint}`);
  } finally {
    cloudPollInFlight = false;
  }
}

/** Move runtime roll entries when they cross GRAVEYARD_DAYS without a restart. */
function rebucketRuntimeRolls(now = Date.now()) {
  const graveCut = now - GRAVEYARD_MS;
  let moved = false;
  for (const [key, rec] of [...departed.entries()]) {
    if (lastUsedOf(rec) < graveCut) {
      departed.delete(key);
      graveyard.set(key, rec);
      moved = true;
    }
  }
  if (moved) trimGraveyard();
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
    if (a.source === 'cloud') continue;
    if (a.source === 'claude' && a.kind === 'subagent' && a.toolUseId && spawnedBy.has(a.toolUseId)) {
      a.parentKey = spawnedBy.get(a.toolUseId);
    }
    if (a.source === 'cursor') {
      if (a.kind === 'subagent') matchCursorSubagent(a);
      refreshCursorTitle(a, now);
    }
    const tooOld = now - a.lastTs > ACTIVE_MS;
    const doneLongAgo = a.state === 'done' && now - Math.max(a.doneAt ?? 0, a.lastTs) > DONE_LINGER_MS;
    if (doneLongAgo) tombstones.set(key, cursors.get(a.file)?.offset ?? 0);

    if (shouldKeepFinishedSubagent(a, now)) {
      trimFinishedSubagents(a.sessionKey);
      continue;
    }

    if (a.kind === 'session' && (!seen.has(key) || tooOld)) {
      removeSessionTree(key, tooOld ? 'quiet' : 'vanished');
      continue;
    }

    if (!seen.has(key) || tooOld || (a.kind !== 'subagent' && doneLongAgo)) {
      const reason = doneLongAgo ? 'done' : tooOld ? 'quiet' : 'vanished';
      removeAgent(key, reason);
    }
  }
  // A subagent whose session vanished has nowhere to sit.
  for (const [key, a] of agents) {
    if (a.kind === 'subagent' && !agents.has(a.sessionKey)) removeAgent(key, 'orphan');
  }
  for (const a of agents.values()) {
    if (a.kind === 'session') trimFinishedSubagents(a.key);
  }
  for (const a of agents.values()) {
    if (a.source === 'cloud') linkCloudAgentParent(a);
  }
}

function publicAgent(a, now) {
  const oldestPending = [...a.pending.values()].reduce((m, p) => Math.min(m, p.ts), Infinity);
  const pendingForMs = Number.isFinite(oldestPending) ? now - oldestPending : 0;
  const out = {
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
    tool: a.state === 'done' ? null : a.tool,
    summons: a.state === 'waiting' ? (a.summons || 'turn') : null,
    pendingForMs: a.state === 'done' ? 0 : pendingForMs,
    idleForMs: now - a.lastTs,
  };
  if (a.state === 'done' && a.doneAt) {
    out.doneAt = a.doneAt;
    out.finishedForMs = now - a.doneAt;
  }
  return out;
}

function publicRollEntry(d, now) {
  const lastUsedAt = d.lastUsedAt ?? d.departedAt ?? d.lastTs ?? now;
  return {
    key: d.key,
    source: d.source,
    kind: d.kind,
    parentKey: d.parentKey,
    sessionKey: d.sessionKey,
    project: d.project,
    title: d.title,
    agentType: d.agentType,
    branch: d.branch,
    state: 'done',
    tool: null,
    summons: null,
    reason: d.reason,
    lastUsedAt,
    lastUsedForMs: now - lastUsedAt,
    departedAt: d.departedAt ?? lastUsedAt,
    departedForMs: now - (d.departedAt ?? lastUsedAt),
    subagentCount: d.subagentCount ?? null,
  };
}

function mergeRoll(runtime, history, now, max) {
  const live = new Set(agents.keys());
  const m = new Map();
  for (const e of history.values()) {
    if (!live.has(e.key)) m.set(e.key, applyTitleOverride(publicRollEntry(e, now), e.title));
  }
  for (const e of runtime.values()) {
    if (!live.has(e.key)) m.set(e.key, applyTitleOverride(publicRollEntry(e, now), e.title));
  }
  return [...m.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, max);
}

function cloudSnapshot() {
  return {
    enabled: !!CURSOR_API_KEY,
    lastPollAt: lastCloudPollAt,
    lastPollOk: lastCloudPollOk,
    apiCount: lastCloudApiCount,
    inHall: lastCloudInHall,
    lastError: lastCloudLastError,
  };
}

function snapshot() {
  const now = Date.now();
  if (now - lastHistoryScan >= HISTORY_SCAN_MS) {
    try { refreshHistoryCatalog(now); } catch (err) { console.error('history catalog failed:', err); }
  }
  rebucketRuntimeRolls(now);
  return {
    now,
    agents: [...agents.values()].map(a => applyTitleOverride(publicAgent(a, now), a.title)),
    departed: mergeRoll(departed, historyDeparted, now, DEPARTED_MAX),
    graveyard: mergeRoll(graveyard, historyGraveyard, now, GRAVEYARD_MAX),
    cloud: cloudSnapshot(),
  };
}

// ---------- tome pages (on request, never on the live feed) ----------

const TRANSCRIPT_TAIL = 1024 * 1024;
const PAGE_CHARS = 8_000;
const MAX_PAGES = 160;

function clipTail(text, max = PAGE_CHARS) {
  const t = String(text ?? '').replace(/\u0000/g, '');
  if (t.length <= max) return t;
  return '…\n' + t.slice(-max);
}

function visibleUserText(text) {
  let s = String(text ?? '');
  const query = s.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  if (query) s = query[1];
  s = s.replace(/<timestamp>[\s\S]*?<\/timestamp>/g, '');
  s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  s = s.replace(/<system_reminder>[\s\S]*?<\/system_reminder>/g, '');
  return s.trim();
}

function toolGlance(name, input) {
  const inp = input && typeof input === 'object' ? input : {};
  const target = inp.path || inp.file_path || inp.target_file || inp.command || inp.pattern || inp.query || inp.glob || inp.url || '';
  const bit = String(target).replace(/\s+/g, ' ').trim().slice(0, 160);
  return bit ? `${name} — ${bit}` : String(name || 'tool');
}

function noteCloudPage(a, role, text) {
  const chunk = String(text ?? '').replace(/\u0000/g, '');
  if (!chunk) return;
  const pages = a.pages ??= [];
  const last = pages.at(-1);
  if (role === 'scribe' && last?.role === 'scribe' && a.pageOpen) {
    last.text = clipTail(last.text + chunk);
    return;
  }
  pages.push({ role, text: clipTail(chunk) });
  a.pageOpen = role === 'scribe';
  if (pages.length > MAX_PAGES) pages.splice(0, pages.length - MAX_PAGES);
}

function readTranscriptLines(file) {
  const st = safeStat(file);
  if (!st) return { lines: [], partial: false };
  const partial = st.size > TRANSCRIPT_TAIL;
  const start = partial ? st.size - TRANSCRIPT_TAIL : 0;
  const buf = Buffer.alloc(st.size - start);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, buf.length, start);
  } catch { return { lines: [], partial }; } finally { if (fd !== undefined) fs.closeSync(fd); }
  let text = buf.toString('utf8');
  if (partial) text = text.slice(text.indexOf('\n') + 1);
  const lines = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { lines.push(JSON.parse(line)); } catch { /* unknown line */ }
  }
  return { lines, partial };
}

function pushPage(out, role, text) {
  const body = clipTail(text).trim();
  if (body) out.push({ role, text: body });
}

function pushQuestion(out, name, input) {
  if (QUESTION_TOOLS.has(name)) pushPage(out, 'question', questionText(input));
}

function pagesFromClaude(lines) {
  const out = [];
  for (const line of lines) {
    if (line.type === 'user') {
      const content = line.message?.content;
      const raw = typeof content === 'string'
        ? content
        : Array.isArray(content) ? content.filter(b => b?.type === 'text').map(b => b.text || '').join('\n') : '';
      const text = visibleUserText(raw);
      if (!text || text.startsWith('[Request interrupted')) continue;
      if (line.isMeta && !raw.includes('<user_query>')) continue;
      pushPage(out, 'you', text);
    } else if (line.type === 'assistant') {
      const content = Array.isArray(line.message?.content) ? line.message.content : [];
      pushPage(out, 'scribe', content.filter(b => b?.type === 'text' && b.text).map(b => b.text).join('\n'));
      for (const block of content) if (block?.type === 'tool_use') {
        pushPage(out, 'tool', toolGlance(block.name, block.input));
        pushQuestion(out, block.name, block.input);
      }
    }
  }
  return out;
}

function pagesFromCursor(lines) {
  const out = [];
  for (const line of lines) {
    const content = line.message?.content;
    if (!Array.isArray(content)) continue;
    if (line.role === 'user') pushPage(out, 'you', visibleUserText(textOf(content)));
    else if (line.role === 'assistant') {
      pushPage(out, 'scribe', content.filter(b => b?.type === 'text' && b.text).map(b => b.text).join('\n'));
      for (const block of content) {
        if (block?.type !== 'tool_use') continue;
        const tool = cursorTool(block);
        pushPage(out, 'tool', toolGlance(tool.name, tool.args));
        pushQuestion(out, tool.name, tool.args);
      }
    }
  }
  return out;
}

async function earlierCloudPages(a) {
  try {
    const response = await cloudRequest(`/v1/agents/${encodeURIComponent(a.id)}/runs?limit=6`);
    const body = await response.json();
    const items = Array.isArray(body.items) ? body.items : [];
    const terminal = items.filter(item => item.id && item.id !== a.cloudRunId && ['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED'].includes(item.status));
    const pages = [];
    for (const item of terminal.slice(0, 5).reverse()) {
      try {
        const runRes = await cloudRequest(`/v1/agents/${encodeURIComponent(a.id)}/runs/${encodeURIComponent(item.id)}`);
        const run = await runRes.json();
        if (run.result) pushPage(pages, 'scribe', run.result);
      } catch { /* this run has no readable result */ }
    }
    return pages;
  } catch { return []; }
}

async function transcriptFor(a) {
  let entries = [];
  let partial = false;
  if (a.source === 'cloud') {
    const earlier = await (a.earlierPromise ??= earlierCloudPages(a));
    entries = [...earlier, ...(a.pages ?? [])];
    if (!entries.some(e => e.role === 'scribe') && a.cloudRunId) {
      try {
        const response = await cloudRequest(`/v1/agents/${encodeURIComponent(a.id)}/runs/${encodeURIComponent(a.cloudRunId)}`);
        const run = await response.json();
        if (run.result) pushPage(entries, 'scribe', run.result);
      } catch { /* the live pages are the tome */ }
    }
  } else if (a.file) {
    const read = readTranscriptLines(a.file);
    partial = read.partial;
    entries = a.source === 'claude' ? pagesFromClaude(read.lines) : pagesFromCursor(read.lines);
  }
  if (a.summons === 'question' && a.question && !entries.some(entry => entry.role === 'question' && entry.text === a.question)) {
    pushPage(entries, 'question', a.question);
  }
  if (entries.length > MAX_PAGES) {
    entries = entries.slice(-MAX_PAGES);
    partial = true;
  }
  const body = {
    key: a.key,
    title: a.title,
    source: a.source,
    tool: a.tool,
    state: a.state,
    partial,
    entries,
  };
  return applyTitleOverride(body, a.title);
}

function readBody(req, max = 8_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function sendRename(req, res) {
  const json = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  let body;
  try { body = JSON.parse(await readBody(req) || '{}'); }
  catch (err) {
    res.writeHead(err.status || 400, json).end(JSON.stringify({ error: 'invalid body' }));
    return;
  }
  const key = typeof body.key === 'string' ? body.key : '';
  const agent = agentForKey(key);
  if (!agent) {
    res.writeHead(404, json).end(JSON.stringify({ error: 'not listed' }));
    return;
  }
  let name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length > NAME_MAX) name = name.slice(0, NAME_MAX);
  if (!name) delete nameOverrides[key];
  else nameOverrides[key] = name;
  saveNameOverrides();
  dirty = true;
  const pub = applyTitleOverride({ key, title: agent.title }, agent.title);
  res.writeHead(200, json).end(JSON.stringify({
    ok: true,
    key,
    title: pub.title,
    originalTitle: pub.originalTitle ?? null,
    renamed: !!pub.renamed,
  }));
}

async function sendReply(req, res) {
  const json = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  let body;
  try { body = JSON.parse(await readBody(req) || '{}'); }
  catch (err) {
    res.writeHead(err.status || 400, json).end(JSON.stringify({ error: 'the reply could not be read' }));
    return;
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    res.writeHead(400, json).end(JSON.stringify({ error: 'the page is blank' }));
    return;
  }
  const agent = agents.get(typeof body.key === 'string' ? body.key : '');
  if (!agent) {
    res.writeHead(404, json).end(JSON.stringify({ error: 'not in the hall' }));
    return;
  }
  if (agent.source !== 'cloud' || !agent.id) {
    res.writeHead(409, json).end(JSON.stringify({ error: 'this house has no way to carry a reply' }));
    return;
  }
  if (agent.state !== 'waiting') {
    res.writeHead(409, json).end(JSON.stringify({ error: 'the scribe is still at work' }));
    return;
  }
  try {
    const response = await cloudRequest(`/v1/agents/${encodeURIComponent(agent.id)}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: { text: text.slice(0, 4000) } }),
    });
    const payload = await response.json();
    noteCloudPage(agent, 'you', text.slice(0, 4000));
    agent.cloudRunId = payload.run?.id || agent.cloudRunId;
    agent.cloudStatus = 'ACTIVE';
    agent.replyUntil = Date.now() + 20_000;
    resumeWork(agent);
    agent.lastTs = Date.now();
    dirty = true;
    res.writeHead(202, json).end(JSON.stringify({ ok: true, runId: payload.run?.id || null }));
  } catch (err) {
    const busy = err.status === 409;
    res.writeHead(busy ? 409 : 502, json).end(JSON.stringify({
      error: busy ? 'the scribe is still at work' : 'the reply did not leave the hall',
    }));
  }
}

// ---------- http + SSE ----------

const clients = new Set();

function allowedHost(req) {
  // Blocks DNS-rebinding: only answer requests addressed to loopback names.
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  return host === '127.0.0.1' || host === 'localhost';
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error('request failed:', err);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }).end('The scribe could not open that tome.');
  });
});

async function handle(req, res) {
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
  if (url.pathname === '/reply' && req.method === 'POST') {
    await sendReply(req, res);
    return;
  }
  if (url.pathname === '/rename' && req.method === 'POST') {
    await sendRename(req, res);
    return;
  }
  if (url.pathname === '/transcript') {
    const agent = agentForKey(url.searchParams.get('key') || '');
    if (!agent) {
      res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ error: 'not in the hall' }));
      return;
    }
    const body = await transcriptFor(agent);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
    return;
  }
  res.writeHead(404).end();
}

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

loadNameOverrides();
scan();
try { refreshHistoryCatalog(); } catch (err) { console.error('history catalog failed:', err); }
if (CURSOR_API_KEY) {
  pollCloudAgents().catch(err => console.error(`Cursor Cloud poll failed: ${err.message}`));
  setInterval(() => {
    pollCloudAgents().catch(err => console.error(`Cursor Cloud poll failed: ${err.message}`));
  }, CLOUD_POLL_MS);
}
server.listen(PORT, HOST, () => {
  console.log(`The Agent Keep is watching:`);
  console.log(`  Claude Code  ${CLAUDE_ROOT}`);
  console.log(`  Cursor       ${CURSOR_ROOT}${sqlite && fs.existsSync(CURSOR_DB) ? '' : '  (chat titles unavailable)'}`);
  console.log(`  Cursor Cloud ${CURSOR_API_KEY ? `enabled (polling every ${CLOUD_POLL_MS / 1000}s)` : 'disabled (set CURSOR_API_KEY)'}`);
  console.log(`Open http://${HOST}:${PORT}`);
});
