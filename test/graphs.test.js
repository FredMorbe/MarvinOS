import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { toView, projectIdFor, GRAPH_TOOLS } from '../server/graphs.js';
import { buildClaudeArgs, MEMORY_APPEND } from '../server/adapters/claude.js';

// same shape as a real `graphify extract --code-only` result (schema_version 1)
const node = (id, label, community, extra = {}) => ({ id, label, community, file_type: 'code', source_file: `${id}.js`, source_location: 'L7', ...extra });
const link = (source, target, extra = {}) => ({ source, target, relation: 'calls', confidence: 'EXTRACTED', ...extra });
const fixture = () => ({
  directed: false, multigraph: false, graph: { schema_version: 1, graphify_version: '0.9.95' },
  nodes: [
    node('a', 'Alpha', 0, { _callable: true, _callable_class: true }), node('b', 'beta()', 0, { _callable: true }), node('c', 'gamma()', 0, { _callable: true }),
    node('d', 'delta.js', 1, { source_file: 'src/delta.js' }), node('e', 'epsilon()', 1, { _callable: true }),
    node('x', 'node:http', 1, { external: true }),
  ],
  links: [link('a', 'b'), link('a', 'c'), link('b', 'c', { relation: 'contains' }), link('a', 'd', { confidence: 'INFERRED' }), link('d', 'e'), link('e', 'x'), link('a', 'a')],
});

test('refuses an unknown schema version instead of guessing', () => {
  const g = fixture(); g.graph.schema_version = 2;
  assert.throws(() => toView(g), /unsupported graphify schema_version 2/);
});

test('drops external nodes, self loops and links to externals; counts the rest', () => {
  const v = toView(fixture());
  assert.equal(v.stats.nodes, 5);
  assert.equal(v.stats.edges, 5);           // a-b a-c b-c a-d d-e
  assert.ok(!v.nodes.some(n => n.id === 'x'));
});

test('kinds, edge confidence, lines, and degree ordering', () => {
  const v = toView(fixture());
  assert.equal(v.nodes[0].id, 'a');         // highest degree first
  assert.equal(v.nodes[0].kind, 'class');
  assert.equal(v.nodes.find(n => n.id === 'b').kind, 'function');
  assert.equal(v.nodes.find(n => n.id === 'd').kind, 'file');
  assert.equal(v.nodes.find(n => n.id === 'a').line, 7);
  const inferred = v.edges.filter(e => e.kind === 'INFERRED');
  assert.equal(inferred.length, 1);
  assert.equal(v.nodes[inferred[0].a].id === 'a' || v.nodes[inferred[0].b].id === 'a', true);
});

test('communities get dense ids by size and are named after their most connected member', () => {
  const v = toView(fixture());
  assert.deepEqual(v.communities.map(c => [c.id, c.size, c.label]), [[0, 3, 'Alpha'], [1, 2, 'src/delta.js']]);
  assert.equal(v.nodes.find(n => n.id === 'e').community, 1);
  assert.deepEqual(v.nodes.filter(n => n.top).map(n => n.id).sort(), ['a', 'd']);
});

test('limit keeps the best-connected nodes, drops edges to removed ones and reports truncation', () => {
  const v = toView(fixture(), 2);
  assert.equal(v.nodes.length, 2);
  assert.equal(v.stats.truncated, true);
  assert.equal(v.stats.nodes, 5);           // totals are unaffected by the limit
  assert.ok(v.edges.every(e => e.a < 2 && e.b < 2));
});

test('project ids are stable per folder, readable, and case-insensitive on the path', () => {
  const id = projectIdFor(join('D:', 'Workspace', 'My Project'));
  assert.match(id, /^my-project-[0-9a-f]{6}$/);
  assert.equal(projectIdFor(join('d:', 'workspace', 'my project')), process.platform === 'win32' ? id : projectIdFor(join('d:', 'workspace', 'my project')));
  assert.notEqual(projectIdFor(join('D:', 'Workspace', 'Other')), id);
});

test('memory tools are read-only graph queries only', () => {
  assert.ok(GRAPH_TOOLS.includes('mcp__graphify__query_graph'));
  assert.ok(!GRAPH_TOOLS.some(t => /_pr/.test(t)));
});

test('memory hint is only added to the system prompt when a graph is attached', () => {
  const base = { agent: { model: null }, allowedTools: [], mcpConfigFile: 'c.json' };
  const prompt = a => a[a.indexOf('--append-system-prompt') + 1];
  assert.ok(!prompt(buildClaudeArgs(base)).includes('graphify'));
  assert.ok(prompt(buildClaudeArgs({ ...base, memory: true })).includes(MEMORY_APPEND));
});
