import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCodexArgs, CodexStream, findCodex, CODEX_MODES } from '../server/adapters/codex.js';

const kinds = evs => evs.map(e => e.kind);
const feed = (s, lines) => lines.flatMap(l => s.push(l));

test('stream: a real exec --json run becomes init, tool, text, usage, result', () => {
  const s = new CodexStream();
  const evs = feed(s, [
    { type: 'thread.started', thread_id: 'T1' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'I will read it.' } },
    { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'Get-Content hello.txt', status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'Get-Content hello.txt', aggregated_output: 'x', exit_code: 0, status: 'completed' } },
    { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'It says hi.' } },
    { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 } },
  ]);
  assert.deepEqual(kinds(evs), ['init', 'text', 'tool', 'text', 'usage', 'result']);
  assert.equal(evs[0].session_id, 'T1');
  assert.equal(evs[2].name, 'Bash');
  const result = evs.at(-1);
  assert.equal(result.text, 'It says hi.');
  assert.equal(result.is_error, false);
  assert.equal(s.tokenTotals().get('main'), 250); // cache reads are not counted
});

test('stream: file changes become Write/Edit tool events with the path, failures become errors', () => {
  const s = new CodexStream();
  const evs = feed(s, [
    { type: 'item.started', item: { id: 'f', type: 'file_change', changes: [{ path: 'C:\p\a.txt', kind: 'add' }, { path: 'C:\p\b.txt', kind: 'update' }] } },
    { type: 'item.completed', item: { id: 'f', type: 'file_change', changes: [], status: 'completed' } },
    { type: 'item.completed', item: { id: 'c', type: 'command_execution', command: 'x', aggregated_output: 'boom', exit_code: 2 } },
    { type: 'turn.failed', error: { message: 'quota' } },
  ]);
  assert.deepEqual(evs.filter(e => e.kind === 'tool').map(e => [e.name, e.input.file_path]), [['Write', 'C:\p\a.txt'], ['Edit', 'C:\p\b.txt']]);
  assert.equal(evs.find(e => e.kind === 'tool_error').text, 'exit 2: boom');
  const r = evs.at(-1);
  assert.equal(r.kind, 'result'); assert.equal(r.is_error, true); assert.equal(r.text, 'quota');
});

test('args: sandbox from the mode, role as developer instructions, prompt on stdin, resume without -s', () => {
  const val = (a, f) => a[a.indexOf(f) + 1];
  const fresh = buildCodexArgs({ agent: { mode: 'acceptEdits', role: 'Say "hi"\nthen stop', model: null } });
  assert.deepEqual(fresh.slice(0, 1), ['exec']);
  assert.ok(fresh.includes('workspace-write'.replace(/^/, 'sandbox_mode="').concat('"')));
  assert.equal(fresh.at(-1), '-');
  assert.ok(fresh.includes('approval_policy="never"') && fresh.includes('--ignore-user-config'));
  assert.ok(fresh.includes('developer_instructions="Say \\"hi\\"\\nthen stop"'));
  const resumed = buildCodexArgs({ agent: { mode: 'manual' }, resumeSessionId: 'T9' });
  assert.deepEqual(resumed.slice(0, 3), ['exec', 'resume', 'T9']);
  assert.ok(!resumed.includes('-s'));
  assert.ok(resumed.includes('sandbox_mode="read-only"'));
  assert.ok(buildCodexArgs({ agent: { mode: 'plan', role: '' } }).some(a => a.startsWith('developer_instructions=') && a.includes('plan mode')));
  assert.equal(val(buildCodexArgs({ agent: { mode: 'manual', model: 'm1' } }), '-m'), 'm1');
  assert.throws(() => buildCodexArgs({ agent: { mode: 'auto' } }), /not available for Codex/);
  assert.deepEqual(Object.keys(CODEX_MODES), ['manual', 'plan', 'acceptEdits']);
});

test('findCodex: AIOS_CODEX wins and must exist; PATH is searched; otherwise a clear error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aios-codex-'));
  try {
    const exe = join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex');
    writeFileSync(exe, '');
    assert.equal(findCodex({ AIOS_CODEX: exe }), exe);
    assert.throws(() => findCodex({ AIOS_CODEX: join(dir, 'nope.exe') }), /does not exist/);
    assert.equal(findCodex({ PATH: dir }), exe);
    const empty = join(dir, 'empty'); mkdirSync(empty);
    if (process.platform !== 'win32') assert.throws(() => findCodex({ PATH: empty }), /Codex CLI not found/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
