// Limit guard: decides whether a scheduled run may start given the subscription windows the CLI reported.
// Pure functions, so the rules can be tested without a clock or a database.

// A high-priority agent may use more of the window, a low-priority one stops earlier.
const PRIORITY_OFFSET = { low: -0.15, normal: 0, high: 0.10 };
// the 7-day window is checked first: waiting for the 5-hour reset does not help if the weekly cap is the problem
const WINDOWS = [['seven_day', '7-day'], ['five_hour', '5-hour']];
const pct = u => `${Math.round(u * 100)}%`;

export const thresholdFor = (guard, key, priority = 'normal') =>
  Math.min(0.99, Math.max(0.1, guard[key] + (PRIORITY_OFFSET[priority] ?? 0)));

/**
 * @param limits  what the runner stores: { windows: { five_hour: { utilization, resetsAt (epoch seconds), status }, seven_day: {...} } }
 * @returns { ok: true } or { ok: false, window, label, utilization, threshold, until (epoch ms), reason }
 */
export function evaluateGuard({ limits, guard, priority = 'normal', now = Date.now() }) {
  if (!guard.enabled) return { ok: true };
  const windows = limits?.windows;
  if (!windows) return { ok: true }; // nothing reported yet: the first run discovers the limits
  for (const [key, label] of WINDOWS) {
    const w = windows[key];
    if (!w || typeof w.utilization !== 'number' || typeof w.resetsAt !== 'number') continue;
    const until = w.resetsAt * 1000;
    if (until <= now) continue; // this window has rolled over since it was reported: the number is stale
    const threshold = thresholdFor(guard, key, priority);
    const refused = typeof w.status === 'string' && !w.status.startsWith('allowed'); // 'allowed_warning' etc. still run
    if (refused || w.utilization >= threshold) {
      return {
        ok: false, window: key, label, utilization: w.utilization, threshold, until,
        reason: refused ? `${label} window refused by the CLI (status "${w.status}")` : `${label} window at ${pct(w.utilization)}, threshold ${pct(threshold)}`,
      };
    }
  }
  return { ok: true };
}

/** @param limitKey  which entry of the stored limits an agent draws on (its provider; for Claude, its account) */
export function createGuard({ store, getSettings, limitKey = agent => agent.type }) {
  return { check: (agent, now = Date.now()) => evaluateGuard({ limits: store.getLimits()[limitKey(agent)], guard: getSettings().guard, priority: agent.priority, now }) };
}
