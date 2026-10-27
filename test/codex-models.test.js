import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeModels, readCodexModels, resolveCodexSelection } from '../server/codex-models.js';
import { buildCodexArgs } from '../server/adapters/codex.js';
import { modelOptions, effortOptions } from '../web/model-options.js';
import { openStore } from '../server/store.js';

const rawModel = (model = 'reasoner', extra = {}) => ({ model, displayName: model, isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium', 'high'].map(reasoningEffort => ({ reasoningEffort, description: `${reasoningEffort} depth` })), ...extra });
const models = normalizeModels([rawModel(), rawModel('deep', { isDefault: false, defaultReasoningEffort: 'high', supportedReasoningEfforts: ['high', 'ultra'].map(reasoningEffort => ({ reasoningEffort })) })]);

function server(handler) {
  const child = new EventEmitter();
  child.pid = 123; child.exitCode = null; child.killed = false;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(bytes, encoding, callback) {
    const request = JSON.parse(bytes.toString());
    queueMicrotask(() => handler(request, reply => child.stdout.write(JSON.stringify(reply) + '\n'), child));
    callback();
  } });
  child.kill = () => { child.killed = true; child.exitCode = 0; child.stdout.end(); child.stderr.end(); queueMicrotask(() => child.emit('close', 0)); };
  return child;
}

test('model catalog: initialize handshake, pagination and cleanup without starting a thread', async () => {
  const methods = [];
  const child = server((request, reply) => {
    methods.push(request.method);
    if (request.method === 'initialize') reply({ id: request.id, result: {} });
    if (request.method === 'model/list') reply({ id: request.id, result: request.params.cursor
      ? { data: [rawModel('second', { isDefault: false })], nextCursor: null }
      : { data: [rawModel()], nextCursor: 'page-two' } });
  });
  const result = await readCodexModels({ executable: 'native-codex', env: {}, spawnProcess: (exe, args, options) => {
    assert.equal(exe, 'native-codex'); assert.equal(args[0], 'app-server'); assert.equal(options.shell, undefined); return child;
  } });
  assert.deepEqual(result.map(m => m.id), ['reasoner', 'second']);
  assert.deepEqual(methods, ['initialize', 'initialized', 'model/list', 'model/list']);
  assert.equal(child.killed, true);
});

test('model catalog: protocol rejection, malformed data, early exit and timeouts remain actionable', async () => {
  for (const [response, expected] of [
    [{ error: { message: 'Sign-in expired' } }, /Sign-in expired/],
    [{ result: { data: null } }, /invalid model catalog/],
  ]) {
    const child = server((request, reply) => request.method === 'initialize' ? reply({ id: request.id, result: {} }) : request.method === 'model/list' && reply({ id: request.id, ...response }));
    await assert.rejects(readCodexModels({ executable: 'x', spawnProcess: () => child }), expected);
    assert.equal(child.killed, true);
  }
  const silent = server(() => {});
  await assert.rejects(readCodexModels({ executable: 'x', spawnProcess: () => silent, timeoutMs: 10 }), /timed out/);
  assert.equal(silent.killed, true);
  const exiting = server((request, reply, child) => child.emit('close', 1));
  await assert.rejects(readCodexModels({ executable: 'x', spawnProcess: () => exiting }), /exited/);
});

test('model catalog: hidden entries are excluded and model-specific Intelligence is validated', () => {
  assert.deepEqual(normalizeModels([rawModel(), rawModel('hidden', { hidden: true })]).map(m => m.id), ['reasoner']);
  assert.throws(() => normalizeModels([]), /no available models/);
  assert.deepEqual(resolveCodexSelection({ model: null, effort: null }, models), { model: 'reasoner', effort: 'medium' });
  assert.deepEqual(resolveCodexSelection({ model: 'deep', effort: 'ultra' }, models), { model: 'deep', effort: 'ultra' });
  assert.deepEqual(resolveCodexSelection({ model: 'deep', effort: null }, models), { model: 'deep', effort: 'high' });
  assert.throws(() => resolveCodexSelection({ model: 'reasoner', effort: 'ultra' }, models), /not supported/);
  assert.throws(() => resolveCodexSelection({ model: 'missing' }, models), /not available/);
});

test('model picker: provider-specific ids, supported levels, defaults and unavailable saved models', () => {
  assert.deepEqual(modelOptions('codex', models).map(o => o.value), ['', 'reasoner', 'deep']);
  assert.equal(modelOptions('codex', models)[0].label, 'default (reasoner)');
  assert.ok(modelOptions('claude', models).some(o => o.value === 'sonnet'));
  assert.ok(!modelOptions('claude', models).some(o => o.value === 'reasoner'));
  assert.deepEqual(effortOptions('codex', models, 'deep').map(o => o.value), ['', 'high', 'ultra']);
  assert.deepEqual(effortOptions('codex', models, '').map(o => o.value), ['', 'low', 'medium', 'high']);
  assert.equal(effortOptions('codex', models, 'deep')[0].label, 'default (high)');
  assert.ok(!effortOptions('claude', models).some(o => o.value === 'ultra'));
  assert.equal(modelOptions('codex', models, 'old-model').at(-1).value, 'old-model');
  assert.deepEqual(effortOptions('codex', [], '').map(o => o.value), ['']);
});

test('Codex args: explicit model and Intelligence are applied to fresh, resumed and forked turns', () => {
  for (const continuation of [{}, { resumeSessionId: 'T' }, { resumeSessionId: 'T', fork: true }]) {
    const agent = { mode: 'manual', ...resolveCodexSelection({ model: 'deep', effort: 'ultra' }, models) };
    const args = buildCodexArgs({ agent, ...continuation });
    assert.equal(args[args.indexOf('-m') + 1], 'deep');
    assert.ok(args.includes('model_reasoning_effort="ultra"'));
    // Clearing both selects must overwrite choices saved in the resumed session.
    const reset = buildCodexArgs({ agent: { mode: 'manual', ...resolveCodexSelection({ model: null, effort: null }, models) }, ...continuation });
    assert.equal(reset[reset.indexOf('-m') + 1], 'reasoner');
    assert.ok(reset.includes('model_reasoning_effort="medium"'));
  }
  assert.throws(() => buildCodexArgs({ agent: { effort: 'invented' } }), /unknown Codex Intelligence/);
});

test('agent settings: model and Intelligence survive saves and can both be cleared', () => {
  const dir = mkdtempSync(join(tmpdir(), 'macii-model-settings-'));
  const store = openStore(join(dir, 'test.db'));
  try {
    const a = { id: 'codex', name: 'Codex', type: 'codex', cwd: dir, model: 'deep', effort: 'ultra' };
    store.insertAgent(a);
    assert.equal(store.getAgent(a.id).model, 'deep');
    assert.equal(store.getAgent(a.id).effort, 'ultra');
    store.updateAgent(a.id, { ...a, model: null, effort: null });
    assert.equal(store.getAgent(a.id).model, null);
    assert.equal(store.getAgent(a.id).effort, null);
  } finally { store.db.close(); rmSync(dir, { recursive: true, force: true }); }
});
