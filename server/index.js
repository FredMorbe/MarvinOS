import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import { openStore } from './store.js';
import { createBus } from './bus.js';
import { createRunner, folderKey } from './runner.js';
import { PERMISSION_MODES } from './adapters/claude.js';
import { CODEX_MODES, WITHDRAWN_NOTE } from './adapters/codex.js';
import { isAnswerEvent, isEditable, validatePins } from './chat.js';
import { listFolder } from './browse.js';
import { createTasks } from './tasks.js';
import { createScheduler, validateCron } from './scheduler.js';
import { slug } from './util.js';
import { createGraphs } from './graphs.js';
import { createGuard } from './guard.js';
import { createNotifier } from './notify.js';
import { validateSettings, withDefaults } from './settings.js';

const PORT = Number(process.env.AIOS_PORT ?? 4747);
const HOST = '127.0.0.1';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.AIOS_DATA ?? join(root, 'data');
const webDir = join(root, 'web');
const hubUrl = `http://${HOST}:${PORT}`;
const hubToken = randomBytes(24).toString('hex');

const store = openStore(join(dataDir, 'aios.db'));
const bus = createBus();
const graphs = createGraphs({ store, bus, dataDir, graphifyDir: join(root, 'tools', 'graphify') });
const runner = createRunner({ store, bus, graphs, hubUrl, hubToken, mcpScript: join(root, 'server', 'mcp', 'inbox-server.js'), runDir: join(dataDir, 'runs') });
const getPins = () => store.getSetting('chat_pins') ?? [];
const getSettings = () => withDefaults(store.getSetting('app'));
const guard = createGuard({ store, getSettings });
const scheduler = createScheduler({ store, runner, bus, guard, onChange: () => bus.push('agents', agentsView()) });
const notifier = createNotifier({ store, bus, hubUrl, getSettings, scriptPath: join(root, 'server', 'toast.ps1') });
const tasks = createTasks({ store, runner, bus, guard });
bus.onPush(({ type, data }) => { if (type === 'run') tasks.onRun(data); });
setInterval(() => tasks.dispatch(), 30000).unref(); // retries tasks the limit guard held back
runner.recoverOnStart();
scheduler.sync();
for (const a of store.listAgents()) graphs.ensureProject(a.cwd);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- snapshot ----------
function agentsView() {
  const midnight = new Date(); midnight.setHours(24, 0, 0, 0);
  return store.listAgents().map(a => ({
    ...a, next_run: scheduler.nextRun(a.id), upcoming: scheduler.upcoming(a.id, midnight.getTime()), deferred_until: scheduler.deferredUntil(a.id),
    last_run: store.listRuns({ agentId: a.id, limit: 1 })[0] ?? null,
  }));
}
function snapshot() {
  const runs = store.listRuns({ limit: 100 });
  const subagents = {};
  for (const r of runs.slice(0, 30)) subagents[r.id] = store.listSubagents(r.id);
  return { agents: agentsView(), runs, subagents, inbox: store.listInbox(), limits: store.getLimits(), tasks: store.listTasks(), graphs: graphs.list(), settings: getSettings(), notify: notifier.status(), chat_pins: getPins() };
}

