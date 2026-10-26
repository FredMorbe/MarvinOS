import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeStream, buildClaudeArgs, INBOX_TOOL } from '../server/adapters/claude.js';

const assistant = (id, blocks, { parent = null, usage = { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 5000, output_tokens: 10 } } = {}) =>
  ({ type: 'assistant', parent_tool_use_id: parent, message: { id, content: blocks, usage } });
const kinds = events => events.map(e => e.kind);

test('init event carries session id and MCP status', () => {
  const [ev] = new ClaudeStream().push({ type: 'system', subtype: 'init', session_id: 's1', model: 'm', tools: ['Task'], mcp_servers: [{ name: 'aios', status: 'connected' }] });
  assert.equal(ev.kind, 'init');
  assert.equal(ev.session_id, 's1');
  assert.equal(ev.mcp_servers[0].name, 'aios');
});

test('Task tool_use starts a subagent and its tool_result ends it, with the hand-back wrapper removed', () => {
  const s = new ClaudeStream();
  const start = s.push(assistant('m1', [{ type: 'tool_use', id: 'toolu_1', name: 'Task', input: { subagent_type: 'Explore', description: 'list files', prompt: 'p' } }]));
  assert.deepEqual(kinds(start), ['subagent_start', 'usage']);
  assert.equal(start[0].type, 'Explore');
  assert.equal(start[0].parent_tool_use_id, null);

  const wrapped = '[Subagent hand-back] notice\nThe report follows:\n  two files\n  - a.txt';
  const end = s.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: wrapped }] }] } });
  assert.deepEqual(kinds(end), ['subagent_end']);
  assert.equal(end[0].text, 'two files\n- a.txt');
  assert.equal(end[0].is_error, false);
});

test('a nested Task call records the outer subagent as its parent', () => {
  const s = new ClaudeStream();
  s.push(assistant('m1', [{ type: 'tool_use', id: 'outer', name: 'Task', input: {} }]));
  const [nested] = s.push(assistant('m2', [{ type: 'tool_use', id: 'inner', name: 'Task', input: {} }], { parent: 'outer' }));
  assert.equal(nested.parent_tool_use_id, 'outer');
});

test('tokens are counted once per message id, per owner, and exclude cache reads', () => {
  const s = new ClaudeStream();
  s.push(assistant('m1', [{ type: 'text', text: 'a' }]));
  s.push(assistant('m1', [{ type: 'tool_use', id: 't', name: 'Read', input: {} }])); // same message, second content block
  s.push(assistant('m2', [{ type: 'text', text: 'b' }], { parent: 'sub' }));
  const totals = s.tokenTotals();
  assert.equal(totals.get('main'), 112);   // 2 + 100 + 10, once
  assert.equal(totals.get('sub'), 112);
});

test('a failed non-subagent tool result is surfaced as tool_error; successes are not', () => {
  const s = new ClaudeStream();
  const out = s.push({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'x', is_error: true, content: 'Permission to use Write has been denied' },
    { type: 'tool_result', tool_use_id: 'y', content: 'ok' },
  ] } });
  assert.deepEqual(kinds(out), ['tool_error']);
  assert.match(out[0].text, /denied/);
});

test('rate_limit_event and result are passed through; unknown types are not dropped silently', () => {
  const s = new ClaudeStream();
  assert.deepEqual(kinds(s.push({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: {} } })), ['rate']);
  const [res] = s.push({ type: 'result', is_error: false, result: 'done', session_id: 's', num_turns: 3, duration_ms: 10 });
  assert.equal(res.kind, 'result');
  assert.equal(res.turns, 3);
  assert.deepEqual(kinds(s.push({ type: 'something_new' })), ['unknown']);
});

test('CLI args: unattended permission mode, strict MCP, inbox tool always allowed, extra tools appended', () => {
  const args = buildClaudeArgs({ agent: { model: null }, allowedTools: ['Read', 'Bash(npm test)'], resumeSessionId: 'abc', mcpConfigFile: 'c.json' });
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf('--resume') + 1], 'abc');
  assert.equal(args.at(-1), `${INBOX_TOOL},Read,Bash(npm test)`);
  assert.ok(!args.includes('--model'));
});

test('CLI args: permission modes map to the CLI, only manual may still prompt the inbox path', () => {
  const mode = m => buildClaudeArgs({ agent: { mode: m }, allowedTools: [], mcpConfigFile: 'c.json' });
  const val = (a, f) => a[a.indexOf(f) + 1];
  assert.equal(val(mode(undefined), '--permission-mode'), 'dontAsk');
  assert.ok(!mode('manual').includes('--permission-prompts'));
  for (const [m, cli] of [['acceptEdits', 'acceptEdits'], ['plan', 'plan'], ['auto', 'auto']]) {
    assert.equal(val(mode(m), '--permission-mode'), cli);
    assert.equal(val(mode(m), '--permission-prompts'), 'none');
  }
  assert.throws(() => mode('bypass'), /unknown permission mode/);
});

test('CLI args: model and effort are passed only when set', () => {
  const args = buildClaudeArgs({ agent: { model: 'opus', effort: 'high' }, allowedTools: [], mcpConfigFile: 'c.json' });
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
  assert.equal(args[args.indexOf('--effort') + 1], 'high');
  assert.ok(!buildClaudeArgs({ agent: { model: null, effort: null }, allowedTools: [], mcpConfigFile: 'c.json' }).includes('--effort'));
});
