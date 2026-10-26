import test from 'node:test';
import assert from 'node:assert/strict';
import { describeInbox, describeFailure, createNotifier } from '../server/notify.js';
import { createBus } from '../server/bus.js';
import { withDefaults } from '../server/settings.js';

const URL = 'http://127.0.0.1:4747';
const item = (id, type, title = 'T', extra = {}) => ({ id, type, title, status: 'open', agent_id: 'atlas', ...extra });
const fakeStore = (existing = []) => ({ listInbox: () => existing, getAgent: id => ({ id, name: id.toUpperCase() }) });
const setup = ({ settings = withDefaults(null), existing = [], platform = 'win32', show } = {}) => {
  const shown = [], bus = createBus();
  const n = createNotifier({ store: fakeStore(existing), bus, hubUrl: URL, getSettings: () => settings, scriptPath: 'x', platform, show: show ?? (async p => { shown.push(p); }) });
  return { shown, bus, n };
};
const tick = () => new Promise(r => setTimeout(r, 10));

test('toast text names the type and the agent, deep-links to the item, and keeps results quiet', () => {
  const q = describeInbox(item(7, 'question', 'Prisma or raw SQL?'), 'FORGE', URL);
  assert.deepEqual(q, { title: 'Question · FORGE', body: 'Prisma or raw SQL?', url: `${URL}/inbox.html#7`, silent: false });
  assert.equal(describeInbox(item(8, 'result'), 'ATLAS', URL).silent, true);
  assert.equal(describeInbox(item(9, 'approval', 'x'.repeat(500)), 'A', URL).body.length, 160);
});

test('a failed run toasts with the first line of its error', () => {
  const p = describeFailure({ error: '\nboom\nsecond line' }, 'ATLAS', URL);
  assert.equal(p.title, 'Run failed · ATLAS');
  assert.equal(p.body, 'boom');
});

test('a new open inbox item toasts once; updates to it and items that existed at startup do not', async () => {
  const { shown, bus } = setup({ existing: [item(1, 'result')] });
  bus.push('inbox', item(1, 'result'));                        // existed before the hub started
  bus.push('inbox', item(2, 'question'));
  bus.push('inbox', { ...item(2, 'question'), status: 'answered' }); // later update of the same item
  bus.push('inbox', item(2, 'question'));
  await tick();
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, 'Question · ATLAS');
});

test('settings decide: master switch, per-type filter and failed-run toggle', async () => {
  const off = setup({ settings: withDefaults({ notify: { enabled: false } }) });
  off.bus.push('inbox', item(1, 'question')); off.bus.push('run', { id: 1, status: 'failed', agent_id: 'atlas', error: 'e' });
  const only = setup({ settings: withDefaults({ notify: { types: ['approval'], failed_runs: false } }) });
  only.bus.push('inbox', item(1, 'question')); only.bus.push('inbox', item(2, 'approval')); only.bus.push('run', { id: 1, status: 'failed', agent_id: 'atlas', error: 'e' });
  await tick();
  assert.equal(off.shown.length, 0);
  assert.deepEqual(only.shown.map(p => p.title), ['Approval needed · ATLAS']);
});

test('a failed run toasts once even though its status is pushed repeatedly', async () => {
  const { shown, bus } = setup();
  for (let i = 0; i < 3; i++) bus.push('run', { id: 5, status: 'failed', agent_id: 'atlas', error: 'boom' });
  bus.push('run', { id: 6, status: 'done', agent_id: 'atlas' });
  await tick();
  assert.equal(shown.length, 1);
});

test('on other platforms nothing is shown and the test call says why', async () => {
  const { shown, bus, n } = setup({ platform: 'linux' });
  bus.push('inbox', item(1, 'question'));
  await tick();
  assert.equal(shown.length, 0);
  assert.equal(n.status().supported, false);
  await assert.rejects(n.test(), /only available on Windows/);
});

test('a burst is collapsed into one summary instead of a wall of toasts', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const shown = [];
  const { bus } = setup({ show: async p => { shown.push(p); await gate; } });
  for (let i = 1; i <= 12; i++) bus.push('inbox', item(i, 'warning', `w${i}`));
  await tick();
  release(); await tick(); await tick();
  assert.equal(shown[0].body, 'w1');
  assert.equal(shown.length, 2);
  assert.match(shown[1].body, /^\d+ new notifications$/);
});

test('a failing toast is reported through the bus and remembered, not thrown into the hub', async () => {
  const errors = [];
  const { bus, n } = setup({ show: async () => { throw new Error('no desktop session'); } });
  bus.onPush(m => { if (m.type === 'error') errors.push(m.data.message); });
  const origError = console.error; console.error = () => {};
  try { bus.push('inbox', item(1, 'question')); await tick(); } finally { console.error = origError; }
  assert.deepEqual(errors, ['no desktop session']);
  assert.equal(n.status().last_error, 'no desktop session');
});
