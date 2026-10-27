import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store.js';
import { createTasks, taskPrompt } from '../server/tasks.js';

function setup({ guardOk = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aios-tasks-'));
  const proj = join(dir, 'proj'), other = join(dir, 'other');
  mkdirSync(proj); mkdirSync(other);
  const store = openStore(join(dir, 't.db'));
  store.insertAgent({ id: 'a', name: 'Atlas', type: 'claude', prompt: 'p', cwd: proj, allowed_tools: [], priority: 'normal' });
  store.insertAgent({ id: 'far', name: 'Far', type: 'claude', prompt: 'p', cwd: other, allowed_tools: [], priority: 'normal' });
  const pushed = [];
  const bus = { push: (type, data) => pushed.push({ type, data }) };
  const g = { ok: guardOk };
  const guard = { check: () => (g.ok ? { ok: true } : { ok: false, reason: '5-hour window at 93%' }) };
  const enqueued = [];
  const runner = { enqueue: (agentId, o) => { const run = store.createRun({ agent_id: agentId, trigger: o.trigger, status: 'queued', prompt: o.prompt }); enqueued.push(run); return run; } };
  const tasks = createTasks({ store, runner, bus, guard, now: () => 1000 });
  /** what the real runner does: store the new status, then the update reaches the tasks */
  const setRun = (run, status, error = null) => { store.updateRun(run.id, { status, error }); tasks.onRun(store.getRun(run.id)); };
  const mk = (extra = {}) => store.insertTask({ project_path: proj, title: 'Fix the login', body: 'see auth.js', agent_id: 'a', ...extra });
  return { store, tasks, runner, mk, setRun, enqueued, pushed, g, proj, done: () => { store.db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('start sends the task text as the run prompt and links the run', () => {
  const s = setup();
  try {
    const t = s.mk();
    s.tasks.start(t.id);
    const after = s.store.getTask(t.id);
    assert.equal(after.status, 'running');
    assert.equal(after.run_id, s.enqueued[0].id);
    assert.equal(s.enqueued[0].trigger, 'task');
    assert.equal(s.enqueued[0].prompt, taskPrompt(t));
    assert.match(s.enqueued[0].prompt, /^Task: Fix the login\n\nsee auth\.js$/);
  } finally { s.done(); }
});

test('immediate Codex launch failures finish linked tasks and do not repeatedly dispatch them', () => {
  const s = setup();
  try {
    const enqueue = s.runner.enqueue;
    s.runner.enqueue = (id, options) => {
      const run = enqueue(id, options);
      s.setRun(run, 'failed', 'Codex CLI not found');
      return s.store.getRun(run.id);
    };
    const first = s.mk({ auto: true }), second = s.mk({ auto: true });
    s.tasks.dispatch();
    s.tasks.dispatch();
    for (const t of [first, second]) {
      const after = s.store.getTask(t.id);
      assert.equal(after.status, 'failed');
      assert.equal(after.note, 'Codex CLI not found');
      assert.equal(after.finished_at, 1000);
    }
    s.tasks.dispatch();
    assert.equal(s.enqueued.length, 2);
  } finally { s.done(); }
});

test('start refuses loudly: no agent, agent in another folder, already running, busy agent', () => {
  const s = setup();
  try {
    assert.throws(() => s.tasks.start(s.mk({ agent_id: null }).id), { code: 'BAD', message: /assign an agent/ });
    assert.throws(() => s.tasks.start(s.mk({ agent_id: 'far' }).id), { code: 'BAD', message: /another folder/ });
    const t = s.mk(); s.tasks.start(t.id);
    assert.throws(() => s.tasks.start(t.id), { code: 'BUSY', message: /already running/ });
    assert.throws(() => s.tasks.start(s.mk().id), { code: 'BUSY', message: /busy/ });
    assert.throws(() => s.tasks.start(999), { code: 'NOT_FOUND' });
  } finally { s.done(); }
});

test('the task follows its run chain: done, question, answer, late runs are ignored', () => {
  const s = setup();
  try {
    const t = s.mk(); s.tasks.start(t.id);
    const first = s.enqueued[0];
    s.setRun(first, 'running');
    assert.equal(s.store.getTask(t.id).status, 'running');
    s.setRun(first, 'waiting');
    assert.equal(s.store.getTask(t.id).status, 'waiting');
    // the user answers: a resumed run is queued first, then the old run is marked done
    const resumed = s.store.createRun({ agent_id: 'a', parent_run_id: first.id, trigger: 'resume', status: 'queued', prompt: 'x' });
    s.tasks.onRun(s.store.getRun(resumed.id));
    s.setRun(first, 'done');
    assert.equal(s.store.getTask(t.id).status, 'running', 'the old run finishing must not close the task');
    s.setRun(resumed, 'done');
    const end = s.store.getTask(t.id);
    assert.equal(end.status, 'done');
    assert.equal(end.finished_at, 1000);
    assert.equal(end.last_run_id, resumed.id);
  } finally { s.done(); }
});

test('a failed run marks the task failed with the reason', () => {
  const s = setup();
  try {
    const t = s.mk(); s.tasks.start(t.id);
    s.setRun(s.enqueued[0], 'failed', 'claude exited with code 1');
    const f = s.store.getTask(t.id);
    assert.equal(f.status, 'failed');
    assert.equal(f.note, 'claude exited with code 1');
    s.tasks.start(t.id); // a failed task can be run again
    assert.equal(s.store.getTask(t.id).status, 'running');
    assert.equal(s.store.getTask(t.id).note, null);
  } finally { s.done(); }
});

test('dispatch starts automatic tasks oldest first, one per agent, and finishing one starts the next', () => {
  const s = setup();
  try {
    const manual = s.mk({ auto: false }), one = s.mk({ auto: true, title: 'first' }), two = s.mk({ auto: true, title: 'second' });
    s.tasks.dispatch();
    assert.equal(s.store.getTask(manual.id).status, 'todo', 'manual tasks are never started automatically');
    assert.equal(s.store.getTask(one.id).status, 'running');
    assert.equal(s.store.getTask(two.id).status, 'todo');
    s.setRun(s.enqueued[0], 'done');
    assert.equal(s.store.getTask(two.id).status, 'running');
    assert.equal(s.enqueued.length, 2);
  } finally { s.done(); }
});

test('dispatch respects the limit guard, says why once, and starts when the guard lets go', () => {
  const s = setup({ guardOk: false });
  try {
    const t = s.mk({ auto: true });
    s.tasks.dispatch(); s.tasks.dispatch();
    assert.equal(s.store.getTask(t.id).status, 'todo');
    assert.equal(s.store.getTask(t.id).note, '5-hour window at 93%');
    assert.equal(s.pushed.filter(p => p.type === 'task').length, 1, 'one update, not one per attempt');
    s.g.ok = true;
    s.tasks.dispatch();
    assert.equal(s.store.getTask(t.id).status, 'running');
    assert.equal(s.store.getTask(t.id).note, null);
  } finally { s.done(); }
});
