// Images in the chat: which uploads are accepted, and which files on disk may be shown.
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // the Claude API refuses larger images
export const MAX_SHOWN_BYTES = 25 * 1024 * 1024;

/** extensions the chat displays when an agent mentions such a file (no SVG: opened on its own it could run script) */
export const SHOWN_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };

const UPLOAD_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
export const UPLOAD_NAME = /^[0-9a-f]{16}\.(png|jpg|gif|webp)$/;
export const uploadType = file => SHOWN_TYPES[extname(file)];

/** the real type of an image by its first bytes, or null: the declared type of an upload is not trusted */
export function sniffImage(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** validates every upload ({name, data: base64}) before writing any; returns [{file, name, type}] with `file` inside `dir` */
export function saveUploads(dir, images) {
  if (!Array.isArray(images)) throw new Error('images must be a list');
  if (images.length > MAX_IMAGES) throw new Error(`at most ${MAX_IMAGES} images per message`);
  const decoded = images.map((img, i) => {
    if (typeof img?.data !== 'string') throw new Error(`image ${i + 1} has no data`);
    const buf = Buffer.from(img.data, 'base64');
    const type = sniffImage(buf);
    if (!type) throw new Error(`image ${i + 1} is not a PNG, JPEG, GIF or WebP`);
    if (buf.length > MAX_IMAGE_BYTES) throw new Error(`image ${i + 1} is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
    return { buf, type, name: typeof img.name === 'string' && img.name ? img.name.slice(0, 100) : 'image' };
  });
  if (decoded.length) mkdirSync(dir, { recursive: true });
  return decoded.map(({ buf, type, name }) => {
    const file = randomBytes(8).toString('hex') + UPLOAD_EXT[type];
    writeFileSync(join(dir, file), buf);
    return { file, name, type };
  });
}

/** an agent mentions `/c/Users/x.png` when it ran in Git Bash: the same file as C:/Users/x.png */
const fromGitBash = p => p.replace(/^\/([a-zA-Z])\/(?=.)/, '$1:/');

/** the image file a path in an agent's message points to; relative paths are relative to the agent's folder. Throws with .code ENOENT when it is not there. */
export function resolveShownImage(raw, cwd) {
  if (typeof raw !== 'string' || !raw || raw.length > 500 || raw.includes('\0')) throw new Error('bad path');
  const type = SHOWN_TYPES[extname(raw).toLowerCase()];
  if (!type) throw new Error('not an image file');
  const file = resolve(cwd, fromGitBash(raw));
  const st = statSync(file);
  if (!st.isFile()) throw new Error('not a file');
  if (st.size > MAX_SHOWN_BYTES) throw new Error('image is too large to show');
  return { file, type, size: st.size, mtimeMs: st.mtimeMs };
}
