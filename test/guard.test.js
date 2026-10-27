import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuard, evaluateGuard, thresholdFor } from '../server/guard.js';
import { DEFAULTS, validateSettings, withDefaults } from '../server/settings.js';

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const sec = ms => ms / 1000;
const limits = ({ five = 0.1, seven = 0.1, fiveReset = NOW + 3_600_000, sevenReset = NOW + 86_400_000, fiveStatus = 'allowed', sevenStatus = 'allowed' } = {}) => ({
  windows: {
    five_hour: { utilization: five, resetsAt: sec(fiveReset), status: fiveStatus },
    seven_day: { utilization: seven, resetsAt: sec(sevenReset), status: sevenStatus },
  },
});
const guard = (over = {}) => ({ ...DEFAULTS.guard, ...over });
const check = (l, over = {}, priority = 'normal') => evaluateGuard({ limits: l, guard: guard(over), priority, now: NOW });

test('Codex schedules and tasks use Codex limits independently of the Claude subscription', () => {
  const providerLimits = { claude: limits({ seven: 0.99 }) };
  const g = createGuard({ store: { getLimits: () => providerLimits }, getSettings: () => ({ guard: guard() }) });
  assert.equal(g.check({ type: 'claude' }, NOW).ok, false);
  assert.equal(g.check({ type: 'codex' }, NOW).ok, true);
  providerLimits.codex = limits({ five: 0.99 });
  assert.equal(g.check({ type: 'codex' }, NOW).ok, false);
});

test('allows when the guard is off, nothing was reported yet, or usage is below the thresholds', () => {
  assert.equal(check(limits({ five: 0.99 }), { enabled: false }).ok, true);
  assert.equal(evaluateGuard({ limits: undefined, guard: guard(), now: NOW }).ok, true);
  assert.equal(evaluateGuard({ limits: { windows: null }, guard: guard(), now: NOW }).ok, true);
  assert.equal(check(limits({ five: 0.5, seven: 0.5 })).ok, true);
});

test('blocks at the 5-hour threshold and retries when that window resets', () => {
  const v = check(limits({ five: 0.86 }));
  assert.equal(v.ok, false);
  assert.equal(v.window, 'five_hour');
  assert.equal(v.until, NOW + 3_600_000);
  assert.match(v.reason, /5-hour window at 86%, threshold 85%/);
});

test('the 7-day window wins when both are over: waiting for the 5-hour reset would not help', () => {
  const v = check(limits({ five: 0.9, seven: 0.97 }));
  assert.equal(v.window, 'seven_day');
  assert.equal(v.until, NOW + 86_400_000);
});

test('a window that has already rolled over is stale data and does not block', () => {
  assert.equal(check(limits({ five: 0.99, fiveReset: NOW - 1000 })).ok, true);
});

test('priority moves the threshold: high may use more of the window, low stops earlier', () => {
  const l = limits({ five: 0.9 });
  assert.equal(check(l, {}, 'normal').ok, false);   // 0.90 >= 0.85
  assert.equal(check(l, {}, 'high').ok, true);      // 0.90 <  0.95
  assert.equal(check(limits({ five: 0.72 }), {}, 'low').ok, false);    // 0.72 >= 0.70
  assert.equal(check(limits({ five: 0.72 }), {}, 'normal').ok, true);
  assert.equal(thresholdFor(guard({ five_hour: 1 }), 'five_hour', 'high'), 0.99); // never reaches 100%
});

test('a refused window status blocks regardless of utilization; allowed_* statuses still run', () => {
  const refused = check(limits({ five: 0.1, fiveStatus: 'rejected' }));
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /refused by the CLI \(status "rejected"\)/);
  assert.equal(check(limits({ five: 0.1, fiveStatus: 'allowed_warning' })).ok, true);
});

test('malformed window data is ignored instead of blocking everything', () => {
  assert.equal(check({ windows: { five_hour: { utilization: 'high', resetsAt: 'soon' } } }).ok, true);
});

test('settings: defaults are merged under stored values', () => {
  const s = withDefaults({ guard: { five_hour: 0.7 } });
  assert.equal(s.guard.five_hour, 0.7);
  assert.equal(s.guard.seven_day, DEFAULTS.guard.seven_day);
  assert.deepEqual(withDefaults(null), DEFAULTS);
});

test('settings: valid input passes, bad input is rejected with every problem named', () => {
  const ok = validateSettings({ notify: { enabled: true, types: ['question', 'question'], failed_runs: false }, guard: { enabled: true, five_hour: 0.8, seven_day: 1 } });
  assert.deepEqual(ok.notify.types, ['question']);
  assert.throws(() => validateSettings({ notify: { enabled: 'yes', types: ['nope'], failed_runs: true }, guard: { enabled: true, five_hour: 0.2, seven_day: 0.9 }, extra: 1 }),
    e => /unknown section "extra"/.test(e.message) && /notify.enabled/.test(e.message) && /notify.types/.test(e.message) && /guard.five_hour/.test(e.message));
  assert.throws(() => validateSettings(null), /must be an object/);
});
