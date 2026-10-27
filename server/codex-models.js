import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export const CODEX_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export function normalizeModels(data) {
  if (!Array.isArray(data)) throw new Error('Codex returned an invalid model catalog');
  const models = data.filter(m => m && !m.hidden && typeof m.model === 'string' && m.model).map(m => ({
    id: m.model, displayName: m.displayName || m.model, description: m.description || '', isDefault: m.isDefault === true,
    defaultReasoningEffort: m.defaultReasoningEffort ?? null,
    supportedReasoningEfforts: (m.supportedReasoningEfforts ?? []).filter(e => CODEX_EFFORTS.includes(e.reasoningEffort)).map(e => ({ reasoningEffort: e.reasoningEffort, description: e.description || '' })),
  }));
  if (!models.length) throw new Error('Codex returned no available models. Check your ChatGPT sign-in.');
  return models;
}

/** Resolve both defaults on every run, so resume/fork cannot reuse a previously selected model or effort. */
export function resolveCodexSelection(agent, models) {
  const model = agent.model ? models.find(m => m.id === agent.model) : models.find(m => m.isDefault) ?? models[0];
  if (!model) throw new Error(`Codex model "${agent.model}" is not available. Refresh the model list and choose an available model.`);
  const effort = agent.effort || model.defaultReasoningEffort;
  if (effort && !model.supportedReasoningEfforts.some(e => e.reasoningEffort === effort)) {
    throw new Error(`Intelligence "${effort}" is not supported by ${model.displayName}. Choose ${model.supportedReasoningEfforts.map(e => e.reasoningEffort).join(', ') || 'default'}.`);
  }
  return { model: model.id, effort: effort || null };
}

/** Read-only app-server exchange. No thread is started and no model inference is requested. */
export function readCodexModels({ executable, env, spawnProcess = spawn, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    let child, lines, timer, finished = false, requestId = 1, stderr = '';
    const models = [], cursors = new Set();
    function finish(error, result) {
      if (finished) return;
      finished = true; clearTimeout(timer); lines?.close();
      child?.stdin.end();
      if (child?.pid && child.exitCode === null) child.kill();
      if (error) reject(error); else resolve(result);
    }
    function send(message) { if (!finished) child.stdin.write(JSON.stringify(message) + '\n'); }
    function nextPage(cursor = null) {
      send({ id: ++requestId, method: 'model/list', params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) } });
    }
    try {
      child = spawnProcess(executable, ['app-server', '-c', 'model_provider="openai"'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      timer = setTimeout(() => finish(new Error('Codex model list timed out. Check the connection and try again.')), timeoutMs);
      child.on('error', e => finish(new Error(`Could not read Codex models: ${e.message}`)));
      child.on('close', code => finish(new Error(`Codex model service exited (${code}): ${stderr.trim().slice(-1000)}`)));
      child.stdin.on('error', e => finish(new Error(`Codex model connection closed: ${e.message}`)));
      child.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });
      lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        if (finished) return;
        try {
          const message = JSON.parse(line);
          if (message.method && message.id !== undefined) { send({ id: message.id, error: { code: -32601, message: 'Unsupported request' } }); return; }
          if (message.id !== requestId) return;
          if (message.error) throw new Error(message.error.message || 'Codex rejected the model list request');
          if (requestId === 1) { send({ method: 'initialized' }); nextPage(); return; }
          if (!Array.isArray(message.result?.data)) throw new Error('Codex returned an invalid model catalog');
          models.push(...message.result.data);
          const cursor = message.result.nextCursor;
          if (cursor) {
            if (cursors.has(cursor) || cursors.size >= 20) throw new Error('Codex returned an invalid model list cursor');
            cursors.add(cursor); nextPage(cursor);
          } else finish(null, normalizeModels(models));
        } catch (e) { finish(e); }
      });
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'macii', title: 'macii', version: '0.1.0' }, capabilities: { experimentalApi: false } } });
    } catch (e) { finish(e); }
  });
}
