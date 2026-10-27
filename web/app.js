// Shared client: live state over WebSocket, REST helper, formatting, shell (header) for every page.

export const state = { agents: [], runs: [], subagents: {}, inbox: [], limits: {}, accounts: { default: 'default', list: [{ id: 'default', name: 'Default', builtin: true, dir: null }] }, activity: [], tasks: [], graphs: [], settings: null, notify: null, chat_pins: [], connected: false, loaded: false };
const activityListeners = new Set();
export const onActivity = fn => activityListeners.add(fn);
const listeners = new Set();
const notify = () => listeners.forEach(fn => fn(state));
export function subscribe(fn) { listeners.add(fn); if (state.loaded) fn(state); return () => listeners.delete(fn); }

export async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data;
}

const upsert = (list, item, limit = 100) => {
  const i = list.findIndex(x => x.id === item.id);
  if (i >= 0) list[i] = item; else list.push(item);
  return list.sort((a, b) => b.id - a.id).slice(0, limit);
};

const textListeners = new Set();
export const onText = fn => textListeners.add(fn);

function apply({ type, data }) {
  switch (type) {
    case 'text': textListeners.forEach(fn => fn(data)); return; // no state change: only the chat view cares
    case 'state': Object.assign(state, data, { loaded: true }); break;
    case 'agents': state.agents = data; break;
    case 'run': state.runs = upsert(state.runs, data); break;
    case 'subagents': state.subagents[data.run_id] = data.items; break;
    case 'inbox': state.inbox = upsert(state.inbox, data, 200); break;
    case 'limits': state.limits = data; break;
    case 'accounts': state.accounts = data; break;
    case 'graphs': state.graphs = data; break;
    case 'task': state.tasks = upsert(state.tasks, data, 500); break;
    case 'tasks': state.tasks = data; break;
    case 'chat_pins': state.chat_pins = data; break;
    case 'settings': state.settings = data.settings; state.notify = data.notify; break;
    case 'graph': state.graphs = state.graphs.some(g => g.id === data.id) ? state.graphs.map(g => (g.id === data.id ? data : g)) : [...state.graphs, data]; break;
    case 'activity': state.activity = [data, ...state.activity].slice(0, 6); activityListeners.forEach(fn => fn(data)); break;
    case 'error': console.error('hub error:', data); break;
    default: console.warn('unknown message from hub:', type);
  }
  notify();
}

function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => { state.connected = true; notify(); };
  ws.onmessage = e => apply(JSON.parse(e.data));
  ws.onclose = () => { state.connected = false; notify(); setTimeout(connect, 2000); };
}
connect();

export function toast(message, kind = 'error') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', 'alert');
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}
/** run an API call from a click handler: failures become a visible toast */
export const act = async fn => { try { return await fn(); } catch (e) { toast(e.message); console.error(e); } };

