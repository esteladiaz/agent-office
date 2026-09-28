import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DAY = 86_400_000;

const listen = async (server) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
};

const eventually = async (probe, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { return await probe(); } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw lastError || new Error('condition not met');
};

test('history tiers: ancient thread in graveyard, recent quiet in departed', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-keep-grave-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const oldId = 'sess-old';
  const midId = 'sess-mid';
  const now = Date.now();
  const oldDir = path.join(dir, 'cursor', 'acme', 'agent-transcripts', oldId);
  const midDir = path.join(dir, 'cursor', 'acme', 'agent-transcripts', midId);
  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(midDir, { recursive: true });
  const oldFile = path.join(oldDir, `${oldId}.jsonl`);
  const midFile = path.join(midDir, `${midId}.jsonl`);
  fs.writeFileSync(oldFile, JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'Ancient' }] } }) + '\n');
  fs.writeFileSync(midFile, JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'Recent quiet' }] } }) + '\n');
  fs.utimesSync(oldFile, (now - 8 * DAY) / 1000, (now - 8 * DAY) / 1000);
  fs.utimesSync(midFile, (now - 2 * DAY) / 1000, (now - 2 * DAY) / 1000);

  const portServer = http.createServer();
  const appPort = await listen(portServer);
  await new Promise(resolve => portServer.close(resolve));

  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      ACTIVE_MINUTES: '30',
      GRAVEYARD_DAYS: '7',
      HISTORY_SCAN_MS: '100',
      CLAUDE_PROJECTS_DIR: path.join(dir, 'claude-missing'),
      CURSOR_API_KEY: '',
      CURSOR_PROJECTS_DIR: path.join(dir, 'cursor'),
      CURSOR_STATE_DB: '',
      PORT: String(appPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });

  const base = `http://127.0.0.1:${appPort}`;
  const oldKey = `cursor:acme/${oldId}`;
  const midKey = `cursor:acme/${midId}`;

  await eventually(async () => {
    const state = await (await fetch(`${base}/state`)).json();
    assert.ok(Array.isArray(state.graveyard));
    assert.ok(Array.isArray(state.departed));
    assert.ok(!state.agents.some(a => a.key === oldKey));
    assert.ok(!state.agents.some(a => a.key === midKey));
    assert.ok(state.graveyard.some(a => a.key === oldKey), JSON.stringify(state.graveyard));
    assert.ok(state.departed.some(a => a.key === midKey), JSON.stringify(state.departed));
    const blob = JSON.stringify(state);
    assert.doesNotMatch(blob, /Ancient/);
    assert.doesNotMatch(blob, /Recent quiet/);
  });
});

test('runtime departed re-buckets to archive after GRAVEYARD_DAYS on snapshot', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-keep-rebucket-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessionId = 'sess-rebucket';
  const sessionDir = path.join(dir, 'cursor', 'acme', 'agent-transcripts', sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);
  fs.writeFileSync(sessionFile, JSON.stringify({
    role: 'user',
    message: { content: [{ type: 'text', text: 'Hello' }] },
  }) + '\n');

  const portServer = http.createServer();
  const appPort = await listen(portServer);
  await new Promise(resolve => portServer.close(resolve));

  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      ACTIVE_MINUTES: '30',
      GRAVEYARD_DAYS: '0.00001',
      HISTORY_SCAN_MS: '60000',
      CLAUDE_PROJECTS_DIR: path.join(dir, 'claude-missing'),
      CURSOR_API_KEY: '',
      CURSOR_PROJECTS_DIR: path.join(dir, 'cursor'),
      CURSOR_STATE_DB: '',
      PORT: String(appPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });

  const base = `http://127.0.0.1:${appPort}`;
  const key = `cursor:acme/${sessionId}`;

  await eventually(async () => {
    const state = await (await fetch(`${base}/state`)).json();
    assert.ok(state.agents.some(a => a.key === key));
  });

  fs.unlinkSync(sessionFile);
  await eventually(async () => {
    const state = await (await fetch(`${base}/state`)).json();
    assert.ok(!state.agents.some(a => a.key === key));
    assert.ok(state.departed.some(a => a.key === key), JSON.stringify(state.departed));
    assert.ok(!state.graveyard.some(a => a.key === key));
  });

  await new Promise(resolve => setTimeout(resolve, 1200));

  await eventually(async () => {
    const state = await (await fetch(`${base}/state`)).json();
    assert.ok(!state.departed.some(a => a.key === key), JSON.stringify(state.departed));
    assert.ok(state.graveyard.some(a => a.key === key), JSON.stringify(state.graveyard));
  });
});