// ---------- validation ----------
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']; // `claude --help`: --effort <level>
function parseAgent(b) {
  const errs = [];
  const str = (k, max = 10000) => (typeof b[k] === 'string' && b[k].trim() && b[k].length <= max ? b[k].trim() : (errs.push(`${k} is required`), ''));
  const opt = (k, max = 10000) => (b[k] === undefined || b[k] === null || b[k] === '' ? '' : typeof b[k] === 'string' && b[k].length <= max ? b[k].trim() : (errs.push(`${k} must be text of at most ${max} characters`), ''));
  const a = { name: str('name', 60), type: b.type, role: opt('role'), prompt: opt('prompt'), cwd: str('cwd', 500), schedule: null, allowed_tools: [], model: null, enabled: b.enabled !== false, memory: b.memory === true, priority: b.priority ?? 'normal' };
  if (!['low', 'normal', 'high'].includes(a.priority)) errs.push('priority must be low, normal or high');
  if (!['claude', 'codex', 'ollama'].includes(a.type)) errs.push('type must be claude, codex or ollama');
  if (a.cwd) {
    try { if (!statSync(a.cwd).isDirectory()) errs.push('cwd is not a directory'); } catch { errs.push(`cwd does not exist: ${a.cwd}`); }
  }
  if (b.schedule) {
    try { validateCron(String(b.schedule)); a.schedule = String(b.schedule).trim(); } catch (e) { errs.push(`schedule is not a valid cron expression (${e.message})`); }
  }
  if (b.allowed_tools !== undefined) {
    if (Array.isArray(b.allowed_tools) && b.allowed_tools.every(t => typeof t === 'string' && t.trim())) a.allowed_tools = b.allowed_tools.map(t => t.trim());
    else errs.push('allowed_tools must be an array of strings');
  }
  a.mode = b.mode ?? 'manual';
  if (!Object.hasOwn(PERMISSION_MODES, a.mode)) errs.push(`mode must be one of ${Object.keys(PERMISSION_MODES).join(', ')}`);
  if (b.model) a.model = String(b.model).trim();
  if (b.effort) {
    if (EFFORTS.includes(b.effort)) a.effort = b.effort; else errs.push(`effort must be one of ${EFFORTS.join(', ')}`);
  }
  if (a.type === 'codex') { // what the Codex adapter cannot do yet is refused, not silently ignored
    if (!Object.hasOwn(CODEX_MODES, a.mode)) errs.push(`mode "${a.mode}" is not available for Codex agents (use ${Object.keys(CODEX_MODES).join(', ')})`);
    if (a.effort) errs.push('effort is not supported for Codex agents yet');
    if (a.memory) errs.push('the memory graph is not supported for Codex agents yet');
  }
  if (!a.role && !a.prompt) errs.push('role is required (or a routine prompt)');
  if (a.schedule && !a.prompt) errs.push('a schedule needs a routine prompt');
  if (errs.length) throw new HttpError(400, errs.join('; '));
  return a;
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, handler, status = 200) =>
  routes.push({ method, status, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });
const int = s => { const n = Number(s); if (!Number.isInteger(n)) throw new HttpError(400, 'id must be an integer'); return n; };

route('GET', '/api/state', () => snapshot());

route('GET', '/api/runs/:id', ({ params }) => {
  const run = store.getRun(int(params.id));
  if (!run) throw new HttpError(404, 'run not found');
  return { run, events: store.listEvents(run.id), subagents: store.listSubagents(run.id) };
});
route('POST', '/api/runs/:id/stop', ({ params }) => {
  if (!runner.stop(int(params.id))) throw new HttpError(409, 'run is not active');
  return { ok: true };
});

route('POST', '/api/agents', ({ body }) => {
  const a = parseAgent(body);
  const id = slug(a.name);
  if (!id) throw new HttpError(400, 'name must contain letters or digits');
  if (store.getAgent(id)) throw new HttpError(409, `an agent with id "${id}" already exists`);
  store.insertAgent({ ...a, id });
  graphs.ensureProject(a.cwd);
  scheduler.sync();
  bus.push('agents', agentsView());
  bus.push('graphs', graphs.list());
  return { id };
}, 201);
route('PUT', '/api/agents/:id', ({ params, body }) => {
  if (!store.getAgent(params.id)) throw new HttpError(404, 'agent not found');
  const a = parseAgent(body);
  store.updateAgent(params.id, a);
  graphs.ensureProject(a.cwd);
  scheduler.sync();
  bus.push('agents', agentsView());
  bus.push('graphs', graphs.list());
  return { ok: true };
});
route('DELETE', '/api/agents/:id', ({ params }) => {
  if (store.listActiveRuns().some(r => r.agent_id === params.id)) throw new HttpError(409, 'agent has an active run; stop it first');
  if (!store.deleteAgent(params.id)) throw new HttpError(404, 'agent not found');
  scheduler.sync();
  bus.push('state', snapshot());
  return { ok: true };
});
route('POST', '/api/agents/:id/run', ({ params, body }) => {
  const agent = store.getAgent(params.id);
  if (!agent) throw new HttpError(404, 'agent not found');
  if (store.listActiveRuns().some(r => r.agent_id === agent.id)) throw new HttpError(409, 'agent already has an active run');
  // a manual start always goes through; the verdict is returned so the UI can say the guard would have held a scheduled run back
  const verdict = guard.check(agent);
  try { return { run: runner.enqueue(agent.id, { trigger: 'manual', prompt: typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.trim() : null }), guard: verdict }; }
  catch (e) { throw new HttpError(422, e.message); }
}, 201);

