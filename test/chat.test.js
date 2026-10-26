import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store.js';
import { isEditable, validatePins } from '../server/chat.js';
import { buildClaudeArgs, CHAT_APPEND, SYSTEM_APPEND } from '../server/adapters/claude.js';

const agent = { allowed_tools: [], model: null };
const sysPrompt = args => args[args.indexOf('--append-system-prompt') + 1];

test('chat runs get the chat system prompt, scheduled runs the unattended one', () => {
  assert.equal(sysPrompt(buildClaudeArgs({ agent, allowedTools: [], chat: true })), CHAT_APPEND);
  assert.equal(sysPrompt(buildClaudeArgs({ agent, allowedTools: [] })), SYSTEM_APPEND);
  assert.match(CHAT_APPEND, /approval/);
  assert.doesNotMatch(CHAT_APPEND, /unattended/);
});

test('rootRun follows the resume chain, so answers to a chat approval stay in the chat', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aios-chat-'));
  const store = openStore(join(dir, 't.db'));
  try {
    store.insertAgent({ id: 'a', name: 'Atlas', type: 'claude', prompt: 'p', cwd: dir, allowed_tools: [], priority: 'normal' });
    const mk = (trigger, parent) => store.createRun({ agent_id: 'a', parent_run_id: parent, trigger, status: 'done', prompt: 'x' });
    const chat = mk('chat'), second = mk('chat', chat.id), resumed = mk('resume', second.id), cron = mk('schedule');
    assert.equal(store.rootRun(resumed.id).id, chat.id);
    assert.equal(store.rootRun(resumed.id).trigger, 'chat');
    assert.equal(store.rootRun(cron.id).trigger, 'schedule');
  } finally { store.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a chat message is editable only while its run is active and has shown nothing', () => {
  const run = (over = {}) => ({ trigger: 'chat', status: 'running', ...over });
  assert.equal(isEditable(run(), []), true);
  assert.equal(isEditable(run({ status: 'queued' }), []), true);
  assert.equal(isEditable(run(), [{ kind: 'init' }, { kind: 'warning' }]), true); // bookkeeping events are not an answer
  for (const kind of ['text', 'tool', 'tool_error']) assert.equal(isEditable(run(), [{ kind }]), false, kind);
  for (const status of ['done', 'failed', 'stopped', 'waiting']) assert.equal(isEditable(run({ status }), []), false, status);
  assert.equal(isEditable(run({ trigger: 'schedule' }), []), false);
});

test('chat runs fork the session they resume, so a cancelled message never reaches the original', () => {
  const args = fork => buildClaudeArgs({ agent, allowedTools: [], resumeSessionId: 'sess', fork });
  assert.ok(args(true).includes('--fork-session'));
  assert.ok(!args(false).includes('--fork-session'));
  assert.ok(!buildClaudeArgs({ agent, allowedTools: [], fork: true }).includes('--fork-session')); // nothing to fork on a first message
});

test('pins keep their order, drop duplicates and refuse unknown agents or bad input', () => {
  const known = ['a', 'b', 'c'];
  assert.deepEqual(validatePins(['c', 'a', 'c'], known), ['c', 'a']);
  assert.deepEqual(validatePins([], known), []);
  assert.throws(() => validatePins(['a', 'zzz'], known), /unknown agent: zzz/);
  assert.throws(() => validatePins('a', known), /list of agent ids/);
  assert.throws(() => validatePins([1], known), /list of agent ids/);
});
