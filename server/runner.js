import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { buildClaudeArgs, ClaudeStream } from './adapters/claude.js';
import { buildCodexArgs, CodexStream, findCodex } from './adapters/codex.js';

// Subscription limits are the scarce resource, so only a few agents run at once.
const MAX_CONCURRENT = 2;

// `codex exec` sometimes stalls after `turn.started` and never answers; a run that stays silent this long is failed instead of holding a slot and its folder forever
const CODEX_SILENCE_MS = Number(process.env.AIOS_CODEX_SILENCE_S ?? 300) * 1000;

export const folderKey = cwd => resolve(cwd).toLowerCase();

/** index of the first queued run whose folder no live run is using, or -1. Two agents writing into one folder would trip over each other. */
export function nextRunnable(queue, liveIds, folderOf) {
  const busy = new Set(liveIds.map(folderOf));
  return queue.findIndex(id => !busy.has(folderOf(id)));
}

export function createRunner({ store, bus, graphs, hubUrl, hubToken, mcpScript, runDir }) {
  mkdirSync(runDir, { recursive: true });
  const live = new Map(); // runId -> { child, stopRequested, result, stderr, finished }
  const queue = [];
  const extraTools = new Map(); // runId -> permissions granted by an approval (memory only, like the queue)
  const promptPrefix = new Map(); // runId -> text sent in front of the prompt but not stored with it (memory only)

  const publishRun = id => bus.push('run', store.getRun(id));
  const publishSubagents = runId => bus.push('subagents', { run_id: runId, items: store.listSubagents(runId) });

  function enqueue(agentId, { trigger, prompt = null, resumeRun = null, extraTools: granted = [], prefix = null }) {
    const agent = store.getAgent(agentId);
    if (!agent) throw new Error(`unknown agent "${agentId}"`);
    if (!['claude', 'codex'].includes(agent.type)) throw new Error(`adapter "${agent.type}" is not implemented yet`);
    if (resumeRun && !resumeRun.session_id) throw new Error(`run ${resumeRun.id} has no session id, cannot resume`);
    if (!(prompt ?? agent.prompt)) throw new Error(`${agent.name} has no routine prompt; give it work in Chat or Tasks`);
    const run = store.createRun({
      agent_id: agentId, parent_run_id: resumeRun?.id, trigger, status: 'queued',
      session_id: resumeRun?.session_id, prompt: prompt ?? agent.prompt,
    });
    if (granted.length) extraTools.set(run.id, granted);
    if (prefix) promptPrefix.set(run.id, prefix);
    queue.push(run.id);
    publishRun(run.id);
    pump();
    return store.getRun(run.id);
  }

  const folderOf = runId => folderKey(store.getAgent(store.getRun(runId).agent_id).cwd);
  const noted = new Set(); // runs already told why they wait
  function pump() {
    while (live.size < MAX_CONCURRENT) {
      const i = nextRunnable(queue, [...live.keys()], folderOf);
      if (i < 0) break;
      launch(queue.splice(i, 1)[0]);
    }
    if (live.size < MAX_CONCURRENT) {
      for (const id of queue) if (!noted.has(id)) { noted.add(id); store.addEvent(id, 'warning', { message: 'waiting: another agent is working in the same folder' }); }
    }
  }

  function launch(runId) {
    const run = store.getRun(runId);
    const agent = store.getAgent(run.agent_id);
    const mcpFile = join(runDir, `run-${runId}.mcp.json`);
    const codex = agent.type === 'codex';
    const bin = codex ? 'codex' : 'claude';
    // An API key in the environment would silently switch the run from the subscription to API billing.
    const env = { ...process.env };
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY']) delete env[k];
    let args, exe = bin, stream;
    if (codex) {
      try { exe = findCodex(env); args = buildCodexArgs({ agent, resumeSessionId: run.session_id }); } catch (e) {
        return finish({ runId, state: { finished: false }, raw: createWriteStream(join(runDir, `run-${runId}.jsonl`)), mcpFile }, { status: 'failed', error: e.message });
      }
      stream = new CodexStream();
    } else {
      const memory = agent.memory ? graphs.mcpFor(agent.cwd) : null;
      if (agent.memory && !memory) store.addEvent(runId, 'warning', { message: 'memory graph is enabled for this agent, but none has been built for its folder (Memory page > Build)' });
      writeFileSync(mcpFile, JSON.stringify({
        mcpServers: {
          aios: { command: process.execPath, args: [mcpScript], env: { AIOS_HUB_URL: hubUrl, AIOS_HUB_TOKEN: hubToken, AIOS_RUN_ID: String(runId) } },
          ...(memory ? { graphify: memory.server } : {}),
        },
      }));
      const allowedTools = [...agent.allowed_tools, ...(memory?.tools ?? []), ...(extraTools.get(runId) ?? [])];
      const chat = store.rootRun(runId).trigger === 'chat';
      args = buildClaudeArgs({ agent, allowedTools, memory: !!memory, chat, resumeSessionId: run.session_id, fork: run.trigger === 'chat', mcpConfigFile: mcpFile });
      stream = new ClaudeStream();
    }

    const state = { child: null, stopRequested: false, result: null, stderr: '', finished: false, waiters: [] };
    const raw = createWriteStream(join(runDir, `run-${runId}.jsonl`));
    const ctx = { runId, state, raw, mcpFile };
    live.set(runId, state);
    store.updateRun(runId, { status: 'running', started_at: Date.now() });
    publishRun(runId);

    let child;
    try {
      child = spawn(exe, args, { cwd: agent.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      return finish(ctx, { status: 'failed', error: `could not start ${bin}: ${e.message}` });
    }
    state.child = child;
    state.lastOutput = Date.now();
    if (codex) {
      state.watch = setInterval(() => {
        if (Date.now() - state.lastOutput <= CODEX_SILENCE_MS) return;
        state.silent = true; clearInterval(state.watch); killTree(child);
      }, 5000);
      state.watch.unref();
    }
    child.on('error', e => finish(ctx, { status: 'failed', error: `could not start ${bin}: ${e.message}` }));
    child.stderr.on('data', d => { state.stderr = (state.stderr + d).slice(-4000); });
    child.stdin.on('error', () => { /* claude exited before reading the prompt: the close handler reports why */ });
    child.stdin.end((promptPrefix.get(runId) ?? '') + run.prompt);

    createInterface({ input: child.stdout }).on('line', line => {
      state.lastOutput = Date.now();
      raw.write(line + '\n');
      let obj;
      try { obj = JSON.parse(line); } catch {
        store.addEvent(runId, 'parse_error', { line: line.slice(0, 500) });
        return;
      }
      try { handle(ctx, stream, stream.push(obj)); } catch (e) {
        console.error(`run ${runId}: failed to process event:`, e);
        store.addEvent(runId, 'internal_error', { message: e.message });
      }
    });

    child.on('close', (code, signal) => {
      clearInterval(state.watch);
      let outcome;
      if (state.stopRequested) outcome = { status: 'stopped' };
      else if (state.silent) outcome = { status: 'failed', error: `${bin} gave no output for ${Math.round(CODEX_SILENCE_MS / 1000)} s and was stopped (it sometimes stalls before its first answer). Run it again.` };
      else if (state.result && !state.result.is_error && code === 0) outcome = { status: 'done' };
      else {
        outcome = {
          status: 'failed',
          error: state.result?.is_error ? state.result.text
            : state.stderr.trim().slice(-1500) || `${bin} exited with code ${code}${signal ? ` (${signal})` : ''}`,
        };
      }
      finish(ctx, outcome);
    });
  }

  function handle({ runId, state }, stream, events) {
    for (const ev of events) {
      switch (ev.kind) {
        case 'init':
          store.updateRun(runId, { session_id: ev.session_id });
          store.addEvent(runId, 'init', { model: ev.model, session_id: ev.session_id, mcp_servers: ev.mcp_servers });
          publishRun(runId);
          break;
        case 'text':
          store.addEvent(runId, 'text', { owner: ev.owner, text: ev.text.slice(0, 4000) });
          bus.push('text', { run_id: runId, agent_id: store.getRun(runId).agent_id }); // chat view refetches the thread
          break;
        case 'tool': {
          const input = JSON.stringify(ev.input).slice(0, 300);
          store.addEvent(runId, 'tool', { owner: ev.owner, name: ev.name, input });
          bus.push('activity', { run_id: runId, agent_id: store.getRun(runId).agent_id, name: ev.name, input, ts: Date.now() });
          break;
        }
        case 'tool_error':
          store.addEvent(runId, 'tool_error', { text: ev.text });
          break;
        case 'subagent_start':
          store.upsertSubagent({ run_id: runId, ...ev });
          store.addEvent(runId, 'subagent_start', { tool_use_id: ev.tool_use_id, type: ev.type, description: ev.description });
          publishSubagents(runId);
          break;
        case 'subagent_end':
          store.updateSubagent(runId, ev.tool_use_id, { status: ev.is_error ? 'failed' : 'done', ended_at: Date.now(), result_text: ev.text.slice(0, 4000) });
          store.addEvent(runId, 'subagent_end', { tool_use_id: ev.tool_use_id, is_error: ev.is_error });
          publishSubagents(runId);
          break;
        case 'usage': {
          const totals = stream.tokenTotals();
          let all = 0;
          for (const [owner, tokens] of totals) {
            all += tokens;
            if (owner !== 'main' && store.getSubagent(runId, owner)) store.updateSubagent(runId, owner, { tokens });
          }
          store.updateRun(runId, { tokens: all });
          publishRun(runId);
          publishSubagents(runId);
          break;
        }
        case 'rate': {
          const info = ev.info ?? {};
          if (!info.unifiedWindows) store.addEvent(runId, 'warning', { message: 'rate_limit_event without unifiedWindows: limit display will be incomplete', info });
          store.setLimits('claude', { status: info.status, type: info.rateLimitType, resetsAt: info.resetsAt, windows: info.unifiedWindows ?? null });
          bus.push('limits', store.getLimits());
          break;
        }
        case 'result':
          state.result = ev;
          store.updateRun(runId, { turns: ev.turns, result_text: ev.text });
          store.addEvent(runId, 'result', { is_error: ev.is_error, subtype: ev.subtype, duration_ms: ev.duration_ms });
          break;
        default:
          store.addEvent(runId, 'unknown', ev);
      }
    }
  }

  function finish({ runId, state, raw, mcpFile }, outcome) {
    if (state.finished) return;
    state.finished = true;
    raw.end();
    rmSync(mcpFile, { force: true });
    extraTools.delete(runId);
    promptPrefix.delete(runId);
    noted.delete(runId);
    store.stopRunningSubagents(runId);
    publishSubagents(runId);
    let { status, error = null } = outcome;
    // an open question/approval means the run ended on purpose and is waiting for the user
    if (status === 'done' && store.openBlockingForRun(runId).length) status = 'waiting';
    store.updateRun(runId, { status, ended_at: Date.now(), error });
    live.delete(runId);
    publishRun(runId);
    state.waiters?.forEach(resolve => resolve());
    pump();
  }

  function stop(runId) {
    const state = live.get(runId);
    if (!state) {
      const i = queue.indexOf(runId);
      if (i < 0) return false;
      queue.splice(i, 1);
      noted.delete(runId);
      store.updateRun(runId, { status: 'stopped', ended_at: Date.now() });
      publishRun(runId);
      return true;
    }
    state.stopRequested = true;
    killTree(state.child);
    return true;
  }

  /** stop a run and resolve once it is really over (process gone, slot and folder free); rejects if it does not end */
  function stopAndWait(runId, timeoutMs = 10000) {
    const state = live.get(runId);
    if (!state) return stop(runId) ? Promise.resolve() : Promise.reject(new Error(`run ${runId} is not active`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`run ${runId} did not stop within ${timeoutMs / 1000} s`)), timeoutMs);
      state.waiters.push(() => { clearTimeout(timer); resolve(); });
      stop(runId);
    });
  }

  // child.kill() would leave the agent's own child processes (MCP servers, tools) running on Windows
  function killTree(child) {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGTERM');
  }

  function recoverOnStart() {
    for (const run of store.listActiveRuns()) {
      store.updateRun(run.id, { status: 'failed', ended_at: Date.now(), error: 'hub restarted while the run was active' });
    }
  }

  const stopAll = () => { for (const id of [...live.keys(), ...queue]) stop(id); };

  return { enqueue, stop, stopAndWait, stopAll, recoverOnStart, isLive: id => live.has(id) };
}
