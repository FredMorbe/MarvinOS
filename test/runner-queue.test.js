import test from 'node:test';
import assert from 'node:assert/strict';
import { folderKey, nextRunnable } from '../server/runner.js';

const folders = { 1: 'a', 2: 'a', 3: 'b', 4: 'a' };
const folderOf = id => folders[id];

test('a queued run waits while another run uses its folder, others pass it', () => {
  assert.equal(nextRunnable([2, 3], [1], folderOf), 1); // 2 waits for 1, 3 goes
  assert.equal(nextRunnable([2, 4], [1], folderOf), -1); // everything queued is blocked
  assert.equal(nextRunnable([2], [], folderOf), 0);
  assert.equal(nextRunnable([], [1], folderOf), -1);
});

test('folder keys ignore case', () => {
  assert.equal(folderKey('D:\\Work\\Proj'), folderKey('d:\\work\\proj'));
});
