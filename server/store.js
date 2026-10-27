import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('claude','codex','ollama')),
  prompt TEXT NOT NULL,
  cwd TEXT NOT NULL,
  schedule TEXT,
  allowed_tools TEXT NOT NULL DEFAULT '[]',
  model TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  parent_run_id INTEGER,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  session_id TEXT,
  prompt TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  tokens INTEGER NOT NULL DEFAULT 0,
  turns INTEGER,
  error TEXT,
  result_text TEXT
);
CREATE INDEX IF NOT EXISTS runs_agent ON runs(agent_id, id DESC);
CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_events_run ON run_events(run_id, id);
CREATE TABLE IF NOT EXISTS subagents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  tool_use_id TEXT NOT NULL,
  parent_tool_use_id TEXT,
  type TEXT,
  description TEXT,
  prompt TEXT,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  tokens INTEGER NOT NULL DEFAULT 0,
  result_text TEXT,
  UNIQUE (run_id, tool_use_id)
);
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('result','question','approval','warning')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  permissions TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open',
  answer TEXT,
  created_at INTEGER NOT NULL,
  answered_at INTEGER
);
CREATE TABLE IF NOT EXISTS limits (
  provider TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

// Schema changes after the first release go here, in order. PRAGMA user_version records how many ran.
const MIGRATIONS = [
  'ALTER TABLE agents ADD COLUMN memory INTEGER NOT NULL DEFAULT 0',
  `CREATE TABLE IF NOT EXISTS graph_projects (
     id TEXT PRIMARY KEY,
     path TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  "ALTER TABLE agents ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'",
  `CREATE TABLE IF NOT EXISTS tasks (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     project_path TEXT NOT NULL,
     title TEXT NOT NULL,
     body TEXT NOT NULL DEFAULT '',
     agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
     auto INTEGER NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'todo',
     run_id INTEGER,
     last_run_id INTEGER,
     note TEXT,
     created_at INTEGER NOT NULL,
     finished_at INTEGER
   )`,
  'ALTER TABLE agents ADD COLUMN effort TEXT',
  "ALTER TABLE agents ADD COLUMN role TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE agents ADD COLUMN mode TEXT NOT NULL DEFAULT 'manual'",
  'ALTER TABLE agents ADD COLUMN account TEXT', // Claude account (accounts.js); NULL = the default account
  'ALTER TABLE runs ADD COLUMN account TEXT', // account the run used; its session only resumes there. NULL = a run from before accounts, or a Codex run
];

const RUN_COLS = new Set(['status', 'session_id', 'started_at', 'ended_at', 'tokens', 'turns', 'error', 'result_text']);
const SUB_COLS = new Set(['status', 'ended_at', 'tokens', 'result_text']);
const INBOX_COLS = new Set(['status', 'answer', 'answered_at']);
const TASK_COLS = new Set(['title', 'body', 'agent_id', 'auto', 'status', 'run_id', 'last_run_id', 'note', 'finished_at']);

const clean = v => (v === undefined ? null : v);

function patch(db, table, cols, id, fields) {
  const keys = Object.keys(fields);
  for (const k of keys) if (!cols.has(k)) throw new Error(`${table}: column "${k}" is not patchable`);
  if (!keys.length) return;
  db.prepare(`UPDATE ${table} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => clean(fields[k])), id);
}

const agentOut = r => r && { ...r, allowed_tools: JSON.parse(r.allowed_tools), enabled: !!r.enabled, memory: !!r.memory };
const taskOut = r => r && { ...r, auto: !!r.auto };
const inboxOut = r => r && { ...r, options: JSON.parse(r.options), permissions: JSON.parse(r.permissions) };

