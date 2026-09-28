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

const eventually = async (probe, timeoutMs = 12_000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { return await probe(); } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw lastError || new Error('condition not met');
};

test('finished subagent stays on /state under live parent after linger', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-keep-finished-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessionId = 'sess-finish';
  const subId = 'sub-finish';
  const sessionDir = path.join(dir, 'cursor', 'acme', 'agent-transcripts', sessionId);
  fs.mkdirSync(path.join(sessionDir, 'subagents'), { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(sessionDir, `${sessionId}.jsonl`), [
    JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'Spawn helper' }] } }),
    JSON.stringify({ role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Task', input: { prompt: 'Work', subagent_type: 'generalPurpose', description: 'Helper' } }] } }),
  ].join('\n') + '\n');
  fs.utimesSync(path.join(sessionDir, `${sessionId}.jsonl`), now / 1000, now / 1000);
  fs.writeFileSync(path.join(sessionDir, 'subagents', `${subId}.jsonl`), [
    JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'Work' }] } }),
    JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'SECRET_TRANSCRIPT_LEAK_MARKER' }] } }),
    JSON.stringify({ type: 'turn_ended', status: 'success' }),
  ].join('\n') + '\n');
  fs.utimesSync(path.join(sessionDir, 'subagents', `${subId}.jsonl`), now / 1000, now / 1000);

  const portServer = http.createServer();
  const appPort = await listen(portServer);
  await new Promise(resolve => portServer.close(resolve));

  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
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
  const sessionKey = `cursor:acme/${sessionId}`;
  const subKey = `${sessionKey}/${subId}`;

  await eventually(async () => {
    const state = await (await fetch(`${base}/state`)).json();
    assert.ok(state.agents.some(a => a.key === subKey && a.state === 'done'));
  });

  await new Promise(resolve => setTimeout(resolve, 6_500));

  await eventually(async () => {
    const state = await (await fetch(`${base}/state`)).json();
    assert.ok(state.agents.some(a => a.key === sessionKey), 'parent session still in hall');
    const sub = state.agents.find(a => a.key === subKey);
    assert.ok(sub, 'finished subagent still in hall');
    assert.equal(sub.state, 'done');
    assert.ok(sub.doneAt);
    assert.ok(sub.finishedForMs >= 0);
    assert.ok(!state.departed.some(a => a.key === subKey));
    const blob = JSON.stringify(state);
    assert.doesNotMatch(blob, /SECRET_TRANSCRIPT_LEAK_MARKER/);
    assert.doesNotMatch(blob, /Work/);
  });

  const tome = await (await fetch(`${base}/transcript?key=${encodeURIComponent(subKey)}`)).json();
  assert.match(tome.entries.map(e => e.text).join('\n'), /SECRET_TRANSCRIPT_LEAK_MARKER/);
});
