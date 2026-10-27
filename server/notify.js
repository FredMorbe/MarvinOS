// Windows toasts for new inbox items and failed runs. Windows PowerShell 5.1 is required for the toast API
// (PowerShell 7 cannot load the Windows Runtime types), hence powershell.exe and not pwsh.
import { spawn } from 'node:child_process';

const LABEL = { question: 'Question', approval: 'Approval needed', warning: 'Warning', result: 'Result' };
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const MAX_QUEUE = 5;

export const describeInbox = (item, agentName, hubUrl) => ({
  title: `${LABEL[item.type]} · ${agentName}`,
  body: clip(item.title, 160),
  url: `${hubUrl}/inbox.html#${item.id}`,
  silent: item.type === 'result', // results are routine: show them, do not make noise
});
export const describeFailure = (run, agentName, hubUrl) => ({
  title: `Run failed · ${agentName}`,
  body: clip((run.error ?? 'unknown error').split('\n').find(Boolean) ?? 'unknown error', 160),
  url: `${hubUrl}/agents.html`,
  silent: false,
});

function powershellToast(scriptPath, payload) {
  return new Promise((resolve, reject) => {
    const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, b64], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', d => { err = (err + d).slice(-1500); });
    child.stdout.on('data', d => { err = (err + d).slice(-1500); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('toast timed out')); }, 15000);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(err.trim() || `powershell exited with code ${code}`)); });
  });
}

export function createNotifier({ store, bus, hubUrl, getSettings, scriptPath, platform = process.platform, show = payload => powershellToast(scriptPath, payload) }) {
  const supported = platform === 'win32';
  const inboxSeen = new Set(store.listInbox({ limit: 5000 }).map(i => i.id)); // existing items do not toast on startup
  const failedSeen = new Set();
  let queue = [], draining = false, lastError = null;

  async function drain() {
    if (draining) return;
    draining = true;
    while (queue.length) {
      const payload = queue.length > MAX_QUEUE
        ? (() => { const n = queue.length; queue = []; return { title: 'macii', body: `${n} new notifications`, url: `${hubUrl}/inbox.html`, silent: false }; })()
        : queue.shift();
      try { await show(payload); lastError = null; } catch (e) {
        lastError = e.message;
        console.error('toast failed:', e.message);
        bus.push('error', { source: 'notify', message: e.message });
      }
    }
    draining = false;
  }
  const enqueue = payload => { queue.push(payload); drain(); };

  bus.onPush(({ type, data }) => {
    if (!supported) return;
    const s = getSettings().notify;
    if (type === 'inbox' && data.status === 'open' && !inboxSeen.has(data.id)) {
      inboxSeen.add(data.id);
      if (s.enabled && s.types.includes(data.type)) enqueue(describeInbox(data, store.getAgent(data.agent_id)?.name ?? data.agent_id, hubUrl));
    } else if (type === 'run' && data.status === 'failed' && !failedSeen.has(data.id)) {
      failedSeen.add(data.id);
      if (s.enabled && s.failed_runs) enqueue(describeFailure(data, store.getAgent(data.agent_id)?.name ?? data.agent_id, hubUrl));
    }
  });

  return {
    status: () => ({ supported, last_error: lastError }),
    /** sends a test toast and reports failure to the caller instead of swallowing it */
    async test() {
      if (!supported) throw new Error('Windows toasts are only available on Windows');
      await show({ title: 'macii', body: 'Notifications work.', url: `${hubUrl}/`, silent: false });
    },
  };
}
