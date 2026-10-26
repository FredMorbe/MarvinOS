// Memory graphs built by Graphify (https://github.com/Graphify-Labs/graphify), pinned and installed into tools/graphify.
// Code is parsed locally with tree-sitter. GRAPHIFY_BACKEND=none keeps every LLM path off, including the
// `claude -p` fallback that would otherwise spend subscription quota. We never run `graphify install` or its hooks.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { slug } from './util.js';

const SUPPORTED_SCHEMA = 1;
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;
const GRAPHIFY_ENV = { GRAPHIFY_BACKEND: 'none', GRAPHIFY_QUERY_LOG_DISABLE: '1', PYTHONUTF8: '1' };
// read-only graph tools; the PR tools of the MCP server (list_prs, ...) are deliberately not allowed
export const GRAPH_TOOLS = ['query_graph', 'get_node', 'get_neighbors', 'get_community', 'god_nodes', 'graph_stats', 'shortest_path'].map(t => `mcp__graphify__${t}`);

export const projectIdFor = path => {
  const abs = resolve(path);
  return `${slug(basename(abs)) || 'project'}-${createHash('sha1').update(abs.toLowerCase()).digest('hex').slice(0, 6)}`;
};

// files are labelled by path: two index.js in different folders must be tell-apart-able
const labelOf = n => (kindOf(n) === 'file' && n.source_file ? n.source_file : String(n.label ?? n.id));
const kindOf = n => (n._callable_class ? 'class' : n._callable ? 'function' : n.file_type === 'concept' ? 'concept' : /\.[a-z0-9]+$/i.test(n.label ?? '') ? 'file' : 'node');

