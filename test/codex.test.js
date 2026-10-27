import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCodexArgs, codexEnv, CodexStream, findCodex, inspectCodex, CODEX_MODES } from '../server/adapters/codex.js';

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
    { type: 'item.started', item: { id: 'f', type: 'file_change', changes: [{ path: 'C:\\p\\a.txt', kind: 'add' }, { path: 'C:\\p\\b.txt', kind: 'update' }] } },
    { type: 'item.completed', item: { id: 'f', type: 'file_change', changes: [], status: 'completed' } },
    { type: 'item.completed', item: { id: 'c', type: 'command_execution', command: 'x', aggregated_output: 'boom', exit_code: 2 } },
    { type: 'turn.failed', error: { message: 'quota' } },
  ]);
  assert.deepEqual(evs.filter(e => e.kind === 'tool' && e.input.file_path).map(e => [e.name, e.input.file_path]), [['Write', 'C:\\p\\a.txt'], ['Edit', 'C:\\p\\b.txt']]);
  assert.equal(evs.find(e => e.kind === 'tool_error').text, 'exit 2: boom');
  const r = evs.at(-1);
  assert.equal(r.kind, 'result'); assert.equal(r.is_error, true); assert.equal(r.text, 'quota');
});

test('args: chat forks isolate messages; older CLIs resume explicitly; subscription authentication is enforced', () => {
  const opts = { agent: { mode: 'acceptEdits' }, resumeSessionId: 'T1', fork: true };
  assert.deepEqual(buildCodexArgs(opts).slice(0, 3), ['exec', 'fork', 'T1']);
  assert.deepEqual(buildCodexArgs({ ...opts, capabilities: { fork: false } }).slice(0, 3), ['exec', 'resume', 'T1']);
  assert.ok(buildCodexArgs(opts).includes('forced_login_method="chatgpt"'));
});

test('stream: errors survive without turn.failed, reconnect errors can recover, resumed sessions are retained', () => {
  const s = new CodexStream('existing');
  assert.deepEqual(s.push({ type: 'error', message: 'Authentication expired' }), [{ kind: 'error', text: 'Authentication expired' }]);
  assert.equal(s.push({ type: 'turn.failed', error: 'request failed' })[0].text, 'request failed');
  s.push({ type: 'item.completed', item: { type: 'agent_message', text: 'Recovered' } });
  const result = s.push({ type: 'turn.completed', usage: {} }).at(-1);
  assert.equal(result.is_error, false);
  assert.equal(result.text, 'Recovered');
  assert.equal(result.session_id, 'existing');
});

test('stream: completed-only file changes and failed MCP calls are surfaced once', () => {
  const s = new CodexStream();
  const file = { id: 'f', type: 'file_change', changes: [{ path: 'src/a.js', kind: 'update' }] };
  assert.equal(s.push({ type: 'item.updated', item: file })[0].name, 'Edit');
  assert.deepEqual(s.push({ type: 'item.completed', item: { ...file, status: 'completed' } }), []);
  assert.equal(s.push({ type: 'item.completed', item: { ...file, id: 'g' } })[0].input.file_path, 'src/a.js');
  const mcp = s.push({ type: 'item.completed', item: { id: 'm', type: 'mcp_tool_call', server: 'x', tool: 'y', status: 'failed', error: { message: 'Disconnected' } } });
  assert.deepEqual(kinds(mcp), ['tool', 'tool_error']);
  assert.equal(mcp[1].text, 'Disconnected');
});

test('findCodex: lookups do not reuse another environment and accept Windows Path spelling', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aios-codex-path-'));
  try {
    for (const name of ['first', 'second']) { mkdirSync(join(dir, name)); writeFileSync(join(dir, name, process.platform === 'win32' ? 'codex.exe' : 'codex'), ''); }
    assert.equal(findCodex({ Path: join(dir, 'first') }), join(dir, 'first', process.platform === 'win32' ? 'codex.exe' : 'codex'));
    assert.equal(findCodex({ PATH: join(dir, 'second') }), join(dir, 'second', process.platform === 'win32' ? 'codex.exe' : 'codex'));
    assert.throws(() => findCodex({ AIOS_CODEX: dir }), /not a file/);
    assert.throws(() => findCodex({ PATH: '', ProgramFiles: dir }), /Codex CLI not found/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('findCodex: Windows npm shims resolve to native binaries and desktop installs work without PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aios-codex-installs-'));
  try {
    const binaryDir = join(dir, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'codex');
    mkdirSync(binaryDir, { recursive: true });
    const binary = join(binaryDir, 'codex.exe'); writeFileSync(binary, '');
    const shim = join(dir, 'codex.cmd'); writeFileSync(shim, '@echo off');
    assert.equal(findCodex({ Path: dir }, { platform: 'win32', arch: 'x64' }), binary);
    assert.equal(findCodex({ AIOS_CODEX: shim }, { platform: 'win32', arch: 'x64' }), binary);
    const desktopDir = join(dir, 'OpenAI', 'Codex', 'bin', 'fingerprint'); mkdirSync(desktopDir, { recursive: true });
    const desktop = join(desktopDir, 'codex.exe'); writeFileSync(desktop, '');
    assert.equal(findCodex({ LOCALAPPDATA: dir, ProgramFiles: dir }, { platform: 'win32' }), desktop);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('connection checks identify subscription login, missing login, API login, old CLI and timeouts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aios-codex-probe-'));
  const executable = join(dir, 'codex.exe'); writeFileSync(executable, '');
  const env = { AIOS_CODEX: executable, OPENAI_API_KEY: 'do-not-inherit', CODEX_API_KEY: 'do-not-inherit' };
  const probe = (auth, help = '--ignore-user-config\n  fork  Fork session') => inspectCodex({ env, execute: async (exe, args, options) => {
    assert.equal(exe, executable); assert.equal(options.env.OPENAI_API_KEY, undefined); assert.equal(options.env.CODEX_API_KEY, undefined);
    if (args[0] === '--version') return { stdout: 'codex-cli test\n', stderr: '' };
    if (args[0] === 'exec') return { stdout: help, stderr: '' };
    if (auth instanceof Error) throw auth;
    return { stdout: '', stderr: auth };
  } });
  try {
    const good = await probe('Logged in using ChatGPT');
    assert.equal(good.ok, true); assert.equal(good.capabilities.fork, true);
    assert.match((await probe('Not logged in')).error, /codex login/);
    assert.match((await probe('Logged in using an API key')).error, /API credentials/);
    assert.match((await probe('Logged in using ChatGPT', '--json')).error, /too old/);
    assert.match((await probe(Object.assign(new Error('timeout'), { killed: true }))).error, /timed out/);
    assert.deepEqual(codexEnv({ Path: 'keep', CODEX_HOME: 'keep', openai_api_key: 'remove' }), { Path: 'keep', CODEX_HOME: 'keep' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
