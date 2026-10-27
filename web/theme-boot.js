/* Light/dark mode and accent colour. Loaded as a blocking script in every page's <head>, so the theme is set before the first paint.
   The choice lives in this browser's localStorage (the desktop app and each browser keep their own). */
(function () {
  const KEY = 'macii.theme';
  const DEFAULT = { mode: 'dark', accent: '#22d3ee' };
  const BG = { dark: '#070d16', light: '#f4f6fa' }; // page backgrounds the accent has to be readable on (theme.css)
  const MIN_CONTRAST = 4.5; // accent is used as text colour as well as fill

  const hexToRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const lum = ([r, g, b]) => { const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  function rgbToHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    if (!d) return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1));
    const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }
  function hslToRgb([h, s, l]) {
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [r + m, g + m, b + m].map(v => Math.round(v * 255));
  }

  /** the picked colour, moved along its lightness only as far as needed to be readable on the page background */
  function readable(hex, mode) {
    const bg = hexToRgb(BG[mode]);
    let rgb = hexToRgb(hex);
    if (contrast(rgb, bg) >= MIN_CONTRAST) return rgb;
    const [h, s, l] = rgbToHsl(rgb), step = mode === 'light' ? -0.01 : 0.01;
    for (let k = l + step; k >= 0 && k <= 1; k += step) {
      rgb = hslToRgb([h, s, k]);
      if (contrast(rgb, bg) >= MIN_CONTRAST) return rgb;
    }
    return rgb;
  }

  const valid = t => t && (t.mode === 'light' || t.mode === 'dark' || t.mode === 'system') && /^#[0-9a-f]{6}$/i.test(t.accent);
  function read() {
    try { const t = JSON.parse(localStorage.getItem(KEY)); if (valid(t)) return t; } catch { /* storage blocked or damaged: defaults */ }
    return { ...DEFAULT };
  }
  const dark = window.matchMedia('(prefers-color-scheme: dark)');
  const resolve = t => (t.mode === 'system' ? (dark.matches ? 'dark' : 'light') : t.mode);

  function apply() {
    const t = read(), mode = resolve(t), rgb = readable(t.accent, mode), root = document.documentElement;
    root.dataset.theme = mode;
    root.style.setProperty('--a-rgb', rgb.join(', '));
    // text on a solid accent fill: whichever of near-black and white reads better
    root.style.setProperty('--on-accent', contrast(rgb, [3, 24, 32]) >= contrast(rgb, [255, 255, 255]) ? '#031820' : '#ffffff');
    window.dispatchEvent(new Event('themechange')); // graph.js re-reads its colours
  }

  function set(change) {
    const next = { ...read(), ...change };
    if (!valid(next)) throw new Error('invalid theme');
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* not persisted; still applied for this page */ }
    apply();
  }

  window.maciiTheme = { DEFAULT, get: read, set, applied: () => getComputedStyle(document.documentElement).getPropertyValue('--a-rgb').trim() };
  apply();
  dark.addEventListener('change', apply);
  addEventListener('storage', e => { if (e.key === KEY) apply(); }); // changed in another tab or in the embedded chat
})();
