/* AIOS HUD — style switcher. Sets <html data-theme>, injects the picker, remembers the choice (?theme=… overrides). */
(function () {
  const THEMES = [['arc', 'Arc Reactor'], ['mark3', 'Mark III'], ['ghost', 'Ghost'], ['blueprint', 'Blueprint'], ['phosphor', 'Phosphor'], ['katsumii', 'Katsumii'], ['x25v', 'X25V']];
  const root = document.documentElement;

  const fonts = document.createElement('link');
  fonts.rel = 'stylesheet';
  fonts.href = 'https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;500;600;700&family=DM+Mono:wght@400;500&family=DM+Sans:wght@500;700&family=IBM+Plex+Mono:wght@400;500&family=Inter:wght@400;500;600;700&family=Manrope:wght@400;500;600&family=Share+Tech+Mono&family=Space+Grotesk:wght@400;500;600;700&display=swap';
  document.head.appendChild(fonts);

  let saved = null;
  try { saved = localStorage.getItem('aios-theme'); } catch (e) { /* storage unavailable: no persistence */ }
  const wanted = new URLSearchParams(location.search).get('theme');
  const start = [wanted, saved, 'arc'].find(t => THEMES.some(x => x[0] === t));
  root.dataset.theme = start;

  function apply(t, persist) {
    root.dataset.theme = t;
    if (persist) { try { localStorage.setItem('aios-theme', t); } catch (e) { /* ignore */ } }
    document.querySelectorAll('.theme-pick button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.t === t)));
    window.dispatchEvent(new Event('themechange'));
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (new URLSearchParams(location.search).has('embed')) return; // thumbnails in styles.html: no picker
    const bar = document.createElement('div');
    bar.className = 'theme-pick';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Style');
    bar.innerHTML = THEMES.map(([id, label], i) => `<button type="button" data-t="${id}" title="Key ${i + 1}"><kbd>${i + 1}</kbd>${label}</button>`).join('');
    bar.addEventListener('click', e => { const b = e.target.closest('button'); if (b) apply(b.dataset.t, true); });
    document.body.appendChild(bar);
    apply(root.dataset.theme, false);
  });

  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    const t = THEMES[parseInt(e.key, 10) - 1];
    if (t) apply(t[0], true);
  });
})();
