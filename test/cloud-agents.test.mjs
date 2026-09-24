import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const API_KEY = 'test-key';
const AGENT_ID = 'bc-00000000-0000-0000-0000-000000000001';
const RUN_ID = 'run-00000000-0000-0000-0000-000000000001';

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

test('discovers a cloud agent and follows its live tool stream', async (t) => {
  let stream;
  const expectedAuth = `Basic ${Buffer.from(`${API_KEY}:`).toString('base64')}`;
  const mockApi = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, expectedAuth);
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/v1/agents') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        items: [{
          id: AGENT_ID,
          name: 'Cloud poller test',
          status: 'ACTIVE',
          env: { type: 'cloud' },
          latestRunId: RUN_ID,
          updatedAt: new Date().toISOString(),
        }],
      }));
      return;
    }
    if (url.pathname === `/v1/agents/${AGENT_ID}`) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: AGENT_ID,
        repos: [{ url: 'https://github.com/esteladiaz/agent-office' }],
      }));
      return;
    }
    if (url.pathname === `/v1/agents/${AGENT_ID}/runs/${RUN_ID}/stream`) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      stream = res;
      res.write(`event: status\ndata: ${JSON.stringify({ runId: RUN_ID, status: 'RUNNING' })}\n\n`);
      res.write(`id: 1-0\nevent: tool_call\ndata: ${JSON.stringify({ callId: 'call-1', name: 'read_file', status: 'running', args: { path: 'secret.txt' } })}\n\n`);
      return;
    }
    res.writeHead(404).end();
  });
  const apiPort = await listen(mockApi);
  t.after(() => mockApi.close());

  const portServer = http.createServer();
  const appPort = await listen(portServer);
  await new Promise(resolve => portServer.close(resolve));

  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      ACTIVE_MINUTES: '30',
      CLAUDE_PROJECTS_DIR: path.join(ROOT, 'test', 'missing-claude'),
      CLOUD_POLL_MS: '100',
      CURSOR_API_BASE_URL: `http://127.0.0.1:${apiPort}`,
      CURSOR_API_KEY: API_KEY,
      CURSOR_PROJECTS_DIR: path.join(ROOT, 'test', 'missing-cursor'),
      CURSOR_STATE_DB: '',
      PORT: String(appPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childOutput = '';
  child.stdout.on('data', chunk => { childOutput += chunk; });
  child.stderr.on('data', chunk => { childOutput += chunk; });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGTERM');
  });

  const stateUrl = `http://127.0.0.1:${appPort}/state`;
  const reading = await eventually(async () => {
    const response = await fetch(stateUrl);
    assert.equal(response.status, 200);
    const state = await response.json();
    const agent = state.agents.find(candidate => candidate.key === `cloud:${AGENT_ID}`);
    assert.ok(agent, childOutput);
    assert.equal(agent.state, 'reading');
    assert.equal(agent.tool, 'read_file');
    assert.equal(agent.project, 'agent-office');
    return agent;
  });
  assert.equal(reading.source, 'cloud');
  assert.equal(reading.title, 'Cloud poller test');

  await eventually(() => {
    assert.ok(stream);
    return stream;
  });
  stream.write(`id: 2-0\nevent: tool_call\ndata: ${JSON.stringify({ callId: 'call-1', name: 'read_file', status: 'completed', result: { content: 'must not leak' } })}\n\n`);
  stream.write(`id: 3-0\nevent: result\ndata: ${JSON.stringify({
    runId: RUN_ID,
    status: 'FINISHED',
    text: 'must not leak',
    git: { branches: [{ repoUrl: 'github.com/esteladiaz/agent-office', branch: 'cursor/cloud-poller' }] },
  })}\n\n`);
  stream.end(`id: 4-0\nevent: done\ndata: {}\n\n`);

  await eventually(async () => {
    const state = await (await fetch(stateUrl)).json();
    const agent = state.agents.find(candidate => candidate.key === `cloud:${AGENT_ID}`);
    assert.equal(agent.state, 'waiting');
    assert.equal(agent.tool, null);
    assert.equal(agent.branch, 'cursor/cloud-poller');
    assert.doesNotMatch(JSON.stringify(state), /must not leak|secret\.txt/);
  });

  // Discovery can lag behind the run stream. A stale ACTIVE status must not
  // move a terminal run back from waiting to thinking on the next poll.
  await new Promise(resolve => setTimeout(resolve, 250));
  const settled = await (await fetch(stateUrl)).json();
  assert.equal(
    settled.agents.find(candidate => candidate.key === `cloud:${AGENT_ID}`).state,
    'waiting',
  );
});