// ---- tasks: work for one agent in one project folder ----
const knownProject = path => store.listAgents().some(a => folderKey(a.cwd) === folderKey(path)) || graphs.list().some(g => folderKey(g.path) === folderKey(path));
function parseTask(b, existing) {
  const errs = [];
  const projectPath = existing ? existing.project_path : (typeof b.project_path === 'string' ? b.project_path.trim() : '');
  if (!existing && !knownProject(projectPath)) errs.push('project_path must be one of your projects');
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  if (!title || title.length > 200) errs.push('title is required (max 200 characters)');
  const body = b.body === undefined ? '' : b.body;
  if (typeof body !== 'string' || body.length > 10000) errs.push('body must be text (max 10000 characters)');
  let agentId = b.agent_id ?? null;
  if (agentId) {
    const a = store.getAgent(agentId);
    if (!a) errs.push(`unknown agent "${agentId}"`);
    else if (!['claude', 'codex'].includes(a.type)) errs.push(`agent "${a.name}" cannot run tasks yet (only Claude and Codex agents)`);
    else if (folderKey(a.cwd) !== folderKey(projectPath)) errs.push(`agent "${a.name}" works in another folder than the project`);
  } else agentId = null;
  if (b.auto === true && !agentId) errs.push('automatic start needs an agent');
  if (errs.length) throw new HttpError(400, errs.join('; '));
  return { project_path: projectPath, title, body, agent_id: agentId, auto: b.auto === true };
}
const taskById = id => { const t = store.getTask(int(id)); if (!t) throw new HttpError(404, 'task not found'); return t; };
const taskErr = e => new HttpError({ NOT_FOUND: 404, BAD: 400, BUSY: 409 }[e.code] ?? 422, e.message);

route('POST', '/api/tasks', ({ body }) => {
  const t = store.insertTask(parseTask(body));
  bus.push('task', t);
  tasks.dispatch();
  return store.getTask(t.id);
}, 201);
route('PUT', '/api/tasks/:id', ({ params, body }) => {
  const t = taskById(params.id);
  if (t.status === 'running' || t.status === 'waiting') throw new HttpError(409, 'task is active; stop it first');
  const { title, body: text, agent_id, auto } = parseTask(body, t);
  const u = store.updateTask(t.id, { title, body: text, agent_id, auto });
  bus.push('task', u);
  tasks.dispatch();
  return store.getTask(t.id);
});
route('DELETE', '/api/tasks/:id', ({ params }) => {
  const t = taskById(params.id);
  if (t.status === 'running') throw new HttpError(409, 'task is running; stop it first');
  store.deleteTask(t.id);
  bus.push('tasks', store.listTasks());
  return { ok: true };
});
route('POST', '/api/tasks/:id/start', ({ params }) => {
  taskById(params.id);
  try { return { guard: tasks.start(int(params.id)), task: store.getTask(int(params.id)) }; } catch (e) { throw taskErr(e); }
});
route('POST', '/api/tasks/:id/stop', ({ params }) => {
  const t = taskById(params.id);
  if (!t.last_run_id || !runner.stop(t.last_run_id)) throw new HttpError(409, 'task has no active run');
  return { ok: true };
});