/** graph.json (+ analysis) -> compact view for the UI: top `limit` nodes by degree, dense community ids. Pure. */
export function toView(graph, limit = 600) {
  const schema = graph.graph?.schema_version;
  if (schema !== SUPPORTED_SCHEMA) throw new Error(`unsupported graphify schema_version ${schema} (expected ${SUPPORTED_SCHEMA}); update server/graphs.js`);

  const raw = new Map();
  for (const n of graph.nodes ?? []) if (!n.external) raw.set(n.id, n);
  const deg = new Map();
  const links = [];
  for (const l of graph.links ?? []) {
    if (l.source === l.target || !raw.has(l.source) || !raw.has(l.target)) continue;
    links.push(l);
    deg.set(l.source, (deg.get(l.source) ?? 0) + 1);
    deg.set(l.target, (deg.get(l.target) ?? 0) + 1);
  }
  const ranked = [...raw.values()].sort((a, b) => (deg.get(b.id) ?? 0) - (deg.get(a.id) ?? 0) || String(a.id).localeCompare(String(b.id)));

  // communities over ALL nodes, so labels and sizes do not depend on the display limit
  const byComm = new Map();
  for (const n of ranked) {
    if (!byComm.has(n.community)) byComm.set(n.community, []);
    byComm.get(n.community).push(n);
  }
  const kept = ranked.slice(0, limit);
  const keptComms = new Set(kept.map(n => n.community));
  const order = [...byComm.entries()].filter(([c]) => keptComms.has(c)).sort((a, b) => b[1].length - a[1].length);
  const dense = new Map(order.map(([c], i) => [c, i]));
  const communities = order.map(([c, members], i) => ({
    id: i, size: members.length, shown: kept.filter(n => n.community === c).length,
    label: labelOf(members[0]).replace(/\(\)$/, ''), // most connected member names the community
  }));

  const index = new Map(kept.map((n, i) => [n.id, i]));
  const topOfComm = new Set(order.map(([, members]) => members[0].id));
  const nodes = kept.map(n => ({
    id: n.id, label: labelOf(n), community: dense.get(n.community), kind: kindOf(n),
    file: n.source_file ?? null, line: /^L(\d+)/.exec(n.source_location ?? '')?.[1] ? Number(/^L(\d+)/.exec(n.source_location)[1]) : null,
    deg: deg.get(n.id) ?? 0, top: topOfComm.has(n.id),
  }));
  const seen = new Set();
  const edges = [];
  for (const l of links) {
    const a = index.get(l.source), b = index.get(l.target);
    if (a === undefined || b === undefined) continue;
    const key = `${a}|${b}|${l.relation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ a, b, kind: l.confidence === 'INFERRED' ? 'INFERRED' : 'EXTRACTED', rel: l.relation ?? '' });
  }
  return {
    graphify_version: graph.graph?.graphify_version ?? null,
    stats: { nodes: raw.size, edges: links.length, communities: byComm.size, shown_nodes: nodes.length, shown_edges: edges.length, truncated: raw.size > nodes.length },
    communities, nodes, edges,
  };
}

export function createGraphs({ store, bus, dataDir, graphifyDir }) {
  const graphsDir = join(dataDir, 'graphs');
  mkdirSync(graphsDir, { recursive: true });
  const bin = name => join(graphifyDir, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? `${name}.exe` : name);
  const exe = bin('graphify'), python = bin('python');
  const jobs = new Map();      // id -> { started_at }  (at most one: extraction is CPU heavy)
  const failures = new Map();  // id -> error text of the last failed build
  const rawCache = new Map();  // id -> { mtimeMs, graph }

  const dirOf = id => join(graphsDir, id, 'graphify-out');
  const graphFile = id => join(dirOf(id), 'graph.json');
  const metaFile = id => join(graphsDir, id, 'meta.json');

  function ensureProject(path) {
    const abs = resolve(path);
    const id = projectIdFor(abs);
    return store.upsertGraphProject({ id, path: abs, name: basename(abs) || abs });
  }

  function describe(p) {
    let meta = null;
    try { meta = JSON.parse(readFileSync(metaFile(p.id), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const status = jobs.has(p.id) ? 'building' : failures.has(p.id) ? 'failed' : meta && existsSync(graphFile(p.id)) ? 'ready' : 'not_built';
    return { id: p.id, name: p.name, path: p.path, status, error: failures.get(p.id) ?? null, building_since: jobs.get(p.id)?.started_at ?? null, ...(meta ?? {}) };
  }
  const list = () => store.listGraphProjects().map(describe);
  /** forget a folder; its graph is derived data and can be rebuilt, so it is deleted with it */
  function remove(id) {
    if (!store.getGraphProject(id)) throw Object.assign(new Error('unknown project'), { code: 'NOT_FOUND' });
    if (jobs.has(id)) throw Object.assign(new Error('the graph of this project is being built; try again when it has finished'), { code: 'BUSY' });
    store.deleteGraphProject(id);
    failures.delete(id);
    rmSync(join(graphsDir, id), { recursive: true, force: true });
  }
  const publish = id => bus.push('graph', describe(store.getGraphProject(id)));

  function build(id) {
    const project = store.getGraphProject(id);
    if (!project) throw Object.assign(new Error('unknown graph project'), { code: 'NOT_FOUND' });
    if (jobs.size) throw Object.assign(new Error('another graph build is running; try again when it has finished'), { code: 'BUSY' });
    if (!existsSync(exe)) throw Object.assign(new Error('Graphify is not installed. Run: npm run setup:graphify'), { code: 'UNAVAILABLE' });
    try { if (!statSync(project.path).isDirectory()) throw new Error('not a directory'); } catch (e) { throw Object.assign(new Error(`project folder is not available: ${project.path}`), { code: 'UNAVAILABLE' }); }

    const started = Date.now();
    jobs.set(id, { started_at: started });
    failures.delete(id);
    publish(id);
    let tail = '';
    const child = spawn(exe, ['extract', project.path, '--code-only', '--max-workers', '2', '--out', join(graphsDir, id)], {
      env: { ...process.env, ...GRAPHIFY_ENV }, cwd: dataDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const collect = d => { tail = (tail + d).slice(-3000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      tail += '\nbuild timed out';
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else child.kill('SIGTERM');
    }, BUILD_TIMEOUT_MS);

    let done = false;
    const finish = error => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      jobs.delete(id);
      if (error) failures.set(id, error);
      publish(id);
    };
    child.on('error', e => finish(`could not start graphify: ${e.message}`));
    child.on('close', code => {
      if (code !== 0 || !existsSync(graphFile(id))) return finish(tail.trim().split('\n').slice(-6).join('\n') || `graphify exited with code ${code}`);
      try {
        const view = toView(readGraph(id), 1); // validates the schema and counts everything
        writeFileSync(metaFile(id), JSON.stringify({ built_at: Date.now(), duration_ms: Date.now() - started, graphify_version: view.graphify_version, nodes: view.stats.nodes, edges: view.stats.edges, communities: view.stats.communities }));
        finish(null);
      } catch (e) { finish(`graph could not be read: ${e.message}`); }
    });
    return describe(project);
  }

  function readGraph(id) {
    const file = graphFile(id);
    const { mtimeMs } = statSync(file);
    const hit = rawCache.get(id);
    if (hit?.mtimeMs === mtimeMs) return hit.graph;
    const graph = JSON.parse(readFileSync(file, 'utf8'));
    rawCache.set(id, { mtimeMs, graph });
    return graph;
  }

  /** compact view for the UI, or null when the project has no graph yet */
  function view(id, limit = 600) {
    if (!store.getGraphProject(id) || !existsSync(graphFile(id))) return null;
    return { project: describe(store.getGraphProject(id)), ...toView(readGraph(id), limit) };
  }

  /** MCP server definition that lets an agent query the graph of its working folder, or null if none is built */
  function mcpFor(cwd) {
    const id = projectIdFor(cwd);
    if (!existsSync(graphFile(id)) || !existsSync(python)) return null;
    return { server: { command: python, args: ['-m', 'graphify.serve', graphFile(id)], env: GRAPHIFY_ENV }, tools: GRAPH_TOOLS };
  }

  return { ensureProject, list, build, remove, view, mcpFor };
}
