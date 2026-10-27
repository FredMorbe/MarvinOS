import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { openStore } from '../server/store.js';
import { createBus } from '../server/bus.js';
import { createRunner } from '../server/runner.js';
import { createGuard } from '../server/guard.js';
import { createAccounts, limitKeyFor } from '../server/accounts.js';
import { withDefaults } from '../server/settings.js';

const fakeClaude = session => `process.stdin.resume(); process.stdin.on('end', () => {
  for (const e of [
    { type: 'system', subtype: 'init', session_id: ${JSON.stringify(session)}, model: 'm' },
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: Date.now() / 1000 + 3600, status: 'allowed' } } } },
    { type: 'result', is_error: false, result: 'ok', session_id: ${JSON.stringify(session)}, num_turns: 1, duration_ms: 1 },
  ]) console.log(JSON.stringify(e));
});`;

async function waitFor(predicate) {
  const until = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > until) throw new Error('timed out');
    await delay(10);
  }
}

function setup(execute) {
  const dir = mkdtempSync(join(tmpdir(), 'macii-accounts-'));
  const store = openStore(join(dir, 'test.db'));
  const accounts = createAccounts({ store, dataDir: dir, execute });
  const seen = []; // env of every spawned claude
  const spawnProcess = (exe, args, opts) => { seen.push(opts.env); return spawn(process.execPath, ['-e', fakeClaude(`s-${seen.length}`)], { ...opts, cwd: dir }); };
  const runner = createRunner({ store, bus: createBus(), accounts, runDir: join(dir, 'runs'), uploadsDir: join(dir, 'uploads'), spawnProcess });
  const agent = (id, extra = {}) => store.insertAgent({ id, name: id, type: 'claude', cwd: dir, prompt: 'p', role: 'r', allowed_tools: [], ...extra });
  return { dir, store, accounts, runner, seen, agent, done: async () => {
    runner.stopAll();
    await waitFor(() => store.listActiveRuns().length === 0);
    await delay(30);
    store.db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  } };
}

test('the CLI login is the built-in default account; added accounts get their own folder', async () => {
  const s = setup();
  try {
    assert.deepEqual(s.accounts.view().list.map(a => [a.id, a.builtin, a.dir]), [['default', true, null]]);
    const id = s.accounts.add('Frederik');
    assert.equal(id, 'frederik');
    const view = s.accounts.view();
    assert.equal(view.list[1].dir, join(s.dir, 'accounts', 'frederik'));
    assert.ok(existsSync(view.list[1].dir));
    assert.equal(view.default, 'default');
    assert.throws(() => s.accounts.add('frederik'), /already exists/);
    assert.throws(() => s.accounts.add('Default'), /already exists/);
    assert.throws(() => s.accounts.add('   '), /name is required/);
    assert.throws(() => s.accounts.add('!!!'), /letters or digits/);
  } finally { await s.done(); }
});

test('an agent uses its own account, else the default; Codex agents have none', async () => {
  const s = setup();
  try {
    s.accounts.add('Frederik');
    assert.equal(s.accounts.resolve({ type: 'claude', name: 'x', account: null }), 'default');
    assert.equal(s.accounts.resolve({ type: 'claude', name: 'x', account: 'frederik' }), 'frederik');
    s.accounts.setDefault('frederik');
    assert.equal(s.accounts.resolve({ type: 'claude', name: 'x', account: null }), 'frederik');
    assert.equal(s.accounts.resolve({ type: 'codex', name: 'x', account: null }), null);
    assert.throws(() => s.accounts.resolve({ type: 'claude', name: 'x', account: 'gone' }), /no longer exists/);
    assert.throws(() => s.accounts.setDefault('gone'), /not found/);
  } finally { await s.done(); }
});

test('an account in use, or the default one, cannot be removed; the folder stays', async () => {
  const s = setup();
  try {
    s.accounts.add('Frederik');
    s.agent('a', { account: 'frederik' });
    assert.throws(() => s.accounts.remove('frederik'), /used by a/);
    assert.throws(() => s.accounts.remove('default'), /cannot be removed/);
    s.store.updateAgent('a', { ...s.store.getAgent('a'), account: null });
    s.accounts.setDefault('frederik');
    assert.throws(() => s.accounts.remove('frederik'), /default account/);
    s.accounts.setDefault('default');
    const dir = s.accounts.remove('frederik');
    assert.ok(existsSync(dir));
    assert.deepEqual(s.accounts.view().list.map(a => a.id), ['default']);
  } finally { await s.done(); }
});

