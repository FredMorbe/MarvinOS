import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { listFolder, roots } from '../server/browse.js';

test('lists only sub-folders, sorted, without hidden ones, and knows its parent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aios-browse-'));
  try {
    for (const n of ['beta', 'Alpha', '.hidden']) mkdirSync(join(dir, n));
    writeFileSync(join(dir, 'file.txt'), 'x');
    const r = listFolder(dir);
    assert.deepEqual(r.dirs.map(d => d.name), ['Alpha', 'beta']);
    assert.equal(r.parent, dirname(dir));
    assert.equal(listFolder(join(dir, 'Alpha')).dirs.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('no path lists the roots; a root has an empty parent', () => {
  const r = listFolder('');
  assert.ok(r.dirs.length >= 1);
  assert.deepEqual(r.dirs.map(d => d.path), roots());
  const root = parse(process.cwd()).root;
  assert.equal(listFolder(root).parent, '');
});

test('errors are loud and typed', () => {
  assert.throws(() => listFolder(join(tmpdir(), 'aios-does-not-exist-xyz')), { code: 'NOT_FOUND' });
  const dir = mkdtempSync(join(tmpdir(), 'aios-browse-'));
  try { writeFileSync(join(dir, 'f'), 'x'); assert.throws(() => listFolder(join(dir, 'f')), { code: 'NOT_DIR' }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