// ---- chat: every message is a run that resumes the previous run's session ----
function chatThread(agentId) {
  const tip = store.listRuns({ agentId, limit: 200 }).find(r => store.rootRun(r.id).trigger === 'chat');
  const chain = [];
  for (let r = tip; r && chain.length < 50; r = r.parent_run_id ? store.getRun(r.parent_run_id) : null) chain.unshift(r);
  return chain;
}
route('GET', '/api/agents/:id/chat', ({ params }) => {
  if (!store.getAgent(params.id)) throw new HttpError(404, 'agent not found');
  return {
    runs: chatThread(params.id).map(run => {
      const events = store.listEvents(run.id).filter(isAnswerEvent);
      return { run, events, editable: isEditable(run, events) };
    }),
  };
});
const chatMessage = body => {
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message || message.length > 10000) throw new HttpError(400, 'message is required (max 10000 characters)');
  return message;
};
route('POST', '/api/agents/:id/chat', ({ params, body }) => {
  const agent = store.getAgent(params.id);
  if (!agent) throw new HttpError(404, 'agent not found');
  const message = chatMessage(body);
  if (store.listActiveRuns().some(r => r.agent_id === agent.id)) throw new HttpError(409, 'agent already has an active run');
  const resumeRun = body.new === true ? null : chatThread(agent.id).reverse().find(r => r.session_id) ?? null;
  const verdict = guard.check(agent); // like a manual start: never blocks, the UI just says so
  try { return { run: runner.enqueue(agent.id, { trigger: 'chat', prompt: message, resumeRun }), guard: verdict }; }
  catch (e) { throw new HttpError(422, e.message); }
}, 201);
// Edit a message the agent has not answered yet: the run is cancelled and the corrected text starts a new run from the same point of the thread.
route('POST', '/api/runs/:id/edit', async ({ params, body }) => {
  const run = store.getRun(int(params.id));
  if (!run) throw new HttpError(404, 'run not found');
  const message = chatMessage(body);
  if (!isEditable(run, store.listEvents(run.id))) throw new HttpError(409, 'this message cannot be edited any more: the agent has answered or the run is over');
  try { await runner.stopAndWait(run.id); } catch (e) { throw new HttpError(422, e.message); }
  // the answer can start in the moment between the check and the stop
  if (store.listEvents(run.id).some(isAnswerEvent)) throw new HttpError(409, 'the agent started answering while the run was stopped; the message was not replaced');
  if (store.listActiveRuns().some(r => r.agent_id === run.agent_id)) throw new HttpError(409, 'agent already has an active run');
  const agent = store.getAgent(run.agent_id);
  const resumeRun = run.parent_run_id ? store.getRun(run.parent_run_id) : null; // the same starting point the original message had
  store.addEvent(run.id, 'warning', { message: 'message edited and sent again as a new run' });
  try {
    return { run: runner.enqueue(agent.id, { trigger: 'chat', prompt: message, resumeRun, prefix: resumeRun && agent.type === 'codex' ? WITHDRAWN_NOTE : null }) };
  } catch (e) { throw new HttpError(422, e.message); }
}, 201);

route('PUT', '/api/chat/pins', ({ body }) => {
  let ids;
  try { ids = validatePins(body.ids, store.listAgents().map(a => a.id)); } catch (e) { throw new HttpError(400, e.message); }
  store.setSetting('chat_pins', ids);
  bus.push('chat_pins', ids);
  return { ids };
});

// ---- settings and notifications ----
route('GET', '/api/settings', () => ({ settings: getSettings(), notify: notifier.status() }));
route('PUT', '/api/settings', ({ body }) => {
  let v;
  try { v = validateSettings(body); } catch (e) { throw new HttpError(400, e.message); }
  store.setSetting('app', v);
  bus.push('settings', { settings: getSettings(), notify: notifier.status() });
  return { settings: getSettings() };
});
route('POST', '/api/notify/test', async () => {
  try { await notifier.test(); } catch (e) { throw new HttpError(422, e.message); }
  return { ok: true };
});

// ---- folder picker: sub-folders of a path (this machine only: the hub listens on 127.0.0.1 and checks Host/Origin) ----
route('GET', '/api/fs', ({ req }) => {
  try { return listFolder(new URL(req.url, hubUrl).searchParams.get('path') ?? ''); }
  catch (e) { throw new HttpError({ NOT_FOUND: 404, NOT_DIR: 400, DENIED: 403 }[e.code] ?? 500, e.message); }
});

