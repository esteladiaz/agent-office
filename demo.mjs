#!/usr/bin/env node
// Writes fake Claude Code and Cursor sessions into ./demo-projects so you can
// watch the hall without running real agents:
//   CLAUDE_PROJECTS_DIR=./demo-projects/claude CURSOR_PROJECTS_DIR=./demo-projects/cursor PORT=7332 node server.mjs &
//   node demo.mjs

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.env.DEMO_DIR || 'demo-projects');
fs.rmSync(ROOT, { recursive: true, force: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const append = (file, obj) => fs.appendFileSync(file, JSON.stringify(obj) + '\n');
let n = 0;

// ---------- Claude Code: timestamped lines, tool ids and results, meta.json per subagent ----------

async function claudeDemo() {
  const slug = '-demo-acme-web', sessionId = 'demo-session-0001';
  const dir = path.join(ROOT, 'claude', slug);
  const subDir = path.join(dir, sessionId, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const sessionFile = path.join(dir, `${sessionId}.jsonl`);
  const write = (file, obj) => append(file, { cwd: '/work/acme-web', gitBranch: 'demo/branch', timestamp: new Date().toISOString(), ...obj });
  const toolUse = (file, name, extra = {}) => {
    const id = `toolu_demo_${++n}`;
    write(file, { type: 'assistant', ...extra, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input: {} }] } });
    return id;
  };
  const toolResult = (file, id, extra = {}) =>
    write(file, { type: 'user', ...extra, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
  const say = (file, extra = {}) =>
    write(file, { type: 'assistant', ...extra, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } });
  const runTools = async (file, tools, extra) => {
    for (const [name, ms] of tools) { const id = toolUse(file, name, extra); await sleep(ms); toolResult(file, id, extra); await sleep(300); }
  };
  const subagent = async (agentId, agentType, description, tools, parentToolUseId) => {
    const file = path.join(subDir, `agent-${agentId}.jsonl`);
    fs.writeFileSync(file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType, description, toolUseId: parentToolUseId, spawnDepth: 1 }));
    const extra = { isSidechain: true, agentId };
    write(file, { type: 'user', ...extra, message: { role: 'user', content: description } });
    await runTools(file, tools, extra);
    say(file, extra);
  };

  write(sessionFile, { type: 'custom-title', customTitle: 'Demo: add dark mode' });
  write(sessionFile, { type: 'user', message: { role: 'user', content: 'Add dark mode to the settings page' } });
  await sleep(1500);
  await runTools(sessionFile, [['Read', 2000], ['Grep', 1500]]);
  const ids = ['Agent', 'Agent', 'Agent'].map(name => toolUse(sessionFile, name));
  await Promise.all([
    subagent('a1', 'Explore', 'Find every theme token usage', [['Grep', 2500], ['Read', 2000], ['Glob', 1500], ['Read', 2500]], ids[0]),
    (async () => { await sleep(700); await subagent('a2', 'general-purpose', 'Draft CSS variables for dark palette', [['Read', 2000], ['Write', 4000], ['Edit', 3000]], ids[1]); })(),
    // This one sits on a Bash call long enough to look like a permission prompt.
    (async () => { await sleep(1400); await subagent('a3', 'general-purpose', 'Run the visual regression suite', [['Bash', 16000], ['Read', 1500]], ids[2]); })(),
  ]);
  for (const id of ids) toolResult(sessionFile, id);
  await sleep(1200);
  await runTools(sessionFile, [['Edit', 3000], ['Bash', 3000]]);
  say(sessionFile);
}

// ---------- Cursor: {role, message} lines + turn_ended, no timestamps, ids or results ----------

async function cursorDemo() {
  const slug = 'acme-api', id = 'c0ffee00-demo-4000-8000-000000000001';
  const base = path.join(ROOT, 'cursor', slug, 'agent-transcripts', id);
  fs.mkdirSync(path.join(base, 'subagents'), { recursive: true });
  const sessionFile = path.join(base, `${id}.jsonl`);
  const stamp = () => `<timestamp>${new Date().toString()}</timestamp>\n`;
  const user = (file, text) => append(file, { role: 'user', message: { content: [{ type: 'text', text: stamp() + text }] } });
  const tool = (file, name, input = {}) => append(file, { role: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
  const text = (file, t) => append(file, { role: 'assistant', message: { content: [{ type: 'text', text: t }] } });
  const end = (file) => append(file, { type: 'turn_ended', status: 'success' });
  const run = async (file, tools) => { for (const [name, ms, input] of tools) { tool(file, name, input); await sleep(ms); } };
  const subagent = async (subId, type, description, prompt, tools) => {
    tool(sessionFile, 'Task', { description, prompt, subagent_type: type });
    const file = path.join(base, 'subagents', `${subId}.jsonl`);
    user(file, prompt);
    await sleep(400);
    await run(file, tools);
    text(file, 'Summary for the parent.');
    end(file);
  };

  await sleep(2500);
  user(sessionFile, 'Why is the /orders endpoint slow?');
  text(sessionFile, "I'll look at the handler first.");
  await sleep(800);
  await run(sessionFile, [['Read', 2000], ['Grep', 1800]]);
  // Cursor's Task tool: the subagent's first message is the prompt, which is how we link it.
  await Promise.all([
    subagent('d00d0001-demo', 'explore', 'Trace the orders query path', 'Trace how GET /orders builds its SQL and list every join.', [['Grep', 2500], ['Read', 2500], ['Glob', 1500], ['Read', 2000]]),
    (async () => { await sleep(900); await subagent('d00d0002-demo', 'generalPurpose', 'Benchmark the orders query', 'Run the orders benchmark and report p50/p95.', [['Shell', 5000], ['ReadLints', 1500], ['StrReplace', 2500]]); })(),
  ]);
  await sleep(800);
  await run(sessionFile, [['StrReplace', 2500], ['Shell', 3000]]);
  // AskQuestion means the agent is waiting on you.
  tool(sessionFile, 'AskQuestion', { question: 'Add the index now?' });
  await sleep(6000);
  user(sessionFile, 'Yes');
  await run(sessionFile, [['Write', 2500]]);
  text(sessionFile, 'Added the index; p95 dropped.');
  end(sessionFile);
}

console.log(`demo transcripts -> ${ROOT}`);
await Promise.all([claudeDemo(), cursorDemo()]);
console.log('demo finished; both sessions are now waiting for you. Re-run to replay.');
