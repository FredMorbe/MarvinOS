import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store.js';
import { createBus } from '../server/bus.js';
import { createGuard } from '../server/guard.js';
import { createScheduler } from '../server/scheduler.js';
import { withDefaults } from '../server/settings.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'aios-sched-'));
  const store = openStore(join(dir, 't.db'));
  store.insertAgent({ id: 'a', name: 'Atlas', type: 'claude', prompt: 'p', cwd: dir, allowed_tools: [], priority: 'normal' });
  const enqueued = [], changes = [];
  const runner = { enqueue: (id, o) => enqueued.push({ id, ...o }) };
  const guard = createGuard({ store, getSettings: () => withDefaults(store.getSetting('app')) });
  const scheduler = createScheduler({ store, runner, bus: createBus(), guard, graceMs: 50, onChange: () => changes.push(Date.now()) });
  return { dir, store, enqueued, changes, scheduler, done: () => { store.db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const setLimits = (store, five, resetInMs) => store.setLimits('claude', { windows: {
  five_hour: { utilization: five, resetsAt: (Date.now() + resetInMs) / 1000, status: 'allowed' },
  seven_day: { utilization: 0.1, resetsAt: (Date.now() + 86_400_000) / 1000, status: 'allowed' },
} });
const warnings = store => store.listInbox().filter(i => i.type === 'warning');

test('under the threshold a scheduled start goes straight to the runner', () => {
  const t = setup();
  setLimits(t.store, 0.3, 60_000);
  assert.deepEqual(t.scheduler.fire('a'), { started: true });
  assert.deepEqual(t.enqueued.map(e => [e.id, e.trigger]), [['a', 'schedule']]);
  t.done();
});

test('over the threshold the run is held back with one inbox warning, then starts once the window has reset', async () => {
  const t = setup();
  setLimits(t.store, 0.92, 1200);
  const r = t.scheduler.fire('a');
  assert.equal(r.started, false);
  assert.match(r.reason, /5-hour window at 92%/);
  assert.equal(t.enqueued.length, 0);
  assert.equal(warnings(t.store).length, 1);
  assert.match(warnings(t.store)[0].title, /held back by the limit guard/);
  assert.ok(t.scheduler.deferredUntil('a') > Date.now());

  t.scheduler.fire('a');                       // the schedule fires again while the retry is pending
  assert.equal(warnings(t.store).length, 1);   // same decision, no second warning

  await new Promise(r2 => setTimeout(r2, 3500)); // croner works in whole seconds
  assert.deepEqual(t.enqueued.map(e => [e.id, e.trigger]), [['a', 'schedule']]);
  assert.equal(t.scheduler.deferredUntil('a'), null);
  assert.ok(t.changes.length >= 2);            // the UI was told when the hold started and ended
  t.done();
});

test('a still-running previous run is reported, not stacked', () => {
  const t = setup();
  t.store.createRun({ agent_id: 'a', trigger: 'manual', status: 'running', prompt: 'p' });
  const r = t.scheduler.fire('a');
  assert.equal(r.started, false);
  assert.match(warnings(t.store)[0].title, /routine skipped/);
  assert.equal(t.enqueued.length, 0);
  t.done();
});

test('disabled or unknown agents never start', () => {
  const t = setup();
  t.store.updateAgent('a', { ...t.store.getAgent('a'), enabled: false });
  assert.equal(t.scheduler.fire('a').started, false);
  assert.equal(t.scheduler.fire('missing').started, false);
  assert.equal(t.enqueued.length, 0);
  t.done();
});

test('a high-priority agent still runs where a normal one is held back', () => {
  const t = setup();
  setLimits(t.store, 0.9, 60_000);
  t.store.updateAgent('a', { ...t.store.getAgent('a'), priority: 'high' });
  assert.equal(t.scheduler.fire('a').started, true);
  t.done();
});

test('settings and priority survive a database round trip', () => {
  const t = setup();
  assert.equal(t.store.getSetting('app'), null);
  t.store.setSetting('app', { guard: { enabled: false } });
  assert.deepEqual(t.store.getSetting('app'), { guard: { enabled: false } });
  assert.equal(t.store.getAgent('a').priority, 'normal');
  t.done();
});
