import { folderKey } from './runner.js';

const RUN_TO_TASK = { queued: 'running', running: 'running', waiting: 'waiting', done: 'done', failed: 'failed', stopped: 'stopped' };
const ACTIVE = new Set(['running', 'waiting']);
export const taskPrompt = t => `Task: ${t.title}${t.body.trim() ? `\n\n${t.body.trim()}` : ''}`;

/**
 * Tasks belong to a project folder and are done by one agent working in that folder. A task's run is the first run it started;
 * answering a question resumes that run, so every later run of the chain keeps updating the same task.
 */
export function createTasks({ store, runner, bus, guard, now = Date.now }) {
  const publish = id => bus.push('task', store.getTask(id));
  const busy = agentId => store.listActiveRuns().some(r => r.agent_id === agentId);

  /** start (or restart) a task. Returns the guard verdict; throws Error with .code BAD | BUSY */
  function start(taskId) {
    const t = store.getTask(taskId);
    if (!t) throw Object.assign(new Error('task not found'), { code: 'NOT_FOUND' });
    if (ACTIVE.has(t.status)) throw Object.assign(new Error('task is already running'), { code: 'BUSY' });
    const agent = t.agent_id && store.getAgent(t.agent_id);
    if (!agent) throw Object.assign(new Error('assign an agent first'), { code: 'BAD' });
    if (folderKey(agent.cwd) !== folderKey(t.project_path)) throw Object.assign(new Error(`agent "${agent.name}" works in another folder than the project`), { code: 'BAD' });
    if (busy(agent.id)) throw Object.assign(new Error(`agent "${agent.name}" is busy with another run`), { code: 'BUSY' });
    const verdict = guard.check(agent);
    const run = runner.enqueue(agent.id, { trigger: 'task', prompt: taskPrompt(t) });
    store.updateTask(t.id, { status: 'running', run_id: run.id, last_run_id: run.id, note: null, finished_at: null });
    publish(t.id);
    return verdict;
  }

  /** keeps a task in step with the runs of its chain; called for every run update */
  function onRun(run) {
    const root = store.rootRun(run.id);
    const t = root && store.taskForRun(root.id);
    if (!t || run.id < (t.last_run_id ?? 0)) return; // an older run of the chain finishing late must not undo a newer one
    const status = RUN_TO_TASK[run.status];
    if (!status || (status === t.status && run.id === t.last_run_id)) return;
    const ended = status === 'done' || status === 'failed' || status === 'stopped';
    store.updateTask(t.id, { status, last_run_id: run.id, finished_at: ended ? now() : null, ...(status === 'failed' ? { note: run.error ? String(run.error).slice(0, 300) : 'run failed' } : {}) });
    publish(t.id);
    if (ended) dispatch();
  }

  /** start every automatic task whose agent is free and not held back by the limit guard (oldest first, one per agent) */
  function dispatch() {
    const started = new Set();
    for (const t of store.listTasks().reverse()) {
      if (t.status !== 'todo' || !t.auto || !t.agent_id || started.has(t.agent_id)) continue;
      const agent = store.getAgent(t.agent_id);
      if (!agent || !agent.enabled || busy(agent.id)) continue;
      const v = guard.check(agent);
      if (!v.ok) {
        if (t.note !== v.reason) { store.updateTask(t.id, { note: v.reason }); publish(t.id); }
        continue;
      }
      try { start(t.id); started.add(agent.id); } catch (e) {
        if (t.note !== e.message) { store.updateTask(t.id, { note: e.message }); publish(t.id); }
      }
    }
  }

  return { start, onRun, dispatch };
}
