import { readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';

const MAX_ENTRIES = 500;

/** Windows drive roots that exist, or "/" elsewhere */
export const roots = () => process.platform === 'win32'
  ? 'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('').map(l => `${l}:\\`).filter(p => existsSync(p))
  : ['/'];

/**
 * Sub-folders of `path` for the folder picker. Throws with a `code` ('NOT_FOUND', 'NOT_DIR', 'DENIED') the route maps to a status.
 * Without a path it lists the roots, so the picker can start anywhere.
 */
export function listFolder(path) {
  if (!path) return { path: '', parent: null, home: homedir(), dirs: roots().map(r => ({ name: r, path: r })), truncated: false };
  const abs = resolve(path);
  let st;
  try { st = statSync(abs); } catch (e) { throw Object.assign(new Error(`folder does not exist: ${abs}`), { code: 'NOT_FOUND' }); }
  if (!st.isDirectory()) throw Object.assign(new Error(`not a folder: ${abs}`), { code: 'NOT_DIR' });
  let entries;
  try { entries = readdirSync(abs, { withFileTypes: true }); } catch (e) { throw Object.assign(new Error(`cannot read ${abs}: ${e.code ?? e.message}`), { code: 'DENIED' }); }
  const dirs = entries.filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => ({ name: d.name, path: join(abs, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const atRoot = parse(abs).root === abs;
  return { path: abs, parent: atRoot ? '' : dirname(abs), home: homedir(), dirs: dirs.slice(0, MAX_ENTRIES), truncated: dirs.length > MAX_ENTRIES };
}