// ---- memory graphs (Graphify) ----
route('GET', '/api/graphs', () => graphs.list());
route('POST', '/api/graphs', ({ body }) => {
  if (typeof body.path !== 'string' || !body.path.trim()) throw new HttpError(400, 'path is required');
  try { if (!statSync(body.path).isDirectory()) throw new Error(); } catch { throw new HttpError(400, `not a directory: ${body.path}`); }
  const project = graphs.ensureProject(body.path.trim());
  bus.push('graphs', graphs.list());
  return graphs.list().find(g => g.id === project.id);
}, 201);
route('DELETE', '/api/graphs/:id', ({ params }) => {
  const p = store.getGraphProject(params.id);
  if (!p) throw new HttpError(404, 'project not found');
  if (store.listAgents().some(a => folderKey(a.cwd) === folderKey(p.path))) throw new HttpError(409, 'agents work in this folder; delete or move them first');
  try { graphs.remove(params.id); } catch (e) { throw new HttpError({ NOT_FOUND: 404, BUSY: 409 }[e.code] ?? 500, e.message); }
  bus.push('graphs', graphs.list());
  return { ok: true };
});
route('POST', '/api/graphs/:id/build', ({ params }) => {
  try { return graphs.build(params.id); } catch (e) {
    throw new HttpError({ NOT_FOUND: 404, BUSY: 409, UNAVAILABLE: 422 }[e.code] ?? 500, e.message);
  }
}, 202);
route('GET', '/api/graphs/:id', ({ params, req }) => {
  const limit = Math.min(2000, Math.max(50, Number(new URL(req.url, hubUrl).searchParams.get('limit')) || 600));
  let v;
  try { v = graphs.view(params.id, limit); } catch (e) { throw new HttpError(500, e.message); }
  if (!v) throw new HttpError(404, 'no graph built for this project yet');
  return v;
});

// from the MCP inbox server: authenticated with the per-start token
route('POST', '/api/inbox', ({ req, body }) => {
  const given = Buffer.from(String(req.headers['x-aios-token'] ?? ''));
  const want = Buffer.from(hubToken);
  if (given.length !== want.length || !timingSafeEqual(given, want)) throw new HttpError(401, 'bad token');
  if (!['result', 'question', 'approval', 'warning'].includes(body.type)) throw new HttpError(400, 'invalid type');
  if (typeof body.title !== 'string' || !body.title.trim() || typeof body.body !== 'string' || !body.body.trim()) throw new HttpError(400, 'title and body are required');
  const run = store.getRun(Number(body.run_id));
  if (!run) throw new HttpError(404, 'run not found');
  const options = Array.isArray(body.options) ? body.options.filter(o => typeof o === 'string').slice(0, 4) : [];
  const permissions = Array.isArray(body.permissions) ? body.permissions.filter(p => typeof p === 'string' && p.trim()).map(p => p.trim().slice(0, 200)).slice(0, 5) : [];
  if (body.type === 'approval' && !permissions.length) throw new HttpError(400, 'an approval must list the tool permission patterns it needs in "permissions"');
  const item = store.addInbox({ run_id: run.id, agent_id: run.agent_id, type: body.type, title: body.title.trim().slice(0, 120), body: body.body, options, permissions });
  bus.push('inbox', item);
  return { id: item.id };
}, 201);

