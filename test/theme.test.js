import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// theme-boot.js is a browser script: run it against a minimal fake page
function boot({ stored, systemDark = true } = {}) {
  const props = {}, store = new Map(stored === undefined ? [] : [['macii.theme', typeof stored === 'string' ? stored : JSON.stringify(stored)]]);
  const events = [];
  const mq = { matches: systemDark, addEventListener: () => {} };
  const root = { dataset: {}, style: { setProperty: (k, v) => { props[k] = v; } } };
  const window = {
    matchMedia: () => mq, dispatchEvent: e => events.push(e.type), addEventListener: () => {},
    localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
  };
  const ctx = vm.createContext({ window, document: { documentElement: root }, localStorage: window.localStorage, matchMedia: window.matchMedia, addEventListener: () => {}, Event: class { constructor(type) { this.type = type; } }, getComputedStyle: () => ({ getPropertyValue: () => props['--a-rgb'] }) });
  vm.runInContext(readFileSync(new URL('../web/theme-boot.js', import.meta.url), 'utf8'), ctx);
  return { props, root, store, events, theme: window.maciiTheme };
}
const rgb = s => s.split(',').map(Number);
const lum = ([r, g, b]) => { const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('first start: dark mode, the default cyan unchanged', () => {
  const t = boot();
  assert.equal(t.root.dataset.theme, 'dark');
  assert.equal(t.props['--a-rgb'], '34, 211, 238');
  assert.equal(t.props['--on-accent'], '#031820');
  assert.ok(t.events.includes('themechange'));
});

test('light mode darkens an accent that is too pale to read, dark mode brightens one that is too dark', () => {
  const light = boot({ stored: { mode: 'light', accent: '#fde047' } });
  assert.equal(light.root.dataset.theme, 'light');
  assert.ok(contrast(rgb(light.props['--a-rgb']), [244, 246, 250]) >= 4.5);
  assert.equal(light.props['--on-accent'], '#ffffff');
  const dark = boot({ stored: { mode: 'dark', accent: '#1e3a8a' } });
  assert.ok(contrast(rgb(dark.props['--a-rgb']), [7, 13, 22]) >= 4.5);
  assert.equal(dark.props['--on-accent'], '#031820');
});

test('a readable accent is used exactly as picked', () => {
  assert.equal(boot({ stored: { mode: 'light', accent: '#0b7a8b' } }).props['--a-rgb'], '11, 122, 139');
  assert.equal(boot({ stored: { mode: 'dark', accent: '#ec4899' } }).props['--a-rgb'], '236, 72, 153');
});

test('system mode follows the system; the pick survives a mode change', () => {
  assert.equal(boot({ stored: { mode: 'system', accent: '#22d3ee' }, systemDark: false }).root.dataset.theme, 'light');
  assert.equal(boot({ stored: { mode: 'system', accent: '#22d3ee' }, systemDark: true }).root.dataset.theme, 'dark');
  const t = boot({ stored: { mode: 'dark', accent: '#fde047' } });
  const darkRgb = t.props['--a-rgb'];
  t.theme.set({ mode: 'light' });
  assert.notEqual(t.props['--a-rgb'], darkRgb);
  assert.equal(t.theme.get().accent, '#fde047', 'the picked colour itself is stored, not the adjusted one');
  t.theme.set({ mode: 'dark' });
  assert.equal(t.props['--a-rgb'], darkRgb);
});

test('damaged or invalid storage falls back to the defaults; set() refuses invalid input', () => {
  assert.equal(boot({ stored: '{nope' }).root.dataset.theme, 'dark');
  assert.equal(boot({ stored: { mode: 'sepia', accent: '#22d3ee' } }).root.dataset.theme, 'dark');
  assert.equal(boot({ stored: { mode: 'light', accent: 'red' } }).props['--a-rgb'], '34, 211, 238');
  const t = boot();
  assert.throws(() => t.theme.set({ accent: 'javascript:alert(1)' }), /invalid theme/);
  assert.throws(() => t.theme.set({ mode: 'neon' }), /invalid theme/);
  assert.equal(t.store.size, 0, 'nothing invalid is written');
});
