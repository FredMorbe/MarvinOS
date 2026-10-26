/* AIOS HUD — memory graph (Graphify view from /api/graphs/:id) + agent orbit visualisation.
   opts.demo: generate seeded sample data instead (design mockups only). */
(function () {
  const TAU = Math.PI * 2;
  const rng = seed => { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
  const gauss = r => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(TAU * r());

  // colours and fonts come from the active theme (hud.css / themes.css variables)
  let th = {};
  const readTheme = () => {
    const s = getComputedStyle(document.documentElement), v = n => s.getPropertyValue(n).trim();
    th = { a: v('--a-rgb'), r: v('--r-rgb'), g: v('--g-rgb'), idle: v('--idle-rgb'), h: parseFloat(v('--node-h')), sp: parseFloat(v('--node-spread')), sat: v('--node-sat'), head: v('--f-head'), mono: v('--f-mono') };
  };
  const col = {
    cyan: a => `rgba(${th.a},${a})`,
    red: a => `rgba(${th.r},${a})`,
    gold: a => `rgba(${th.g},${a})`,
    node: (h, a) => `hsla(${th.h + (h - 190) * th.sp},${th.sat},62%,${a})`,
  };
  const STATE_COL = { running: a => col.cyan(a), waiting: a => col.red(a), approval: a => col.gold(a), idle: a => `rgba(${th.idle},${a})` };

  const DEMO_CLUSTERS = [
    { name: 'auth',       hue: 188, names: ['AuthService','verifyToken','signJwt','SessionStore','refreshToken','hashPassword','AuthGuard','login.route','users.schema','OAuthClient'] },
    { name: 'scheduler',  hue: 198, names: ['RunScheduler','CronParser','nextRun','JobQueue','Routine','retryPolicy','tick','RunLock','schedule.yaml','Backoff'] },
    { name: 'adapters',   hue: 176, names: ['ClaudeAdapter','CodexAdapter','spawnCli','StreamParser','parseEvent','OllamaClient','resumeSession','AdapterBase','jsonl.js','usageFromEvent'] },
    { name: 'inbox',      hue: 208, names: ['InboxService','sendMessage','Question','Approval','markRead','answerQuestion','inbox.schema','Notifier','toast','ResultCard'] },
    { name: 'subagents',  hue: 182, names: ['SubagentTree','parentToolUseId','TaskEvent','RunTracker','Node','aggregateUsage','tree.js','spawnDepth','Lifecycle','TreeView'] },
    { name: 'ui-hud',     hue: 214, names: ['HudShell','GraphCanvas','Panel','useLive','Ticker','Meter','theme.css','OrbitRing','Tooltip','NavTabs'] },
    { name: 'storage',    hue: 170, names: ['Db','migrate','runs.schema','RunRepo','AgentRepo','InboxRepo','query','Tx','seed.sql','Backup'] },
    { name: 'docs',       hue: 222, names: ['README','ARCHITECTURE.md','ADR-001','AdapterGuide','Permissions.md','Glossary','Roadmap.md','Runbook','Changelog','Security.md'] },
  ];
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DEFAULT_AGENTS = [
    { id: 'atlas',     name: 'ATLAS',     type: 'claude', state: 'running'  },
    { id: 'scribe',    name: 'SCRIBE',    type: 'claude', state: 'idle'     },
    { id: 'forge',     name: 'FORGE',     type: 'codex',  state: 'waiting'  },
    { id: 'concierge', name: 'CONCIERGE', type: 'claude', state: 'idle'     },
    { id: 'echo',      name: 'ECHO',      type: 'ollama', state: 'running'  },
    { id: 'vault',     name: 'VAULT',     type: 'codex',  state: 'approval' },
  ];

  window.initGraph = function (canvas, opts = {}) {
    const ctx = canvas.getContext('2d');
    readTheme();
    window.addEventListener('themechange', readTheme);
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const agents = (opts.agents || (opts.demo ? DEFAULT_AGENTS : [])).map((a, i) => ({ ...a, ring: i < 3 ? 0 : 1, ph: (i % 3) / 3 * TAU + (i < 3 ? 0 : 0.6) }));
    const r = rng(opts.seed || 7);
    const nodes = [], edges = [], CLUSTERS = [];
    let gods = [];
    let W = 0, H = 0, dpr = 1, hover = null, selected = null, searchQ = '', showInferred = true, lastBeam = 0;
    const beams = [];
    let mode = 'memory'; // 'memory' = code graph of one project, 'work' = projects with their agents, tasks and touched files
    const work = { projects: [], files: new Map(), phase: new Map() }; // files: project key -> [{ path, kind, ts, agent }]

    // ---- demo graph (mockups only) ----
    function buildDemo() {
    DEMO_CLUSTERS.forEach(c => CLUSTERS.push({ ...c }));
    CLUSTERS.forEach((c, ci) => {
      const ang = ci / CLUSTERS.length * TAU + 0.35;
      c.cx = Math.cos(ang) * 0.66; c.cy = Math.sin(ang) * 0.62; c.visible = true; c.idx = ci;
      const n = 34 + Math.floor(r() * 14);
      for (let i = 0; i < n; i++) {
        let ux = c.cx + gauss(r) * 0.085, uy = c.cy + gauss(r) * 0.085;
        const d = Math.hypot(ux, uy);
        if (d < 0.44) { ux *= 0.44 / d; uy *= 0.44 / d; }
        ux = Math.max(-0.97, Math.min(0.97, ux)); uy = Math.max(-0.95, Math.min(0.95, uy));
        const base = c.names[i % c.names.length];
        const name = i < c.names.length ? base : base + '#' + Math.floor(i / c.names.length);
        const kind = /\.(schema|yaml|sql|css|js|md|route)$/.test(base) ? 'file' : /^[A-Z]/.test(base) ? 'class' : 'function';
        nodes.push({ id: nodes.length, ci, ux, uy, god: i === 0, hub: i < 3, name, kind, sp: 0.5 + r(), ph: r() * TAU, deg: 0, flash: -1e9 });
      }
    });
    const seen = new Set();
    const link = (a, b, kind) => {
      if (a === b) return;
      const k = a < b ? a + '_' + b : b + '_' + a;
      if (seen.has(k)) return; seen.add(k);
      edges.push({ a, b, kind }); nodes[a].deg++; nodes[b].deg++;
    };
    CLUSTERS.forEach(c => {
      const mine = nodes.filter(n => n.ci === c.idx);
      mine.forEach(n => {
        mine.map(m => ({ m, d: Math.hypot(m.ux - n.ux, m.uy - n.uy) })).filter(o => o.m !== n)
          .sort((x, y) => x.d - y.d).slice(0, 2).forEach(o => link(n.id, o.m.id, 'EXTRACTED'));
      });
      mine.filter(n => !n.hub).forEach(n => { if (r() < 0.35) link(n.id, mine[Math.floor(r() * 3)].id, 'EXTRACTED'); });
    });
    gods = nodes.filter(n => n.god);
    gods.forEach((g, i) => link(g.id, gods[(i + 1) % gods.length].id, 'INFERRED'));
    for (let i = 0; i < 28; i++) {
      const a = nodes[Math.floor(r() * nodes.length)], b = nodes[Math.floor(r() * nodes.length)];
      if (a.ci !== b.ci) link(a.id, b.id, i % 4 === 0 ? 'EXTRACTED' : 'INFERRED');
    }
    }
    if (opts.demo) buildDemo();

    // ---- real graph ----
    const byFile = new Map(); // lower-case relative path -> nodes
    function loadGraph(view) {
      CLUSTERS.length = 0; nodes.length = 0; edges.length = 0; byFile.clear(); beams.length = 0; selected = null; hover = null;
      const maxSize = Math.max(1, ...view.communities.map(c => c.size));
      view.communities.forEach((c, i) => {
        const ang = i / view.communities.length * TAU + 0.35;
        CLUSTERS.push({ name: c.label, hue: 170 + (i * 37) % 55, visible: true, idx: i, size: c.size, cx: Math.cos(ang) * 0.66, cy: Math.sin(ang) * 0.62 });
      });
      const hr = rng(1337);
      view.nodes.forEach((n, i) => {
        const c = CLUSTERS[n.community], sigma = 0.05 + 0.07 * Math.sqrt(c.size / maxSize);
        let ux = c.cx + gauss(hr) * sigma, uy = c.cy + gauss(hr) * sigma;
        const d = Math.hypot(ux, uy) || 1e-6;
        if (d < 0.44) { ux *= 0.44 / d; uy *= 0.44 / d; }
        nodes.push({ id: i, key: n.id, ci: n.community, ux, uy, god: false, hub: false, name: n.label, kind: n.kind, file: n.file, line: n.line, sp: 0.5 + hr(), ph: hr() * TAU, deg: n.deg, flash: -1e9 });
        if (n.file) { const k = n.file.replace(/\\/g, '/').toLowerCase(); (byFile.get(k) ?? byFile.set(k, []).get(k)).push(nodes[i]); }
      });
      view.edges.forEach(e => edges.push({ a: e.a, b: e.b, kind: e.kind, rel: e.rel }));
      const byComm = new Map();
      nodes.forEach(n => (byComm.get(n.ci) ?? byComm.set(n.ci, []).get(n.ci)).push(n));
      byComm.forEach((members, ci) => { members.sort((x, y) => y.deg - x.deg); members.slice(0, 3).forEach(m => { m.hub = true; }); if (ci < 12) members[0].god = true; });
      gods = nodes.filter(n => n.god);
      relax();
    }
    // light force layout in unit coordinates: edges pull, near neighbours push, communities keep their place
    function relax() {
      const N = nodes.length;
      if (N < 2) return;
      const iterations = N > 1000 ? 25 : 70, R2 = 0.07 * 0.07, clampF = v => Math.max(-0.01, Math.min(0.01, v));
      for (let it = 0; it < iterations; it++) {
        const fx = new Float32Array(N), fy = new Float32Array(N);
        for (const e of edges) {
          const a = nodes[e.a], b = nodes[e.b], dx = b.ux - a.ux, dy = b.uy - a.uy, d = Math.hypot(dx, dy) || 1e-6, f = (d - 0.035) * 0.04;
          fx[e.a] += dx / d * f; fy[e.a] += dy / d * f; fx[e.b] -= dx / d * f; fy[e.b] -= dy / d * f;
        }
        for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
          const dx = nodes[j].ux - nodes[i].ux, dy = nodes[j].uy - nodes[i].uy, d2 = dx * dx + dy * dy;
          if (d2 > R2) continue;
          const d = Math.sqrt(d2) || 1e-6, f = 0.0006 / (d2 + 1e-4);
          fx[i] -= dx / d * f; fy[i] -= dy / d * f; fx[j] += dx / d * f; fy[j] += dy / d * f;
        }
        for (let i = 0; i < N; i++) {
          const n = nodes[i], c = CLUSTERS[n.ci];
          n.ux += clampF(fx[i] + (c.cx - n.ux) * 0.02); n.uy += clampF(fy[i] + (c.cy - n.uy) * 0.02);
          const d = Math.hypot(n.ux, n.uy) || 1e-6;
          if (d < 0.44) { n.ux *= 0.44 / d; n.uy *= 0.44 / d; }
          n.ux = Math.max(-0.97, Math.min(0.97, n.ux)); n.uy = Math.max(-0.95, Math.min(0.95, n.uy));
        }
      }
    }
    /** the best-connected node of the file an agent is touching (absolute or relative path) */
    function nodeForFile(path) {
      const p = String(path).replace(/\\/g, '/').toLowerCase();
      for (const [file, list] of byFile) if (p === file || p.endsWith('/' + file)) return list.reduce((m, n) => (n.deg > m.deg ? n : m));
      return null;
    }

    // ---- sizing ----
    const resize = () => {
      const b = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2); W = b.width; H = b.height;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    new ResizeObserver(resize).observe(canvas); resize();

    const base = () => Math.min(W, H) / 2;
    const npos = (n, t) => [W / 2 + (n.ux + Math.sin(t * 0.0004 * n.sp + n.ph) * 0.006) * W / 2 * 0.9, H / 2 + (n.uy + Math.cos(t * 0.00035 * n.sp + n.ph) * 0.006) * H / 2 * 0.88];
    const vis = n => CLUSTERS[n.ci].visible;
    const matches = n => searchQ && n.name.toLowerCase().includes(searchQ);

    function neighbors(n) {
      return edges.filter(e => e.a === n.id || e.b === n.id).map(e => ({ node: nodes[e.a === n.id ? e.b : e.a], kind: e.kind, rel: e.rel }));
    }

    function spawnBeam(t, only, target) {
      const run = only ? [only] : agents.filter(a => a.state === 'running');
      const pool = nodes.filter(vis);
      if (!run.length || !pool.length) return;
      const a = run[Math.floor(Math.random() * run.length)];
      const n = target || Math.random() < 0.45 ? gods.filter(vis)[Math.floor(Math.random() * gods.filter(vis).length)] || pool[0] : pool[Math.floor(Math.random() * pool.length)];
      if (!vis(n)) return;
      beams.push({ a, n, t0: t, dur: 1200 });
      if (opts.onAccess) opts.onAccess(a, n);
    }

    function drawCore(t, cx, cy, B) {
      const gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, B * 0.16);
      gr.addColorStop(0, col.cyan(0.35)); gr.addColorStop(1, col.cyan(0));
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(cx, cy, B * 0.16, 0, TAU); ctx.fill();
      ctx.strokeStyle = col.cyan(0.9); ctx.lineWidth = 1.5;
      ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = i / 6 * TAU + t * 0.0003; const X = cx + Math.cos(a) * B * 0.075, Y = cy + Math.sin(a) * B * 0.075; i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); } ctx.closePath(); ctx.stroke();
      ctx.lineWidth = 1; ctx.fillStyle = col.cyan(1); ctx.textAlign = 'center';
      ctx.font = '700 15px ' + th.head; ctx.fillText('AIOS', cx, cy + 3);
      ctx.font = '400 8px ' + th.mono; ctx.fillStyle = col.cyan(0.6); ctx.fillText('CORE ONLINE', cx, cy + 15);
      ctx.textAlign = 'left';
    }

    // ---- work mode ----
    const FILE_TTL = 10 * 60 * 1000, FRESH = 1200, MAX_FILES = 14, MAX_LINES = 5;
    const hash = str => { let h = 2166136261; for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619); return (h >>> 0) / 4294967296; };
    const fit = (text, max) => { let s = String(text); if (ctx.measureText(s).width <= max) return s; while (s.length > 1 && ctx.measureText(s + '…').width > max) s = s.slice(0, -1); return s + '…'; };
    const fileName = path => String(path).split(/[\\/]/).pop();

    function drawWork(t) {
      const cx = W / 2, cy = H / 2, n = work.projects.length, now = Date.now();
      work.projects.forEach((p, i) => {
        const ang = n === 1 ? -Math.PI / 2 : i / n * TAU - Math.PI / 2;
        p.x = cx + Math.cos(ang) * W / 2 * 0.62; p.y = cy + Math.sin(ang) * H / 2 * 0.56;
        const ul = Math.hypot(p.x - cx, p.y - cy) || 1, ux = (p.x - cx) / ul, uy = (p.y - cy) / ul, out = Math.atan2(uy, ux);
        const busy = p.agents.some(a => a.state === 'running'), ask = p.agents.some(a => a.state === 'waiting' || a.state === 'approval');

        ctx.strokeStyle = col.cyan(busy ? 0.3 : 0.1); ctx.setLineDash([2, 5]); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(p.x, p.y); ctx.stroke(); ctx.setLineDash([]);

        // touched files: newest first, fading with age, fanned out away from the core
        const files = (work.files.get(p.key) ?? []).filter(f => now - f.ts < FILE_TTL), placed = [];
        work.files.set(p.key, files);
        files.forEach((f, k) => {
          const a = out + (hash(f.path) - 0.5) * 1.2, r = 88 + hash(f.path + '#') * 56;
          f.x = Math.max(10, Math.min(W - 10, p.x + Math.cos(a) * r)); f.y = Math.max(10, Math.min(H - 10, p.y + Math.sin(a) * r));
          const age = now - f.ts, al = Math.max(0.15, 1 - age / FILE_TTL), fresh = Math.max(0, 1 - age / FRESH);
          ctx.strokeStyle = col.cyan(al * 0.25); ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(f.x, f.y); ctx.stroke();
          if (f.kind === 'write') { ctx.fillStyle = col.cyan(al); ctx.beginPath(); ctx.arc(f.x, f.y, 3.6, 0, TAU); ctx.fill(); }
          else { ctx.strokeStyle = col.cyan(al * 0.9); ctx.beginPath(); ctx.arc(f.x, f.y, 2.6, 0, TAU); ctx.stroke(); }
          if (fresh > 0) {
            ctx.strokeStyle = col.cyan(fresh * 0.8); ctx.beginPath(); ctx.arc(f.x, f.y, 5 + (1 - fresh) * 16, 0, TAU); ctx.stroke();
            const ag = p.agents.find(x => x.id === f.agent);
            if (ag?.px != null) { const g = ctx.createLinearGradient(ag.px, ag.py, f.x, f.y); g.addColorStop(0, col.cyan(0)); g.addColorStop(1, col.cyan(0.8 * fresh)); ctx.strokeStyle = g; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(ag.px, ag.py); ctx.lineTo(f.x, f.y); ctx.stroke(); ctx.lineWidth = 1; }
          }
          if (k < 4 && !placed.some(q => Math.abs(q.y - f.y) < 12 && Math.abs(q.x - f.x) < 110)) { // labels only where they do not collide
            placed.push(f);
            ctx.font = '400 9px ' + th.mono; ctx.fillStyle = col.cyan(Math.max(0.4, al)); ctx.textAlign = f.x >= p.x ? 'left' : 'right';
            ctx.fillText(fit(fileName(f.path), 150), f.x + (f.x >= p.x ? 7 : -7), f.y + 3); ctx.textAlign = 'left';
          }
        });

        // project glyph
        const R = 15;
        ctx.strokeStyle = col.cyan(busy ? 0.95 : 0.5); ctx.lineWidth = 1.5; ctx.beginPath();
        for (let k = 0; k < 6; k++) { const a = k / 6 * TAU + (busy ? t * 0.0004 : 0); k ? ctx.lineTo(p.x + Math.cos(a) * R, p.y + Math.sin(a) * R) : ctx.moveTo(p.x + Math.cos(a) * R, p.y + Math.sin(a) * R); }
        ctx.closePath(); ctx.stroke(); ctx.lineWidth = 1;
        if (ask) { const k = (t % 1600) / 1600; ctx.strokeStyle = col.red(1 - k); ctx.beginPath(); ctx.arc(p.x, p.y, R + 4 + k * 20, 0, TAU); ctx.stroke(); }

        // agents hang outside their project on a slowly turning ring
        p.agents.forEach((a, k) => {
          const ph = work.phase.get(a.id) ?? work.phase.set(a.id, hash(a.id) * TAU).get(a.id);
          const ang2 = ph + (reduce ? 0 : t * (a.state === 'running' ? 0.0007 : 0.0002)) * (k % 2 ? -1 : 1), r2 = 54 + (k % 2) * 12;
          a.px = p.x + Math.cos(ang2) * r2; a.py = p.y + Math.sin(ang2) * r2;
          const c = STATE_COL[a.state] ?? STATE_COL.idle;
          // the agent hangs on its project: a line from the hexagon's edge to the agent, brighter while it works
          ctx.strokeStyle = c(a.state === 'idle' ? 0.35 : 0.8); ctx.beginPath();
          ctx.moveTo(p.x + Math.cos(ang2) * R, p.y + Math.sin(ang2) * R); ctx.lineTo(a.px, a.py); ctx.stroke();
          ctx.fillStyle = c(1); ctx.shadowColor = c(1); ctx.shadowBlur = a.state === 'idle' ? 0 : 10;
          ctx.beginPath(); ctx.moveTo(a.px, a.py - 5.5); ctx.lineTo(a.px + 5.5, a.py); ctx.lineTo(a.px, a.py + 5.5); ctx.lineTo(a.px - 5.5, a.py); ctx.closePath(); ctx.fill(); ctx.shadowBlur = 0;
        });

        // text block beside the project, away from the core's side of the screen
        const shown = p.agents.slice(0, MAX_LINES), lines = 1 + shown.length + (p.agents.length > MAX_LINES ? 1 : 0), LH = 14, W_TXT = 200;
        const x0 = Math.max(8, Math.min(W - W_TXT - 8, p.x >= cx ? p.x + 88 : p.x - 88 - W_TXT));
        let y = p.y - (lines - 1) * LH / 2 + 4;
        ctx.font = '700 12px ' + th.head; ctx.fillStyle = col.cyan(1); ctx.fillText(fit(p.name.toUpperCase(), W_TXT), x0, y); y += LH;
        shown.forEach(a => {
          const c = STATE_COL[a.state] ?? STATE_COL.idle;
          ctx.fillStyle = c(1); ctx.beginPath(); ctx.moveTo(x0 + 4, y - 8); ctx.lineTo(x0 + 8, y - 4); ctx.lineTo(x0 + 4, y); ctx.lineTo(x0, y - 4); ctx.closePath(); ctx.fill();
          ctx.font = '600 10px ' + th.head; ctx.fillStyle = col.cyan(0.95); const nm = a.name + ' '; ctx.fillText(nm, x0 + 13, y);
          const w = ctx.measureText(nm).width;
          ctx.font = '400 10px ' + th.mono; ctx.fillStyle = a.state === 'idle' ? `rgba(${th.idle},0.8)` : col.cyan(0.75); ctx.fillText(fit(a.task + (a.subs ? ` · +${a.subs} sub` : ''), W_TXT - 13 - w), x0 + 13 + w, y); y += LH;
        });
        if (p.agents.length > MAX_LINES) { ctx.font = '400 10px ' + th.mono; ctx.fillStyle = col.cyan(0.5); ctx.fillText(`+${p.agents.length - MAX_LINES} more`, x0 + 13, y); }
      });
      ctx.textAlign = 'left';
    }

    function draw() {
      const t = reduce ? 0 : performance.now();
      ctx.clearRect(0, 0, W, H);
      const cx = W / 2, cy = H / 2, B = base();
      const sel = selected ? new Set(neighbors(selected).map(o => o.node.id).concat(selected.id)) : null;

      // --- decor rings ---
      ctx.lineWidth = 1;
      ctx.strokeStyle = col.cyan(0.08); ctx.setLineDash([2, 6]);
      [0.95, 0.62].forEach(f => { ctx.beginPath(); ctx.ellipse(cx, cy, W / 2 * 0.9 * f, H / 2 * 0.88 * f, 0, 0, TAU); ctx.stroke(); });
      ctx.setLineDash([]);
      for (let i = 0; i < 120; i++) { // tick ring
        const a = i / 120 * TAU + t * 0.00004, len = i % 10 === 0 ? 8 : 4, R = B * 0.36;
        ctx.strokeStyle = col.cyan(i % 10 === 0 ? 0.45 : 0.2);
        ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); ctx.lineTo(cx + Math.cos(a) * (R + len), cy + Math.sin(a) * (R + len)); ctx.stroke();
      }
      ctx.lineWidth = 2; ctx.strokeStyle = col.cyan(0.5);
      for (let i = 0; i < 3; i++) { const a = -t * 0.00012 + i * TAU / 3; ctx.beginPath(); ctx.arc(cx, cy, B * 0.4, a, a + 0.7); ctx.stroke(); }
      ctx.lineWidth = 1;
      ctx.strokeStyle = col.cyan(0.12); ctx.setLineDash([3, 5]);
      [0.17, 0.27].forEach(f => { ctx.beginPath(); ctx.arc(cx, cy, B * f, 0, TAU); ctx.stroke(); });
      ctx.setLineDash([]);

      if (mode === 'work') { drawWork(t); drawCore(t, cx, cy, B); requestAnimationFrame(draw); return; }

      // --- edges ---
      const P = nodes.map(n => npos(n, t));
      const strokeEdges = (kind, alpha, dash) => {
        ctx.beginPath(); ctx.setLineDash(dash); ctx.strokeStyle = col.cyan(alpha);
        edges.forEach(e => {
          if (e.kind !== kind || !vis(nodes[e.a]) || !vis(nodes[e.b])) return;
          if (kind === 'INFERRED' && !showInferred) return;
          if (sel && (sel.has(e.a) && sel.has(e.b))) return;
          ctx.moveTo(P[e.a][0], P[e.a][1]); ctx.lineTo(P[e.b][0], P[e.b][1]);
        });
        ctx.stroke(); ctx.setLineDash([]);
      };
      strokeEdges('EXTRACTED', sel ? 0.06 : 0.17, []);
      strokeEdges('INFERRED', sel ? 0.05 : 0.2, [3, 4]);
      if (sel) {
        edges.forEach(e => {
          if (!(e.a === selected.id || e.b === selected.id) || !vis(nodes[e.a]) || !vis(nodes[e.b])) return;
          if (e.kind === 'INFERRED' && !showInferred) return;
          ctx.strokeStyle = col.cyan(0.85); ctx.setLineDash(e.kind === 'INFERRED' ? [3, 4] : []);
          ctx.beginPath(); ctx.moveTo(P[e.a][0], P[e.a][1]); ctx.lineTo(P[e.b][0], P[e.b][1]); ctx.stroke(); ctx.setLineDash([]);
        });
      }

      // --- nodes ---
      nodes.forEach(n => {
        if (!vis(n)) return;
        const [x, y] = P[n.id], dim = sel && !sel.has(n.id);
        const rad = n.god ? 5.5 : n.hub ? 3.6 : 1.6 + Math.min(n.deg, 6) * 0.28;
        const fl = Math.max(0, 1 - (t - n.flash) / 900);
        ctx.fillStyle = col.node(CLUSTERS[n.ci].hue, dim ? 0.25 : n.god ? 1 : 0.8);
        ctx.beginPath(); ctx.arc(x, y, rad + fl * 3, 0, TAU); ctx.fill();
        if (n.god) { ctx.strokeStyle = col.node(CLUSTERS[n.ci].hue, 0.6); ctx.beginPath(); ctx.arc(x, y, rad + 5, 0, TAU); ctx.stroke(); }
        if (fl > 0) { ctx.strokeStyle = col.cyan(fl * 0.8); ctx.beginPath(); ctx.arc(x, y, 6 + (1 - fl) * 18, 0, TAU); ctx.stroke(); }
        if (matches(n)) { ctx.strokeStyle = col.gold(0.95); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, rad + 6, 0, TAU); ctx.stroke(); ctx.lineWidth = 1; }
        if (n === selected) { ctx.strokeStyle = col.cyan(1); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, rad + 8, 0, TAU); ctx.stroke(); ctx.lineWidth = 1; }
        const label = n.god || n === hover || n === selected || (sel && sel.has(n.id) && n.hub);
        if (label) {
          ctx.font = (n.god ? '500 11px ' : '400 10px ') + th.mono;
          ctx.fillStyle = col.cyan(n.god ? 0.85 : 1); ctx.fillText(n.name, x + rad + 8, y + 3);
        }
      });

      // --- beams (agent reads memory) ---
      if (!reduce && opts.auto !== false && t - lastBeam > 900) { lastBeam = t; spawnBeam(t); }
      for (let i = beams.length - 1; i >= 0; i--) {
        const b = beams[i], p = (t - b.t0) / b.dur;
        if (p > 1.3) { beams.splice(i, 1); continue; }
        const [nx, ny] = P[b.n.id], ax = b.a.sx, ay = b.a.sy;
        if (ax == null) continue;
        const q = Math.min(1, p * 1.5);
        const ex = ax + (nx - ax) * q, ey = ay + (ny - ay) * q;
        const g = ctx.createLinearGradient(ax, ay, ex, ey); g.addColorStop(0, col.cyan(0)); g.addColorStop(1, col.cyan(0.8 * (1 - Math.max(0, p - 1))));
        ctx.strokeStyle = g; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ex, ey); ctx.stroke(); ctx.lineWidth = 1;
        ctx.fillStyle = col.cyan(1); ctx.beginPath(); ctx.arc(ex, ey, 2.5, 0, TAU); ctx.fill();
        if (p >= 0.66 && b.n.flash < b.t0) b.n.flash = t;
      }

      drawCore(t, cx, cy, B);

      // --- agents ---
      agents.forEach(a => {
        const R = B * (a.ring ? 0.27 : 0.17), ang = a.ph + t * (a.ring ? -0.00009 : 0.00014);
        a.sx = cx + Math.cos(ang) * R; a.sy = cy + Math.sin(ang) * R;
        const c = STATE_COL[a.state];
        ctx.strokeStyle = col.cyan(0.1); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(a.sx, a.sy); ctx.stroke();
        if (a.state === 'waiting' || a.state === 'approval') {
          const k = (t % 1600) / 1600; ctx.strokeStyle = c(1 - k); ctx.beginPath(); ctx.arc(a.sx, a.sy, 8 + k * 22, 0, TAU); ctx.stroke();
        }
        ctx.fillStyle = c(1); ctx.shadowColor = c(1); ctx.shadowBlur = a.state === 'idle' ? 0 : 12;
        ctx.beginPath(); ctx.moveTo(a.sx, a.sy - 7); ctx.lineTo(a.sx + 7, a.sy); ctx.lineTo(a.sx, a.sy + 7); ctx.lineTo(a.sx - 7, a.sy); ctx.closePath(); ctx.fill(); ctx.shadowBlur = 0;
        ctx.font = '600 11px ' + th.head; ctx.fillStyle = col.cyan(0.95);
        ctx.fillText(a.name, a.sx + 12, a.sy + 4);
      });

      requestAnimationFrame(draw);
    }

    // ---- interaction ----
    const tip = opts.tooltip;
    const pick = (mx, my) => {
      const t = reduce ? 0 : performance.now();
      if (mode === 'work') {
        for (const p of work.projects) for (const a of p.agents) if (a.px != null && Math.hypot(a.px - mx, a.py - my) < 11) return { agent: a, task: true };
        for (const p of work.projects) for (const f of work.files.get(p.key) ?? []) if (f.x != null && Math.hypot(f.x - mx, f.y - my) < 8) return { file: f, project: p };
        for (const p of work.projects) if (p.x != null && Math.hypot(p.x - mx, p.y - my) < 20) return { project: p };
        return null;
      }
      for (const a of agents) if (a.sx != null && Math.hypot(a.sx - mx, a.sy - my) < 13) return { agent: a };
      let best = null, bd = 9;
      nodes.forEach(n => { if (!vis(n)) return; const [x, y] = npos(n, t); const d = Math.hypot(x - mx, y - my); if (d < bd) { bd = d; best = n; } });
      return best ? { node: best } : null;
    };
    canvas.addEventListener('mousemove', e => {
      const b = canvas.getBoundingClientRect(), mx = e.clientX - b.left, my = e.clientY - b.top, h = pick(mx, my);
      hover = h && h.node || null; canvas.style.cursor = h ? 'pointer' : 'default';
      if (!tip) return;
      if (!h) { tip.hidden = true; return; }
      tip.hidden = false; tip.style.left = Math.min(mx + 14, W - 200) + 'px'; tip.style.top = (my + 14) + 'px';
      tip.innerHTML = h.file
        ? `<b>${esc(fileName(h.file.path))}</b> · ${h.file.kind === 'write' ? 'changed' : 'read'} ${Math.round((Date.now() - h.file.ts) / 1000)}s ago<br>${esc(h.file.path)}`
        : h.project && !h.agent ? `<b>${esc(h.project.name)}</b><br>${esc(h.project.path)}`
        : h.agent && h.task ? `<b>${esc(h.agent.name)}</b> · ${esc(h.agent.type)} · ${esc(h.agent.state)}<br>${esc(h.agent.task)}${opts.onAgent ? '<br>click to chat' : ''}`
        : h.agent ? `<b>${esc(h.agent.name)}</b> · ${esc(h.agent.type)} · ${esc(h.agent.state)}${opts.onAgent ? '<br>click to chat' : ''}`
        : `<b>${esc(h.node.name)}</b><br>${esc(CLUSTERS[h.node.ci].name)} · ${esc(h.node.kind)} · ${h.node.deg} links${h.node.file ? `<br>${esc(h.node.file)}${h.node.line ? ':' + h.node.line : ''}` : ''}`;
    });
    canvas.addEventListener('mouseleave', () => { hover = null; if (tip) tip.hidden = true; });
    canvas.addEventListener('click', e => {
      const b = canvas.getBoundingClientRect(), h = pick(e.clientX - b.left, e.clientY - b.top);
      if (h?.agent && opts.onAgent) { opts.onAgent(h.agent); return; }
      if (mode === 'work') return;
      selected = h && h.node ? (h.node === selected ? null : h.node) : null;
      if (opts.onSelect) opts.onSelect(selected, selected ? neighbors(selected) : []);
    });

    requestAnimationFrame(draw);

    return {
      clusters: CLUSTERS, nodes, edges, agents, neighbors,
      clusterColor: i => col.node(CLUSTERS[i].hue, 1),
      stats: () => ({ nodes: nodes.length, edges: edges.length, communities: CLUSTERS.length }),
      setCluster(i, on) { CLUSTERS[i].visible = on; if (selected && !vis(selected)) selected = null; },
      setInferred(on) { showInferred = on; },
      search(q) { searchQ = (q || '').trim().toLowerCase(); return searchQ ? nodes.filter(n => vis(n) && matches(n)).length : 0; },
      loadGraph, nodeForFile,
      clear() { CLUSTERS.length = 0; nodes.length = 0; edges.length = 0; byFile.clear(); beams.length = 0; selected = null; hover = null; },
      /** beam from an agent to the node of the file it touches; without a target only the demo animates */
      pulse(agentId, file) { const a = agents.find(x => x.id === agentId); if (!a || reduce) return; const target = file ? nodeForFile(file) : null; if (target || opts.demo) spawnBeam(performance.now(), a, target); },
      setAgents(list) { // update in place so running beams keep their endpoints
        const byId = new Map(agents.map(a => [a.id, a]));
        const next = list.map((a, i) => {
          const cur = byId.get(a.id);
          if (cur) return Object.assign(cur, { name: a.name, type: a.type, state: a.state });
          return { ...a, ring: i < 3 ? 0 : 1, ph: (i % 3) / 3 * TAU + (i < 3 ? 0 : 0.6) };
        });
        agents.length = 0; agents.push(...next);
      },
      /** 'memory' (code graph) or 'work' (projects, agents, tasks, touched files) */
      setMode(m) { mode = m; selected = null; hover = null; if (tip) tip.hidden = true; if (opts.onSelect) opts.onSelect(null, []); },
      /** projects: [{ key, name, path, agents: [{ id, name, type, state, task, subs }] }]; touched files are kept per project key */
      setWork(projects) { work.projects = projects.map(p => ({ ...p, agents: p.agents.map(a => Object.assign(work.projects.flatMap(o => o.agents).find(x => x.id === a.id) ?? {}, a)) })); },
      /** an agent read or changed a file inside a project; ts lets a page replay history */
      touch(projectKey, agentId, path, kind, ts = Date.now()) {
        const list = work.files.get(projectKey) ?? [];
        const i = list.findIndex(f => f.path === path), wrote = i >= 0 && list[i].kind === 'write';
        if (i >= 0) list.splice(i, 1);
        list.unshift({ path, kind: wrote ? 'write' : kind, ts, agent: agentId });
        work.files.set(projectKey, list.slice(0, MAX_FILES));
      },
      select(n) { selected = n; if (opts.onSelect) opts.onSelect(n, n ? neighbors(n) : []); },
    };
  };
})();
