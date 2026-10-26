export const NOTIFY_TYPES = ['question', 'approval', 'warning', 'result'];

export const DEFAULTS = {
  notify: { enabled: true, types: [...NOTIFY_TYPES], failed_runs: true },
  guard: { enabled: true, five_hour: 0.85, seven_day: 0.95 },
};

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

/** merge stored values over the defaults (new defaults appear automatically for old databases) */
export const withDefaults = stored => ({
  notify: { ...DEFAULTS.notify, ...(stored?.notify ?? {}) },
  guard: { ...DEFAULTS.guard, ...(stored?.guard ?? {}) },
});

/** validate user input; unknown keys and out-of-range values are errors, never silently dropped */
export function validateSettings(input) {
  const errs = [];
  if (!isObj(input)) throw new Error('settings must be an object');
  for (const k of Object.keys(input)) if (!(k in DEFAULTS)) errs.push(`unknown section "${k}"`);
  const n = input.notify, g = input.guard;
  if (!isObj(n)) errs.push('notify must be an object');
  else {
    for (const k of Object.keys(n)) if (!(k in DEFAULTS.notify)) errs.push(`unknown notify setting "${k}"`);
    for (const k of ['enabled', 'failed_runs']) if (typeof n[k] !== 'boolean') errs.push(`notify.${k} must be true or false`);
    if (!Array.isArray(n.types) || n.types.some(t => !NOTIFY_TYPES.includes(t))) errs.push(`notify.types must be a list of ${NOTIFY_TYPES.join(', ')}`);
  }
  if (!isObj(g)) errs.push('guard must be an object');
  else {
    for (const k of Object.keys(g)) if (!(k in DEFAULTS.guard)) errs.push(`unknown guard setting "${k}"`);
    if (typeof g.enabled !== 'boolean') errs.push('guard.enabled must be true or false');
    for (const k of ['five_hour', 'seven_day']) if (typeof g[k] !== 'number' || !(g[k] >= 0.5 && g[k] <= 1)) errs.push(`guard.${k} must be a number between 0.5 and 1`);
  }
  if (errs.length) throw new Error(errs.join('; '));
  return { notify: { enabled: n.enabled, types: [...new Set(n.types)], failed_runs: n.failed_runs }, guard: { enabled: g.enabled, five_hour: g.five_hour, seven_day: g.seven_day } };
}
