import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openStore } from '../server/store.js';
import { createBus } from '../server/bus.js';
import { createRunner } from '../server/runner.js';
import { createTasks } from '../server/tasks.js';

const eventsScript = (events, code = 0) => `process.stdin.resume(); process.stdin.on('end', () => { for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event)); process.exitCode = ${code}; });`;
const completed = text => [
  { type: 'thread.started', thread_id: 'thread-1' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { type: 'agent_message', id: 'message-1', text } },
  { type: 'turn.completed', usage: { input_tokens: 200, cached_input_tokens: 100, output_tokens: 20 } },
];

async function waitFor(predicate) {
  const until = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > until) throw new Error('timed out waiting for runner');
    await delay(10);
  }
}

function setup(prepareCodexRun, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'macii-codex-runner-'));
  const store = openStore(join(dir, 'test.db'));
  for (const id of ['a', 'b']) store.insertAgent({ id, name: id, type: 'codex', mode: 'manual', cwd: dir, prompt: 'routine', role: 'role', allowed_tools: [], priority: 'normal' });
  const bus = createBus(), updates = [];
  bus.onPush(e => updates.push(e));
  const runner = createRunner({ store, bus, runDir: join(dir, 'runs'), uploadsDir: join(dir, 'uploads'), prepareCodexRun, ...options });
  return { dir, store, bus, updates, runner, done: async () => {
    runner.stopAll();
    await waitFor(() => store.listActiveRuns().length === 0);
    // finish() ends the raw log stream asynchronously.
    await delay(30);
    store.db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  } };
}

test('Codex runner: native process receives stdin, complete text and usage reach chat, and session resumes', async () => {
  const calls = [];
  const longText = 'ä'.repeat(6000);
  const s = setup(async options => {
    calls.push(options);
    return { executable: process.execPath, args: ['-e', eventsScript(completed(longText))], forked: !!options.resumeSessionId };
  });
  try {
    const run = s.runner.enqueue('a', { trigger: 'chat', prompt: 'first message' });
    await waitFor(() => s.store.getRun(run.id).status === 'done');
    const result = s.store.getRun(run.id);
    assert.equal(result.session_id, 'thread-1');
    assert.equal(result.tokens, 120);
    assert.equal(result.result_text, longText);
    assert.equal(s.store.listEvents(run.id).find(e => e.kind === 'text').data.text, longText);
    const resumed = s.runner.enqueue('a', { trigger: 'chat', prompt: 'follow-up', resumeRun: result, images: [{ file: 'picture.png', type: 'image/png' }] });
    await waitFor(() => s.store.getRun(resumed.id).status === 'done');
    assert.equal(calls[1].resumeSessionId, 'thread-1');
    assert.equal(calls[1].fork, true);
    assert.equal(calls[1].images[0], join(s.dir, 'uploads', 'picture.png'));
    assert.ok(s.store.listEvents(resumed.id).some(e => e.kind === 'codex_session' && e.data.forked));
    assert.ok(s.updates.some(e => e.type === 'text'));
  } finally { await s.done(); }
});

test('Codex runner: JSON connection errors are reported even without turn.failed or stderr', async () => {
  const s = setup(async () => ({ executable: process.execPath, args: ['-e', eventsScript([{ type: 'error', message: 'Token expired; sign in again' }], 1)] }));
  try {
    const run = s.runner.enqueue('a', { trigger: 'chat', prompt: 'hello' });
    await waitFor(() => s.store.getRun(run.id).status === 'failed');
    assert.equal(s.store.getRun(run.id).error, 'Token expired; sign in again');
    assert.equal(s.runner.isLive(run.id), false);
  } finally { await s.done(); }
});

test('Codex runner: a zero exit without a completed turn is not success', async () => {
  const s = setup(async () => ({ executable: process.execPath, args: ['-e', eventsScript([{ type: 'thread.started', thread_id: 'T' }])] }));
  try {
    const run = s.runner.enqueue('a', { trigger: 'chat', prompt: 'hello' });
    await waitFor(() => s.store.getRun(run.id).status === 'failed');
    assert.match(s.store.getRun(run.id).error, /without a completed turn/);
  } finally { await s.done(); }
});

