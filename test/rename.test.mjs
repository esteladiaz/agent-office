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

const listen = async (server) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
};

const eventually = async (probe, timeoutMs = 8_000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { return await probe(); } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw lastError || new Error('condition not met');
};

test('POST /rename overrides display title for listed keys only', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-keep-rename-'));
  const dataDir = path.join(dir, 'agent-keep-data');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const sessionId = 'sess-rename';
  const sessionDir = path.join(dir, 'cursor', 'acme', 'agent-transcripts', sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, `${sessionId}.jsonl`), JSON.stringify({
    role: 'user',
    message: { content: [{ type: 'text', text: 'Original title thread' }] },
  }) + '\n');

  const portServer = http.createServer();
  const appPort = await listen(portServer);
  await new Promise(resolve => portServer.close(resolve));

  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      AGENT_KEEP_DATA_DIR: dataDir,
      ACTIVE_MINUTES: '30',
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

  const renameRes = await fetch(`${base}/rename`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, name: 'My custom label' }),
  });
  assert.equal(renameRes.status, 200);
  const renamed = await renameRes.json();
  assert.equal(renamed.title, 'My custom label');
  assert.ok(renamed.renamed);
  assert.ok(renamed.originalTitle);

  await eventually(async () => {
    const state = await (await fetch(`${base}/state`)).json();
    const row = state.agents.find(a => a.key === key);
    assert.ok(row, JSON.stringify(state.agents));
    assert.equal(row.title, 'My custom label');
    assert.equal(row.renamed, true);
    assert.ok(row.originalTitle);
  });

  const bad = await fetch(`${base}/rename`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'cursor:missing/nope', name: 'X' }),
  });
  assert.equal(bad.status, 404);

  const clear = await fetch(`${base}/rename`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, name: '' }),
  });
  assert.equal(clear.status, 200);
  const cleared = await clear.json();
  assert.ok(!cleared.renamed);

  await eventually(async () => {
    const state = await (await fetch(`${base}/state`)).json();
    const row = state.agents.find(a => a.key === key);
    assert.ok(row);
    assert.equal(row.renamed, undefined);
    assert.equal(row.originalTitle, undefined);
  });

  assert.ok(fs.existsSync(path.join(dataDir, 'names.json')));
});
