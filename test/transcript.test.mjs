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

const eventually = async (probe, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { return await probe(); } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw lastError || new Error('condition not met');
};

test('opens a local tome without putting its pages on the live feed', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-keep-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const claudeSlug = '-work-door';
  const claudeId = 'demo-door';
  const claudeDir = path.join(dir, 'claude', claudeSlug);
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, `${claudeId}.jsonl`), [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Please paint the door red' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: 'I will paint the door.' },
      { type: 'tool_use', id: 't1', name: 'Edit', input: { path: 'door.txt' } },
    ] } }),
  ].join('\n') + '\n');

  const cursorId = 'c0ffee00-demo-4000-8000-000000000009';
  const cursorDir = path.join(dir, 'cursor', 'acme', 'agent-transcripts', cursorId);
  fs.mkdirSync(cursorDir, { recursive: true });
  fs.writeFileSync(path.join(cursorDir, `${cursorId}.jsonl`), [
    JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<timestamp>now</timestamp>\n<user_query>\nWhy is the door stuck?\n</user_query>' }] } }),
    JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'The hinge is rusted.' }] } }),
  ].join('\n') + '\n');

  const portServer = http.createServer();
  const appPort = await listen(portServer);
  await new Promise(resolve => portServer.close(resolve));

  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      ACTIVE_MINUTES: '30',
      CLAUDE_PROJECTS_DIR: path.join(dir, 'claude'),
      CURSOR_API_KEY: '',
      CURSOR_PROJECTS_DIR: path.join(dir, 'cursor'),
      CURSOR_STATE_DB: '',
      PORT: String(appPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childOutput = '';
  child.stdout.on('data', chunk => { childOutput += chunk; });
  child.stderr.on('data', chunk => { childOutput += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });

  const base = `http://127.0.0.1:${appPort}`;
  const claudeKey = `claude:${claudeSlug}/${claudeId}`;
  const cursorKey = `cursor:acme/${cursorId}`;

  await eventually(async () => {
    const state = await (await fetch(`${base}/state`)).json();
    assert.ok(state.agents.some(agent => agent.key === claudeKey), childOutput);
    assert.ok(state.agents.some(agent => agent.key === cursorKey), childOutput);
    assert.doesNotMatch(JSON.stringify(state), /paint the door|hinge is rusted/);
  });

  const claudeTome = await (await fetch(`${base}/transcript?key=${encodeURIComponent(claudeKey)}`)).json();
  assert.deepEqual(claudeTome.entries.map(entry => entry.role), ['you', 'scribe', 'tool']);
  assert.match(claudeTome.entries[0].text, /Please paint the door red/);
  assert.match(claudeTome.entries[1].text, /I will paint the door/);
  assert.match(claudeTome.entries[2].text, /Edit — door\.txt/);

  const cursorTome = await (await fetch(`${base}/transcript?key=${encodeURIComponent(cursorKey)}`)).json();
  assert.equal(cursorTome.entries[0].text, 'Why is the door stuck?');
  assert.match(cursorTome.entries[1].text, /The hinge is rusted/);
  assert.doesNotMatch(cursorTome.entries[0].text, /timestamp|user_query/);

  const missing = await fetch(`${base}/transcript?key=${encodeURIComponent('claude:nope/nope')}`);
  assert.equal(missing.status, 404);

  const state = await (await fetch(`${base}/state`)).json();
  assert.doesNotMatch(JSON.stringify(state), /paint the door|hinge is rusted|door\.txt/);

  const refused = await fetch(`${base}/reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: claudeKey, text: 'Paint it blue' }),
  });
  assert.equal(refused.status, 409);
});

test('a question bell names the question without putting it on the live feed', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-keep-bell-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const id = 'c0ffee00-demo-4000-8000-000000000010';
  const cursorDir = path.join(dir, 'cursor', 'acme', 'agent-transcripts', id);
  fs.mkdirSync(cursorDir, { recursive: true });
  const question = 'Shall the hinge be oiled?';
  fs.writeFileSync(path.join(cursorDir, `${id}.jsonl`), [
    JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'The door sticks.' }] } }),
    JSON.stringify({ role: 'assistant', message: { content: [{ type: 'tool_use', name: 'AskQuestion', input: { question } }] } }),
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
  const key = `cursor:acme/${id}`;
  const state = await eventually(async () => {
    const body = await (await fetch(`${base}/state`)).json();
    const agent = body.agents.find(item => item.key === key);
    assert.equal(agent?.summons, 'question');
    assert.equal(agent.state, 'waiting');
    return body;
  });
  assert.doesNotMatch(JSON.stringify(state), /Shall the hinge/);
  const tome = await (await fetch(`${base}/transcript?key=${encodeURIComponent(key)}`)).json();
  assert.equal(tome.entries.at(-1).role, 'question');
  assert.equal(tome.entries.at(-1).text, question);
});