// ---------- folder picker (modal) ----------
/** Opens a modal that browses folders on this machine. Resolves to the chosen path, or null when cancelled. */
export function browseFolder(start = '') {
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.className = 'modal-ov';
    ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="Choose a folder">
      <div class="modal-h"><span class="eyebrow">Choose a folder</span><button class="btn" type="button" data-x>Close</button></div>
      <form class="modal-path"><button class="btn" type="button" data-up title="Parent folder">Up</button><input class="input" aria-label="Folder path" autocomplete="off" spellcheck="false"><button class="btn" type="submit">Go</button></form>
      <div class="modal-quick"></div>
      <div class="modal-list" role="listbox" aria-label="Folders"></div>
      <div class="modal-f"><span class="modal-msg"></span><button class="btn" type="button" data-x>Cancel</button><button class="btn solid" type="button" data-pick>Select this folder</button></div></div>`;
    const $ = sel => ov.querySelector(sel), input = $('input'), list = $('.modal-list'), pick = $('[data-pick]');
    let cur = null, previouslyFocused = document.activeElement;
    const close = value => { ov.remove(); document.removeEventListener('keydown', onKey, true); previouslyFocused?.focus?.(); resolve(value); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
    async function go(path) {
      $('.modal-msg').textContent = ''; list.setAttribute('aria-busy', 'true');
      try {
        const d = await api('GET', `/api/fs?path=${encodeURIComponent(path)}`);
        cur = d; input.value = d.path;
        pick.disabled = !d.path; // the list of drives is not a folder
        $('[data-up]').disabled = d.parent == null;
        const quick = [['Home', d.home], ['Drives', '']].concat(state.graphs.slice(0, 6).map(g => [g.name, g.path]));
        $('.modal-quick').innerHTML = quick.map(([label, p]) => `<button class="chip" type="button" data-go="${esc(p)}">${esc(label)}</button>`).join('');
        list.innerHTML = d.dirs.length ? d.dirs.map(x => `<button class="modal-row" type="button" role="option" data-go="${esc(x.path)}">${esc(x.name)}</button>`).join('') : '<div class="empty">No sub-folders here.</div>';
        if (d.truncated) list.insertAdjacentHTML('beforeend', '<div class="empty">Only the first 500 folders are shown. Type the path above.</div>');
        list.scrollTop = 0;
        return true;
      } catch (e) { $('.modal-msg').textContent = e.message; return false; } // stay where we are: the message says why
      finally { list.removeAttribute('aria-busy'); }
    }
    ov.addEventListener('click', e => {
      if (e.target === ov || e.target.closest('[data-x]')) return close(null);
      const g = e.target.closest('[data-go]');
      if (g) return go(g.dataset.go);
      if (e.target.closest('[data-up]') && cur) return go(cur.parent);
      if (e.target.closest('[data-pick]') && cur?.path) close(cur.path);
    });
    ov.querySelector('form').onsubmit = e => { e.preventDefault(); go(input.value.trim()); };
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(ov);
    (async () => { // the start path may no longer exist: show why, then fall back to the drives
      if (!(await go(start))) { const msg = $('.modal-msg').textContent; await go(''); $('.modal-msg').textContent = msg; }
    })();
    input.focus();
  });
}

// ---------- memory graph selection (a per-viewer convenience, so browser storage is fine) ----------
const GRAPH_KEY = 'aios-graph';
export const chosenGraphId = (s = state) => {
  let saved = null;
  try { saved = localStorage.getItem(GRAPH_KEY); } catch { /* storage unavailable: fall through to the default */ }
  return s.graphs.find(g => g.id === saved)?.id ?? (s.graphs.find(g => g.status === 'ready') ?? s.graphs[0])?.id ?? null;
};
export const chooseGraph = id => { try { localStorage.setItem(GRAPH_KEY, id); } catch { /* ignore */ } };

/** the file an agent's tool call touches, read from the (possibly truncated) JSON of the tool input */
export function pathFromToolInput(input) {
  const m = /"(?:file_path|notebook_path|path)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(input ?? '');
  if (!m) return null;
  try { return JSON.parse(`"${m[1]}"`); } catch { return null; }
}

// ---------- derived ----------
export const openBlocking = (s = state) => s.inbox.filter(i => i.status === 'open' && (i.type === 'question' || i.type === 'approval'));
export const openCount = (s = state) => s.inbox.filter(i => i.status === 'open').length;
export function agentState(agent, s = state) {
  if (s.runs.some(r => r.agent_id === agent.id && (r.status === 'running' || r.status === 'queued'))) return 'running';
  const blocking = openBlocking(s).filter(i => i.agent_id === agent.id);
  if (blocking.some(i => i.type === 'approval')) return 'approval';
  if (blocking.length) return 'waiting';
  return 'idle';
}
export const latestRun = (agentId, s = state) => s.runs.find(r => r.agent_id === agentId) ?? null;

export const projectKey = p => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** a project is a working folder: its agents, what is running, what waits for you, what failed */
export function projectsOf(s = state) {
  const key = projectKey;
  const since = Date.now() - 86400000, byKey = new Map();
  for (const a of s.agents) {
    const k = key(a.cwd);
    if (!byKey.has(k)) byKey.set(k, { key: k, path: a.cwd, name: a.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || a.cwd, agents: [] });
    byKey.get(k).agents.push(a);
  }
  for (const g of s.graphs) { // folders added by hand, with or without agents
    const k = key(g.path);
    if (!byKey.has(k)) byKey.set(k, { key: k, path: g.path, name: g.name, agents: [] });
    byKey.get(k).graphId = g.id;
  }
  return [...byKey.values()].map(p => {
    const ids = new Set(p.agents.map(a => a.id));
    const runs = s.runs.filter(r => ids.has(r.agent_id)), recent = runs.filter(r => r.created_at >= since);
    const open = s.inbox.filter(i => i.status === 'open' && ids.has(i.agent_id));
    return {
      ...p,
      running: runs.filter(r => r.status === 'running').length,
      queued: runs.filter(r => r.status === 'queued').length,
      tasksOpen: s.tasks.filter(t => projectKey(t.project_path) === p.key && (t.status === 'todo' || t.status === 'running' || t.status === 'waiting')).length,
      asking: open.filter(i => i.type === 'question' || i.type === 'approval').length,
      warnings: open.filter(i => i.type === 'warning').length,
      failed: recent.filter(r => r.status === 'failed').length,
      tokens: recent.reduce((n, r) => n + (r.tokens ?? 0), 0),
      last: runs.reduce((t, r) => Math.max(t, r.ended_at ?? r.created_at), 0) || null,
    };
  }).sort((a, b) => (b.asking - a.asking) || (b.running - a.running) || (b.last ?? 0) - (a.last ?? 0));
}

// ---------- formatting ----------
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Everything an agent wrote is untrusted: escape before putting it into HTML. */
export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ESC[c]);
export const ago = ts => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};
export const dur = ms => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};
export const tok = n => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0));
export const clock = ts => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
export const runDuration = r => (r.started_at ? (r.ended_at ?? Date.now()) - r.started_at : 0);

// ---------- subagent tree ----------
export function treeHtml(run, subs) {
  const children = parent => subs.filter(s => (s.parent_tool_use_id ?? null) === parent);
  const dot = s => (s === 'running' ? 'running' : s === 'failed' ? 'waiting' : '');
  const node = s => {
    const d = s.ended_at ? s.ended_at - s.started_at : Date.now() - s.started_at;
    const kids = children(s.tool_use_id);
    return `<li><div class="n"><span class="dot ${dot(s.status)}"></span><span class="t">${esc(s.type ?? 'subagent')}</span>
      <span class="d" title="${esc(s.description)}">${esc(s.description)}</span>
      <span class="st ${s.status === 'running' ? 'live' : ''}">${s.status === 'stopped' ? 'stopped' : dur(d)} · ${tok(s.tokens)}</span></div>
      ${kids.length ? `<ul>${kids.map(node).join('')}</ul>` : ''}</li>`;
  };
  const roots = children(null);
  const running = run.status === 'running';
  return `<div class="tree"><ul><li>
    <div class="n"><span class="dot ${running ? 'running' : ''}"></span><span class="t">${esc(run.agent_id).toUpperCase()}</span><span class="d">run #${run.id}</span>
      <span class="st ${running ? 'live' : ''}">${dur(runDuration(run))} · ${tok(run.tokens)}</span></div>
    ${roots.length ? `<ul>${roots.map(node).join('')}</ul>` : ''}</li></ul></div>`;
}

// ---------- shell ----------
const TABS = [['index', 'Command', '/'], ['inbox', 'Inbox', '/inbox.html'], ['projects', 'Projects', '/projects.html'], ['tasks', 'Tasks', '/tasks.html'], ['chat', 'Chat', '/chat.html'],['agents', 'Agents', '/agents.html'], ['memory', 'Memory', '/memory.html'], ['settings', 'Settings', '/settings.html']];
const pct = u => (u == null ? null : Math.round(u * 100));
/** key of an account's usage windows in state.limits (same rule as server/accounts.js) */
export const limitKey = account => (!account || account === 'default' ? 'claude' : `claude:${account}`);
/** `t` = the limit guard's threshold (0..1); drawn as a tick so you can see how close a run is to being held back */
const meter = (label, u, t) => {
  const p = pct(u);
  const cls = p == null ? 'na' : p >= 90 ? 'crit' : p >= 70 ? 'warn' : '';
  const style = p == null ? '' : `style="--v:${p}%${t ? `;--t:${Math.round(t * 100)}%` : ''}"`;
  return `<div class="limit"><div class="lbl"><span>${label}</span><b>${p == null ? 'n/a' : p + '%'}</b></div><div class="meter ${cls} ${t ? 'has-t' : ''}" ${style}><i></i></div></div>`;
};

export function mountShell(active) {
  if (!document.querySelector('link[rel=icon]')) document.head.insertAdjacentHTML('beforeend', '<link rel="icon" type="image/png" href="/logo.png">');
  const top = document.getElementById('top');
  top.className = 'top';
  top.innerHTML = `<a class="brand" href="/" aria-label="macii home"><img class="logo-d" src="/logo-h.png" alt="macii"><img class="logo-l" src="/logo-h-light.png" alt="macii"></a>
    <nav class="tabs">${TABS.map(([id, label, href]) => `<a href="${href}" ${id === active ? 'class="on"' : ''}>${label}${id === 'inbox' ? ' <b class="badge red" id="badge" hidden></b>' : ''}</a>`).join('')}</nav>
    <div class="limits" id="limits"></div>
    <div class="clock"><span id="clock"></span><span id="conn"></span></div>`;
  const tick = () => {
    const d = new Date();
    top.querySelector('#clock').textContent = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    top.querySelector('#conn').textContent = state.connected
      ? d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }).toUpperCase()
      : 'HUB OFFLINE';
    top.querySelector('#conn').style.color = state.connected ? '' : 'var(--red)';
  };
  tick(); setInterval(tick, 15000);
  subscribe(s => {
    const n = openCount(s), badge = top.querySelector('#badge');
    badge.hidden = !n; badge.textContent = n;
    const gd = s.settings?.guard?.enabled ? s.settings.guard : null;
    // one pair of meters per Claude account; with only the CLI login it stays "CLAUDE"
    const many = s.accounts.list.length > 1;
    const claude = s.accounts.list.map(a => {
      const w = s.limits[limitKey(a.id)]?.windows;
      return many
        ? `<div class="acc-limit" title="${esc(a.name)}"><span class="acc-name">${esc(a.name.toUpperCase())}</span><div>${meter('5H', w?.five_hour?.utilization, gd?.five_hour)}${meter('7D', w?.seven_day?.utilization, gd?.seven_day)}</div></div>`
        : meter('CLAUDE · 5H', w?.five_hour?.utilization, gd?.five_hour) + meter('CLAUDE · 7D', w?.seven_day?.utilization, gd?.seven_day);
    }).join('');
    const limits = top.querySelector('#limits');
    limits.classList.toggle('many', many);
    limits.innerHTML = claude + meter('CODEX', null);
    tick();
  });
}
