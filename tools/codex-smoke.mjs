// Opt-in integration check: uses the installed Codex CLI and consumes subscription usage.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { crc32, deflateSync } from 'node:zlib';

function testPng() {
  const chunk = (type, data) => {
    const bytes = Buffer.concat([Buffer.from(type), data]);
    const size = Buffer.alloc(4), crc = Buffer.alloc(4);
    size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(bytes));
    return Buffer.concat([size, bytes, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(64); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc(64 * 193, 255); for (let y = 0; y < 64; y++) rows[y * 193] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = join(root, 'data'); mkdirSync(fixtureRoot, { recursive: true });
const fixture = mkdtempSync(join(fixtureRoot, 'codex-smoke-'));
const project = join(fixture, 'project'); mkdirSync(project);
const portServer = createServer(); portServer.listen(0, '127.0.0.1'); await once(portServer, 'listening');
const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
const url = `http://127.0.0.1:${port}`;
const hub = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
  cwd: root, env: { ...process.env, AIOS_DATA: join(fixture, 'hub'), AIOS_PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
});
let hubLog = '';
hub.stdout.on('data', d => { hubLog = (hubLog + d).slice(-4000); });
hub.stderr.on('data', d => { hubLog = (hubLog + d).slice(-4000); });

async function api(method, path, body) {
  const response = await fetch(url + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${data.error}`);
  return data;
}
async function waitFor(read, ready, timeoutMs = 60000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await read();
    if (ready(value)) return value;
    await delay(200);
  }
  throw new Error('Codex smoke check timed out');
}
async function finishRun(run) {
  const data = await waitFor(() => api('GET', `/api/runs/${run.id}`), value => !['queued', 'running'].includes(value.run.status));
  assert.equal(data.run.status, 'done', data.run.error ?? 'run did not finish');
  assert.ok(data.run.session_id);
  assert.ok(!data.events.some(e => e.kind === 'parse_error' || e.kind === 'internal_error'));
  return data.run;
}
async function checkSelection(run, model, effort) {
  const data = await api('GET', `/api/runs/${run.id}`);
  const selected = data.events.find(e => e.kind === 'codex_session')?.data;
  assert.equal(selected?.model, model);
  assert.equal(selected?.effort, effort);
  assert.equal(data.events.find(e => e.kind === 'init')?.data.model, model);
}

try {
  await waitFor(() => api('GET', '/api/state').catch(() => null), Boolean, 10000);
  const connection = await api('GET', '/api/adapters/codex');
  assert.ok(connection.ok, connection.error);
  console.log(`PASS connection: ${connection.version} (${connection.authMode})`);
  const { models } = await api('GET', '/api/adapters/codex/models');
  const initial = models.find(m => m.isDefault) ?? models[0];
  const followUp = models.find(m => m.id !== initial.id && /luna/.test(m.id)) ?? models.find(m => m.id !== initial.id) ?? initial;
  const level = (model, preferred) => model.supportedReasoningEfforts.find(e => e.reasoningEffort === preferred)?.reasoningEffort ?? model.defaultReasoningEffort;
  const agent = { name: 'Codex smoke', type: 'codex', cwd: project, mode: 'acceptEdits', role: 'Complete only the requested test. Keep replies concise.', allowed_tools: [], enabled: false, model: initial.id, effort: level(initial, 'low') };
  const { id } = await api('POST', '/api/agents', agent);
  const unknown = await fetch(url + `/api/agents/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...agent, model: 'macii-nonexistent-model' }) });
  assert.equal(unknown.status, 400, 'an unknown model must be rejected');
  const limited = models.find(m => !m.supportedReasoningEfforts.some(e => e.reasoningEffort === 'ultra'));
  if (limited) {
    const invalid = await fetch(url + `/api/agents/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...agent, model: limited.id, effort: 'ultra' }) });
    assert.equal(invalid.status, 400, 'unsupported Intelligence must be rejected');
  }
  const marker = `MACII_${Date.now()}`;
  const first = await finishRun((await api('POST', `/api/agents/${id}/chat`, { message: `Remember this marker for my next message: ${marker}. Reply READY. Do not use tools.` })).run);
  await checkSelection(first, agent.model, agent.effort);
  console.log(`PASS first chat message: ${agent.model} / ${agent.effort}`);
  agent.model = followUp.id; agent.effort = level(followUp, 'medium');
  await api('PUT', `/api/agents/${id}`, agent);
  const saved = (await api('GET', '/api/state')).agents.find(a => a.id === id);
  assert.equal(saved.model, agent.model); assert.equal(saved.effort, agent.effort);
  const second = await finishRun((await api('POST', `/api/agents/${id}/chat`, {
    message: 'What marker did I ask you to remember? Reply only with the marker. A small test PNG is attached. Do not use tools.',
    images: [{ name: 'test.png', data: testPng() }],
  })).run);
  await checkSelection(second, agent.model, agent.effort);
  assert.ok(second.result_text.includes(marker), 'follow-up lost the conversation context');
  if (connection.capabilities.fork) assert.notEqual(second.session_id, first.session_id, 'chat did not fork its parent session');
  const thread = await api('GET', `/api/agents/${id}/chat`);
  assert.equal(thread.runs.length, 2);
  assert.equal(thread.runs[1].attachments.length, 1);
  console.log(`PASS model/Intelligence change on follow-up: ${agent.model} / ${agent.effort}; context and image attachment retained`);
  await api('PUT', `/api/agents/${id}`, { ...agent, model: null, effort: null });
  // Verify that clearing the selects also resets an existing chat session, rather than retaining its previous settings.
  const reset = await finishRun((await api('POST', `/api/agents/${id}/chat`, { message: 'Reply RESET_OK. Do not use tools.' })).run);
  await checkSelection(reset, initial.id, initial.defaultReasoningEffort);
  console.log('PASS reset to default model and Intelligence on existing chat');
  const task = await api('POST', '/api/tasks', { project_path: project, agent_id: id, title: 'Write a smoke-test file', body: 'Create smoke.txt in your working directory containing exactly MACII_FILE_OK. Use a file editing tool, then reply DONE. Do not change any other files.' });
  const started = await api('POST', `/api/tasks/${task.id}/start`, {});
  const taskRun = await finishRun({ id: started.task.run_id });
  await checkSelection(taskRun, initial.id, initial.defaultReasoningEffort);
  assert.equal(readFileSync(join(project, 'smoke.txt'), 'utf8').trim(), 'MACII_FILE_OK');
  const state = await api('GET', '/api/state');
  assert.equal(state.tasks.find(t => t.id === task.id).status, 'done');
  console.log('PASS task execution, workspace file edit and task completion');
} catch (e) {
  console.error(e.message);
  if (hubLog) console.error(hubLog);
  process.exitCode = 1;
} finally {
  const closed = hub.exitCode !== null || hub.signalCode !== null ? Promise.resolve() : once(hub, 'close');
  if (hub.connected) hub.send('shutdown');
  await closed;
  // Only remove the directory created by this invocation, inside the repository's ignored data directory.
  if (dirname(fixture) !== fixtureRoot || !basename(fixture).startsWith('codex-smoke-')) throw new Error('Unexpected fixture path');
  rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