test('Codex runner: failed preflight fails the task and releases the folder for another agent', async () => {
  let attempts = 0;
  const s = setup(async () => {
    if (++attempts === 1) throw new Error('Codex is not signed in');
    return { executable: process.execPath, args: ['-e', eventsScript(completed('second agent done'))] };
  });
  const tasks = createTasks({ store: s.store, runner: s.runner, bus: s.bus, guard: { check: () => ({ ok: true }) } });
  s.bus.onPush(e => { if (e.type === 'run') tasks.onRun(e.data); });
  try {
    const task = s.store.insertTask({ project_path: s.dir, title: 'test', agent_id: 'a' });
    tasks.start(task.id);
    const next = s.runner.enqueue('b', { trigger: 'manual' });
    await waitFor(() => s.store.getTask(task.id).status === 'failed' && s.store.getRun(next.id).status === 'done');
    assert.match(s.store.getTask(task.id).note, /not signed in/);
    assert.equal(s.store.listActiveRuns().length, 0);
  } finally { await s.done(); }
});

test('Codex runner: cancellation during preflight never spawns a late process or locks its folder', async () => {
  let resolveFirst, spawned = 0, calls = 0;
  const pending = new Promise(resolve => { resolveFirst = resolve; });
  const prepared = { executable: process.execPath, args: ['-e', eventsScript(completed('done'))] };
  const s = setup(async () => ++calls === 1 ? pending : prepared, { spawnProcess: () => { spawned++; throw new Error('unexpected spawn'); } });
  try {
    const first = s.runner.enqueue('a', { trigger: 'chat', prompt: 'cancel me' });
    assert.throws(() => s.runner.enqueue('a', { trigger: 'chat', prompt: 'duplicate' }), /active run/);
    await s.runner.stopAndWait(first.id);
    assert.equal(s.store.getRun(first.id).status, 'stopped');
    resolveFirst(prepared);
    await delay(20);
    assert.equal(spawned, 0);
    const second = s.runner.enqueue('b', { trigger: 'manual' });
    await waitFor(() => s.store.getRun(second.id).status === 'failed');
    assert.equal(spawned, 1);
    assert.match(s.store.getRun(second.id).error, /unexpected spawn/);
  } finally { resolveFirst(prepared); await s.done(); }
});

test('Codex runner: missing executable fails cleanly and queued cancellation does not launch', async () => {
  let calls = 0, release;
  const pending = new Promise(resolve => { release = resolve; });
  const s = setup(async () => { calls++; await pending; return { executable: join(s.dir, 'missing-codex.exe'), args: [] }; });
  try {
    const first = s.runner.enqueue('a', { trigger: 'manual' });
    const queued = s.runner.enqueue('b', { trigger: 'chat', prompt: 'queued' });
    assert.equal(queued.status, 'queued');
    await s.runner.stopAndWait(queued.id);
    release();
    await waitFor(() => s.store.getRun(first.id).status === 'failed');
    assert.equal(calls, 1);
    assert.match(s.store.getRun(first.id).error, /could not start codex/);
    assert.equal(s.store.getRun(queued.id).status, 'stopped');
  } finally { release(); await s.done(); }
});

test('Codex runner: a silent process is stopped and releases its slot', async () => {
  const s = setup(async () => ({ executable: process.execPath, args: ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'] }), { silenceMs: 150 });
  try {
    const run = s.runner.enqueue('a', { trigger: 'chat', prompt: 'hello' });
    await waitFor(() => s.store.getRun(run.id).status === 'failed');
    assert.match(s.store.getRun(run.id).error, /gave no output/);
    assert.equal(s.runner.isLive(run.id), false);
  } finally { await s.done(); }
});
