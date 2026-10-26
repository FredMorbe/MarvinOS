/* AIOS HUD — memory graph + agent orbit visualisation (mockup, fake data, seeded layout) */
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

  const CLUSTERS = [
    { name: 'auth',       hue: 188, names: ['AuthService','verifyToken','signJwt','SessionStore','refreshToken','hashPassword','AuthGuard','login.route','users.schema','OAuthClient'] },
    { name: 'scheduler',  hue: 198, names: ['RunScheduler','CronParser','nextRun','JobQueue','Routine','retryPolicy','tick','RunLock','schedule.yaml','Backoff'] },
    { name: 'adapters',   hue: 176, names: ['ClaudeAdapter','CodexAdapter','spawnCli','StreamParser','parseEvent','OllamaClient','resumeSession','AdapterBase','jsonl.js','usageFromEvent'] },
    { name: 'inbox',      hue: 208, names: ['InboxService','sendMessage','Question','Approval','markRead','answerQuestion','inbox.schema','Notifier','toast','ResultCard'] },
    { name: 'subagents',  hue: 182, names: ['SubagentTree','parentToolUseId','TaskEvent','RunTracker','Node','aggregateUsage','tree.js','spawnDepth','Lifecycle','TreeView'] },
    { name: 'ui-hud',     hue: 214, names: ['HudShell','GraphCanvas','Panel','useLive','Ticker','Meter','theme.css','OrbitRing','Tooltip','NavTabs'] },
    { name: 'storage',    hue: 170, names: ['Db','migrate','runs.schema','RunRepo','AgentRepo','InboxRepo','query','Tx','seed.sql','Backup'] },
    { name: 'docs',       hue: 222, names: ['README','ARCHITECTURE.md','ADR-001','AdapterGuide','Permissions.md','Glossary','Roadmap.md','Runbook','Changelog','Security.md'] },
  ];
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
    const agents = (opts.agents || DEFAULT_AGENTS).map((a, i) => ({ ...a, ring: i < 3 ? 0 : 1, ph: (i % 3) / 3 * TAU + (i < 3 ? 0 : 0.6) }));
    const r = rng(opts.seed || 7);
    const nodes = [], edges = [];
    let W = 0, H = 0, dpr = 1, hover = null, selected = null, searchQ = '', showInferred = true, lastBeam = 0;
    const beams = [];

    // ---- build graph ----
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
    const gods = nodes.filter(n => n.god);
    gods.forEach((g, i) => link(g.id, gods[(i + 1) % gods.length].id, 'INFERRED'));
    for (let i = 0; i < 28; i++) {
      const a = nodes[Math.floor(r() * nodes.length)], b = nodes[Math.floor(r() * nodes.length)];
      if (a.ci !== b.ci) link(a.id, b.id, i % 4 === 0 ? 'EXTRACTED' : 'INFERRED');
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
      return edges.filter(e => e.a === n.id || e.b === n.id).map(e => ({ node: nodes[e.a === n.id ? e.b : e.a], kind: e.kind }));
    }

    function spawnBeam(t) {
      const run = agents.filter(a => a.state === 'running');
      const pool = nodes.filter(vis);
      if (!run.length || !pool.length) return;
      const a = run[Math.floor(Math.random() * run.length)];
      const n = Math.random() < 0.45 ? gods.filter(vis)[Math.floor(Math.random() * gods.filter(vis).length)] || pool[0] : pool[Math.floor(Math.random() * pool.length)];
      beams.push({ a, n, t0: t, dur: 1200 });
      if (opts.onAccess) opts.onAccess(a, n);
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
      if (!reduce && t - lastBeam > 900) { lastBeam = t; spawnBeam(t); }
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

      // --- core ---
      const gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, B * 0.16);
      gr.addColorStop(0, col.cyan(0.35)); gr.addColorStop(1, col.cyan(0));
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(cx, cy, B * 0.16, 0, TAU); ctx.fill();
      ctx.strokeStyle = col.cyan(0.9); ctx.lineWidth = 1.5;
      ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = i / 6 * TAU + t * 0.0003; const X = cx + Math.cos(a) * B * 0.075, Y = cy + Math.sin(a) * B * 0.075; i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); } ctx.closePath(); ctx.stroke();
      ctx.lineWidth = 1; ctx.fillStyle = col.cyan(1); ctx.textAlign = 'center';
      ctx.font = '700 15px ' + th.head; ctx.fillText('AIOS', cx, cy + 3);
      ctx.font = '400 8px ' + th.mono; ctx.fillStyle = col.cyan(0.6); ctx.fillText('CORE ONLINE', cx, cy + 15);
      ctx.textAlign = 'left';

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
      tip.innerHTML = h.agent
        ? `<b>${h.agent.name}</b> · ${h.agent.type} · ${h.agent.state}`
        : `<b>${h.node.name}</b><br>${CLUSTERS[h.node.ci].name} · ${h.node.kind} · ${h.node.deg} links`;
    });
    canvas.addEventListener('mouseleave', () => { hover = null; if (tip) tip.hidden = true; });
    canvas.addEventListener('click', e => {
      const b = canvas.getBoundingClientRect(), h = pick(e.clientX - b.left, e.clientY - b.top);
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
      select(n) { selected = n; if (opts.onSelect) opts.onSelect(n, n ? neighbors(n) : []); },
    };
  };
})();
