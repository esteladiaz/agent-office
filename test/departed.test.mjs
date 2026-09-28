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

test('departed roll keeps metadata and transcript after a subagent walks out', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-keep-departed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessionId = 'sess-depart';
  const subId = 'sub-depart';
  const sessionDir = path.join(dir, 'cursor', 'acme', 'agent-transcripts', sessionId);
  fs.mkdirSync(path.join(sessionDir, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(sessionDir, `${sessionId}.jsonl`), [
    JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'Spawn a helper' }] } }),
    JSON.stringify({ role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Task', input: { prompt: 'Do the thing', subagent_type: 'generalPurpose', description: 'Helper monk' } }] } }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(sessionDir, 'subagents', `${subId}.jsonl`), [
    JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'Do the thing' }] } }),
    JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'The deed is done.' }] } }),
    JSON.stringify({ type: 'turn_ended', status: 'success' }),
  ].join('\n') + '\n');

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
  const subKey = `cursor:acme/${sessionId}/${subId}`;

  await eventually(async () => {
    const state = await (await fetch(`${base}/state`)).json();
    assert.ok(Array.isArray(state.departed));
    assert.ok(state.agents.some(a => a.key === subKey && a.state === 'done'), JSON.stringify(state.agents));
  });

  await new Promise(resolve => setTimeout(resolve, 6_500));

  await eventually(async () => {
    const state = await (await fetch(`${base}/state`)).json();
    assert.ok(state.agents.some(a => a.key === subKey && a.state === 'done'), 'finished subagent rests in hall while parent lives');
    assert.ok(!state.departed.some(a => a.key === subKey));
    assert.doesNotMatch(JSON.stringify(state), /The deed is done/);
  });

  // Parent session leaves → subagent goes to departed with transcript still on disk.
  fs.unlinkSync(path.join(sessionDir, `${sessionId}.jsonl`));
  await eventually(async () => {
    const state = await (await fetch(`${base}/state`)).json();
    assert.ok(!state.agents.some(a => a.key === subKey), 'subagent should leave with parent');
    const row = state.departed.find(a => a.key === subKey);
    assert.ok(row, 'subagent should appear on the departed roll');
    assert.equal(row.state, 'done');
    assert.ok(row.departedForMs >= 0);
    assert.doesNotMatch(JSON.stringify(state), /The deed is done/);
  }, 10_000);

  const tome = await (await fetch(`${base}/transcript?key=${encodeURIComponent(subKey)}`)).json();
  assert.match(tome.entries.map(e => e.text).join('\n'), /The deed is done/);
});