route('POST', '/api/inbox/:id/answer', ({ params, body }) => {
  const item = store.getInbox(int(params.id));
  if (!item) throw new HttpError(404, 'inbox item not found');
  if (item.type !== 'question' && item.type !== 'approval') throw new HttpError(400, 'only questions and approvals can be answered');
  if (item.status !== 'open') throw new HttpError(409, 'already answered');
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const choice = typeof body.choice === 'string' ? body.choice.trim() : '';
  if (item.type === 'approval' && !['approve', 'deny'].includes(choice)) throw new HttpError(400, 'choice must be "approve" or "deny"');
  if (item.type === 'question' && !text && !choice) throw new HttpError(400, 'an answer is required');
  const run = item.run_id && store.getRun(item.run_id);
  if (!run) throw new HttpError(409, 'the run behind this message no longer exists');
  if (runner.isLive(run.id)) throw new HttpError(409, 'the run is still active; answer once it has ended');

  const prompt = item.type === 'approval'
    ? (choice === 'approve'
      ? `The user APPROVED: "${item.title}". You may now perform it. Then finish and report with inbox_send type "result".`
      : `The user DENIED: "${item.title}". Do not perform it. Find an alternative or finish and report with inbox_send type "result".${text ? `\nUser note: ${text}` : ''}`)
    : `The user answered your question "${item.title}":\n${[choice, text].filter(Boolean).join('\n')}\nContinue your task.`;
  let resumed;
  // an approval grants exactly the listed patterns, for this resumed run only
  const extraTools = item.type === 'approval' && choice === 'approve' ? item.permissions : [];
  try { resumed = runner.enqueue(run.agent_id, { trigger: 'resume', prompt, resumeRun: run, extraTools }); }
  catch (e) { throw new HttpError(422, e.message); }

  store.updateInbox(item.id, { status: 'answered', answer: [choice, text].filter(Boolean).join(': '), answered_at: Date.now() });
  if (run.status === 'waiting') { store.updateRun(run.id, { status: 'done' }); bus.push('run', store.getRun(run.id)); }
  bus.push('inbox', store.getInbox(item.id));
  return { run: resumed };
});
for (const [action, status] of [['read', 'read'], ['archive', 'archived']]) {
  route('POST', `/api/inbox/:id/${action}`, ({ params }) => {
    const item = store.getInbox(int(params.id));
    if (!item) throw new HttpError(404, 'inbox item not found');
    if (item.status === 'open' && (item.type === 'question' || item.type === 'approval') && status === 'archived') throw new HttpError(409, 'answer it first');
    store.updateInbox(item.id, { status });
    bus.push('inbox', store.getInbox(item.id));
    return { ok: true };
  });
}

// ---------- http plumbing ----------
const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const allowedOrigins = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
// Host check blocks DNS rebinding; Origin check blocks other websites from driving agents through the browser.
const hostOk = req => allowedHosts.has(req.headers.host ?? '');
const originOk = req => !req.headers.origin || allowedOrigins.has(req.headers.origin);

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new HttpError(413, 'body too large');
    chunks.push(c);
  }
  if (!size) return {};
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'content-type must be application/json');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'invalid JSON'); }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = resolve(webDir, rel);
  if (file !== webDir && !file.startsWith(webDir + sep)) throw new HttpError(403, 'forbidden');
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' }).end(data);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EISDIR') throw new HttpError(404, 'not found');
    throw e;
  }
}

const send = (res, status, data) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));

const server = http.createServer(async (req, res) => {
  try {
    if (!hostOk(req)) throw new HttpError(403, 'bad host');
    const { pathname } = new URL(req.url, hubUrl);
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET') throw new HttpError(405, 'method not allowed');
      return await serveStatic(req, res, pathname);
    }
    if (req.method !== 'GET' && !originOk(req)) throw new HttpError(403, 'bad origin');
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const body = req.method === 'GET' ? {} : await readJson(req);
      return send(res, r.status, await r.handler({ req, params: m.groups ?? {}, body }));
    }
    throw new HttpError(404, 'no such endpoint');
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(`${req.method} ${req.url}:`, e);
    if (!res.headersSent) send(res, e.status ?? 500, { error: e.status ? e.message : `internal error: ${e.message}` });
    else res.end();
  }
});

// ---------- websocket ----------
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const ok = hostOk(req) && originOk(req) && new URL(req.url, hubUrl).pathname === '/ws';
  if (!ok) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, ws => {
    ws.on('error', e => console.error('websocket:', e.message));
    ws.send(JSON.stringify({ type: 'state', data: snapshot() }));
  });
});
const broadcast = msg => { const s = JSON.stringify(msg); for (const c of wss.clients) if (c.readyState === 1) c.send(s); };
bus.onPush(msg => {
  broadcast(msg);
  if (msg.type === 'run') broadcast({ type: 'agents', data: agentsView() }); // last_run / next_run changed
});

server.listen(PORT, HOST, () => console.log(`AIOS hub on ${hubUrl}`));

function shutdown() {
  console.log('shutting down, stopping runs');
  runner.stopAll();
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Started by the Electron shell with an IPC channel: it asks for shutdown, and a vanished parent counts as one.
if (process.send) {
  process.on('message', m => { if (m === 'shutdown') shutdown(); });
  process.on('disconnect', shutdown);
}