test('a run gets CLAUDE_CONFIG_DIR of its account, never an API key; the default account sets none', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test-must-not-leak';
  const s = setup();
  try {
    s.accounts.add('Frederik');
    s.agent('plain'); s.agent('mine', { account: 'frederik' });
    const a = s.runner.enqueue('plain', { trigger: 'manual' });
    const b = s.runner.enqueue('mine', { trigger: 'manual' });
    await waitFor(() => s.store.getRun(a.id).status === 'done' && s.store.getRun(b.id).status === 'done');
    assert.equal(s.store.getRun(a.id).account, 'default');
    assert.equal(s.store.getRun(b.id).account, 'frederik');
    const [envPlain, envMine] = s.seen;
    assert.equal(envMine.CLAUDE_CONFIG_DIR, join(s.dir, 'accounts', 'frederik'));
    assert.notEqual(envPlain.CLAUDE_CONFIG_DIR, envMine.CLAUDE_CONFIG_DIR);
    for (const env of s.seen) assert.equal(env.ANTHROPIC_API_KEY, undefined);
  } finally { delete process.env.ANTHROPIC_API_KEY; await s.done(); }
});

test('usage windows are kept per account and the guard reads the right one', async () => {
  const s = setup();
  try {
    s.accounts.add('Frederik');
    s.agent('plain'); s.agent('mine', { account: 'frederik' });
    const a = s.runner.enqueue('plain', { trigger: 'manual' });
    await waitFor(() => s.store.getRun(a.id).status === 'done');
    const b = s.runner.enqueue('mine', { trigger: 'manual' });
    await waitFor(() => s.store.getRun(b.id).status === 'done');
    assert.deepEqual(Object.keys(s.store.getLimits()).sort(), ['claude', 'claude:frederik']);
    assert.equal(limitKeyFor('frederik'), 'claude:frederik');
    // only the default account is nearly full
    s.store.setLimits('claude', { windows: { five_hour: { utilization: 0.97, resetsAt: Date.now() / 1000 + 3600, status: 'allowed' } } });
    const guard = createGuard({ store: s.store, getSettings: () => withDefaults(null), limitKey: x => limitKeyFor(s.accounts.resolve(x)) });
    assert.equal(guard.check(s.store.getAgent('plain')).ok, false);
    assert.equal(guard.check(s.store.getAgent('mine')).ok, true);
  } finally { await s.done(); }
});

test('a conversation cannot move to another account; a new one can', async () => {
  const s = setup();
  try {
    s.accounts.add('Frederik');
    s.agent('a');
    const first = s.runner.enqueue('a', { trigger: 'chat', prompt: 'hi' });
    await waitFor(() => s.store.getRun(first.id).status === 'done');
    const done = s.store.getRun(first.id);
    s.store.updateAgent('a', { ...s.store.getAgent('a'), account: 'frederik' });
    assert.throws(() => s.runner.enqueue('a', { trigger: 'chat', prompt: 'again', resumeRun: done }), /ran on account "default", but a now uses "frederik"/);
    assert.equal(s.store.listActiveRuns().length, 0, 'nothing was queued');
    const fresh = s.runner.enqueue('a', { trigger: 'chat', prompt: 'new chat' });
    await waitFor(() => s.store.getRun(fresh.id).status === 'done');
    s.store.updateAgent('a', { ...s.store.getAgent('a'), account: null });
    // a run from before accounts existed (account NULL) belongs to the default account
    const legacy = s.store.createRun({ agent_id: 'a', trigger: 'chat', status: 'done', session_id: 'old', prompt: 'x' });
    const resumed = s.runner.enqueue('a', { trigger: 'chat', prompt: 'continue', resumeRun: legacy });
    await waitFor(() => s.store.getRun(resumed.id).status === 'done');
  } finally { await s.done(); }
});

test('status reports who is logged in, including a logged-out account whose CLI exits non-zero', async () => {
  const calls = [];
  const s = setup(async (file, args, opts) => {
    calls.push(opts.env.CLAUDE_CONFIG_DIR ?? null);
    if (opts.env.CLAUDE_CONFIG_DIR) throw Object.assign(new Error('exit 1'), { stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }) });
    return { stdout: JSON.stringify({ loggedIn: true, email: 'a@b.c', subscriptionType: 'pro', authMethod: 'claude.ai' }) };
  });
  try {
    s.accounts.add('Frederik');
    assert.deepEqual(await s.accounts.status('default'), { logged_in: true, email: 'a@b.c', subscription: 'pro', method: 'claude.ai' });
    assert.equal((await s.accounts.status('frederik')).logged_in, false);
    assert.deepEqual(calls, [null, join(s.dir, 'accounts', 'frederik')]);
    await assert.rejects(s.accounts.status('gone'), /not found/);
  } finally { await s.done(); }
});

test('status says so when claude cannot be run or answers nonsense', async () => {
  const fails = setup(async () => { throw new Error('spawn claude ENOENT'); });
  const junk = setup(async () => ({ stdout: 'hello' }));
  try {
    assert.match((await fails.accounts.status('default')).error, /could not run claude: spawn claude ENOENT/);
    assert.match((await junk.accounts.status('default')).error, /unexpected output/);
  } finally { await fails.done(); await junk.done(); }
});