export function openStore(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  const applied = db.prepare('PRAGMA user_version').get().user_version;
  MIGRATIONS.slice(applied).forEach((sql, i) => {
    db.exec(sql);
    db.exec(`PRAGMA user_version = ${applied + i + 1}`);
  });

  return {
    db,

    // ---- agents ----
    listAgents: () => db.prepare('SELECT * FROM agents ORDER BY created_at, id').all().map(agentOut),
    getAgent: id => agentOut(db.prepare('SELECT * FROM agents WHERE id = ?').get(id)),
    insertAgent(a) {
      db.prepare('INSERT INTO agents (id, name, type, role, prompt, cwd, schedule, allowed_tools, model, effort, mode, enabled, memory, priority, account, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(a.id, a.name, a.type, a.role ?? '', a.prompt ?? '', a.cwd, clean(a.schedule), JSON.stringify(a.allowed_tools ?? []), clean(a.model), clean(a.effort), a.mode ?? 'manual', a.enabled === false ? 0 : 1, a.memory ? 1 : 0, a.priority ?? 'normal', clean(a.account), Date.now());
      return this.getAgent(a.id);
    },
    updateAgent(id, a) {
      db.prepare('UPDATE agents SET name=?, type=?, role=?, prompt=?, cwd=?, schedule=?, allowed_tools=?, model=?, effort=?, mode=?, enabled=?, memory=?, priority=?, account=? WHERE id=?')
        .run(a.name, a.type, a.role ?? '', a.prompt ?? '', a.cwd, clean(a.schedule), JSON.stringify(a.allowed_tools ?? []), clean(a.model), clean(a.effort), a.mode ?? 'manual', a.enabled === false ? 0 : 1, a.memory ? 1 : 0, a.priority ?? 'normal', clean(a.account), id);
      return this.getAgent(id);
    },
    deleteAgent: id => db.prepare('DELETE FROM agents WHERE id = ?').run(id).changes > 0,

    // ---- runs ----
    createRun(r) {
      const info = db.prepare('INSERT INTO runs (agent_id, parent_run_id, trigger, status, session_id, prompt, account, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(r.agent_id, clean(r.parent_run_id), r.trigger, r.status, clean(r.session_id), r.prompt, clean(r.account), Date.now());
      return this.getRun(Number(info.lastInsertRowid));
    },
    getRun: id => db.prepare('SELECT * FROM runs WHERE id = ?').get(id),
    updateRun: (id, fields) => patch(db, 'runs', RUN_COLS, id, fields),
    /** the first run of a resume chain: its trigger says whether the thread is a chat */
    rootRun(id) {
      let r = this.getRun(id);
      while (r?.parent_run_id) { const p = this.getRun(r.parent_run_id); if (!p) break; r = p; }
      return r;
    },
    listRuns: ({ agentId, limit = 50 } = {}) => agentId
      ? db.prepare('SELECT * FROM runs WHERE agent_id = ? ORDER BY id DESC LIMIT ?').all(agentId, limit)
      : db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit),
    listActiveRuns: () => db.prepare("SELECT * FROM runs WHERE status IN ('queued','running') ORDER BY id").all(),

    addEvent: (runId, kind, data) => db.prepare('INSERT INTO run_events (run_id, ts, kind, data) VALUES (?,?,?,?)').run(runId, Date.now(), kind, JSON.stringify(data)),
    listEvents: (runId, limit = 500) => db.prepare('SELECT id, ts, kind, data FROM run_events WHERE run_id = ? ORDER BY id LIMIT ?').all(runId, limit).map(e => ({ ...e, data: JSON.parse(e.data) })),

    // ---- subagents ----
    upsertSubagent(s) {
      db.prepare(`INSERT INTO subagents (run_id, tool_use_id, parent_tool_use_id, type, description, prompt, status, started_at)
                  VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (run_id, tool_use_id) DO NOTHING`)
        .run(s.run_id, s.tool_use_id, clean(s.parent_tool_use_id), clean(s.type), clean(s.description), clean(s.prompt), 'running', Date.now());
      return this.getSubagent(s.run_id, s.tool_use_id);
    },
    getSubagent: (runId, toolUseId) => db.prepare('SELECT * FROM subagents WHERE run_id = ? AND tool_use_id = ?').get(runId, toolUseId),
    updateSubagent(runId, toolUseId, fields) {
      const row = this.getSubagent(runId, toolUseId);
      if (!row) throw new Error(`unknown subagent ${toolUseId} in run ${runId}`);
      patch(db, 'subagents', SUB_COLS, row.id, fields);
      return this.getSubagent(runId, toolUseId);
    },
    listSubagents: runId => db.prepare('SELECT * FROM subagents WHERE run_id = ? ORDER BY id').all(runId),
    stopRunningSubagents: runId => db.prepare("UPDATE subagents SET status = 'stopped', ended_at = ? WHERE run_id = ? AND status = 'running'").run(Date.now(), runId),

    // ---- inbox ----
    addInbox(i) {
      const info = db.prepare('INSERT INTO inbox (run_id, agent_id, type, title, body, options, permissions, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(clean(i.run_id), i.agent_id, i.type, i.title, i.body, JSON.stringify(i.options ?? []), JSON.stringify(i.permissions ?? []), Date.now());
      return this.getInbox(Number(info.lastInsertRowid));
    },
    getInbox: id => inboxOut(db.prepare('SELECT * FROM inbox WHERE id = ?').get(id)),
    updateInbox: (id, fields) => patch(db, 'inbox', INBOX_COLS, id, fields),
    listInbox: ({ limit = 100 } = {}) => db.prepare("SELECT * FROM inbox WHERE status != 'archived' ORDER BY id DESC LIMIT ?").all(limit).map(inboxOut),
    openBlockingForRun: runId => db.prepare("SELECT * FROM inbox WHERE run_id = ? AND status = 'open' AND type IN ('question','approval')").all(runId).map(inboxOut),

    // ---- tasks ----
    insertTask(t) {
      const info = db.prepare('INSERT INTO tasks (project_path, title, body, agent_id, auto, created_at) VALUES (?,?,?,?,?,?)')
        .run(t.project_path, t.title, t.body ?? '', clean(t.agent_id), t.auto ? 1 : 0, Date.now());
      return this.getTask(Number(info.lastInsertRowid));
    },
    getTask: id => taskOut(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)),
    listTasks: (limit = 500) => db.prepare('SELECT * FROM tasks ORDER BY id DESC LIMIT ?').all(limit).map(taskOut),
    taskForRun: runId => taskOut(db.prepare('SELECT * FROM tasks WHERE run_id = ?').get(runId)),
    updateTask(id, fields) { patch(db, 'tasks', TASK_COLS, id, { ...fields, ...('auto' in fields ? { auto: fields.auto ? 1 : 0 } : {}) }); return this.getTask(id); },
    deleteTask: id => db.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes > 0,

    // ---- graph projects ----
    upsertGraphProject(p) {
      db.prepare('INSERT INTO graph_projects (id, path, name, created_at) VALUES (?,?,?,?) ON CONFLICT (id) DO NOTHING').run(p.id, p.path, p.name, Date.now());
      return this.getGraphProject(p.id);
    },
    getGraphProject: id => db.prepare('SELECT * FROM graph_projects WHERE id = ?').get(id),
    deleteGraphProject: id => db.prepare('DELETE FROM graph_projects WHERE id = ?').run(id).changes > 0,
    listGraphProjects: () => db.prepare('SELECT * FROM graph_projects ORDER BY created_at, id').all(),

    // ---- settings ----
    getSetting(key) {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return row ? JSON.parse(row.value) : null;
    },
    setSetting: (key, value) => db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value)),

    // ---- limits ----
    setLimits(provider, data) {
      db.prepare('INSERT INTO limits (provider, data, updated_at) VALUES (?,?,?) ON CONFLICT (provider) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
        .run(provider, JSON.stringify(data), Date.now());
    },
    getLimits: () => Object.fromEntries(db.prepare('SELECT * FROM limits').all().map(r => [r.provider, { ...JSON.parse(r.data), updated_at: r.updated_at }])),
  };
}
