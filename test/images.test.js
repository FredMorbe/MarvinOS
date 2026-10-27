import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_IMAGE_BYTES, resolveShownImage, saveUploads, sniffImage, UPLOAD_NAME } from '../server/images.js';
import { buildClaudeArgs, buildClaudeInput } from '../server/adapters/claude.js';
import { buildCodexArgs } from '../server/adapters/codex.js';
import { findImagePaths, unescapeJson } from '../web/imagepaths.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
const tmp = () => mkdtempSync(join(tmpdir(), 'macii-img-'));

test('sniffImage: the type comes from the bytes, not from the name', () => {
  assert.equal(sniffImage(PNG), 'image/png');
  assert.equal(sniffImage(JPG), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('GIF89a....')), 'image/gif');
  assert.equal(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(sniffImage(Buffer.alloc(0)), null);
});

test('saveUploads: stores valid images under random names, refuses everything before writing anything', () => {
  const dir = join(tmp(), 'uploads');
  try {
    const saved = saveUploads(dir, [{ name: 'a.png', data: PNG.toString('base64') }, { name: 'b.jpg', data: JPG.toString('base64') }]);
    assert.deepEqual(saved.map(s => s.type), ['image/png', 'image/jpeg']);
    assert.ok(saved.every(s => UPLOAD_NAME.test(s.file) && existsSync(join(dir, s.file))));
    assert.equal(saved[0].name, 'a.png');

    const dir2 = join(tmp(), 'uploads');
    assert.throws(() => saveUploads(dir2, [{ data: PNG.toString('base64') }, { data: Buffer.from('not an image').toString('base64') }]), /image 2 is not a PNG/);
    assert.equal(existsSync(dir2), false, 'the valid first image must not be written when the second is refused');
    assert.throws(() => saveUploads(dir2, [{ name: 'x' }]), /no data/);
    assert.throws(() => saveUploads(dir2, 'nope'), /must be a list/);
    assert.throws(() => saveUploads(dir2, Array(5).fill({ data: PNG.toString('base64') })), /at most 4/);
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]);
    assert.throws(() => saveUploads(dir2, [{ data: big.toString('base64') }]), /larger than 5 MB/);
    assert.deepEqual(saveUploads(dir2, []), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resolveShownImage: image files only, relative paths from the agent folder', () => {
  const cwd = tmp();
  try {
    mkdirSync(join(cwd, 'shots'));
    writeFileSync(join(cwd, 'shots', 'a.PNG'), PNG);
    writeFileSync(join(cwd, 'notes.txt'), 'secret');
    assert.equal(resolveShownImage('shots/a.PNG', cwd).type, 'image/png');
    assert.equal(resolveShownImage(join(cwd, 'shots', 'a.PNG'), '/elsewhere').type, 'image/png'); // absolute ignores the folder
    assert.throws(() => resolveShownImage('notes.txt', cwd), /not an image file/);
    assert.throws(() => resolveShownImage('icon.svg', cwd), /not an image file/);
    assert.throws(() => resolveShownImage('missing.png', cwd), e => e.code === 'ENOENT');
    mkdirSync(join(cwd, 'dir.png'));
    assert.throws(() => resolveShownImage('dir.png', cwd), /not a file/);
    assert.throws(() => resolveShownImage('', cwd), /bad path/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('findImagePaths: absolute, relative and quoted paths; no web addresses, no duplicates', () => {
  assert.deepEqual(findImagePaths('Screenshot: C:\\Users\\Matcha\\Temp\\shot.png fertig.'), ['C:\\Users\\Matcha\\Temp\\shot.png']);
  assert.deepEqual(findImagePaths('saved to D:/work/out/page-1.jpeg.'), ['D:/work/out/page-1.jpeg']);
  assert.deepEqual(findImagePaths('see ![login](./shots/login.png) and `shots\\home.webp`'), ['./shots/login.png', 'shots\\home.webp']);
  assert.deepEqual(findImagePaths('"C:\\My Files\\the shot.png" is there'), ['C:\\My Files\\the shot.png']); // spaces only when quoted
  assert.deepEqual(findImagePaths('/tmp/a.png and /tmp/a.png again'), ['/tmp/a.png']);
  assert.deepEqual(findImagePaths('from https://example.com/logo.png and file.txt and app.pngx'), []);
  assert.deepEqual(findImagePaths('the extension .png is used'), []);
});

test('findImagePaths absoluteOnly: a command that names a relative file does not present it', () => {
  assert.deepEqual(findImagePaths('git add logo.png web/logo.png', { absoluteOnly: true }), []);
  assert.deepEqual(findImagePaths('npx shot --out C:\\tmp\\s.png', { absoluteOnly: true }), ['C:\\tmp\\s.png']);
});

test('unescapeJson: paths in a (truncated) JSON tool input come out as typed', () => {
  const input = JSON.stringify({ command: 'shot --out C:\\tmp\\new\\s.png\nnext "C:\\x y\\b.png"' });
  assert.deepEqual(findImagePaths(unescapeJson(input), { absoluteOnly: true }), ['C:\\tmp\\new\\s.png', 'C:\\x y\\b.png']);
});

test('buildClaudeInput: images in front of the text, one JSON line', () => {
  const line = buildClaudeInput('hi', [{ type: 'image/png', data: 'AAAA' }]);
  assert.ok(line.endsWith('\n') && line.indexOf('\n') === line.length - 1);
  const m = JSON.parse(line);
  assert.equal(m.type, 'user');
  assert.deepEqual(m.message.content, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'text', text: 'hi' }]);
});

test('claude args: --input-format stream-json only when images are sent, before the variadic flag', () => {
  const agent = { allowed_tools: [], model: null };
  assert.ok(!buildClaudeArgs({ agent, allowedTools: [] }).includes('--input-format'));
  const args = buildClaudeArgs({ agent, allowedTools: [], streamInput: true });
  assert.equal(args[args.indexOf('--input-format') + 1], 'stream-json');
  assert.ok(args.indexOf('--input-format') < args.indexOf('--allowedTools'));
});

test('codex args: one --image per file, ahead of the prompt marker', () => {
  const agent = { mode: 'manual' };
  const args = buildCodexArgs({ agent, resumeSessionId: 'T1', images: ['C:\\u\\a.png', 'C:\\u\\b.jpg'] });
  assert.deepEqual(args.filter((a, i) => args[i - 1] === '--image'), ['C:\\u\\a.png', 'C:\\u\\b.jpg']);
  assert.equal(args.at(-1), '-');
  assert.ok(!buildCodexArgs({ agent }).includes('--image'));
});
