// Finds the image files an agent mentions in a message or a tool call, so the chat can show them.
const EXT = '(?:png|jpe?g|gif|webp|bmp)';
const QUOTED = new RegExp('(["\'`])([^"\'`\\r\\n]{1,300}?\\.' + EXT + ')\\1', 'gi');      // may contain spaces
const BARE = new RegExp('[^\\s"\'`<>|*?()\\[\\]]+\\.' + EXT + '(?![\\w-]|\\.\\w)', 'gi'); // a full stop after the extension ends the sentence
const ABSOLUTE = /^(?:[a-zA-Z]:[\\/]|\/)/;

/** a tool call arrives as truncated JSON, so it cannot be parsed: undo the escaping that matters for paths */
export function unescapeJson(s) {
  return s.replace(/\\\\/g, '\u0001').replace(/\\[nrt]/g, ' ').replace(/\\"/g, '"').replace(/\u0001/g, '\\');
}

/**
 * Paths of image files in `text`, in order, without duplicates. Web addresses are skipped.
 * absoluteOnly: for commands, where `git add logo.png` names a file but does not present it.
 */
export function findImagePaths(text, { absoluteOnly = false } = {}) {
  const hits = []; // [position, path]
  const quoted = [];
  for (const m of text.matchAll(QUOTED)) { quoted.push([m.index, m.index + m[0].length]); hits.push([m.index, m[2]]); }
  for (const m of text.matchAll(BARE)) {
    if (quoted.some(([a, b]) => m.index >= a && m.index < b)) continue; // part of a quoted path already taken whole
    hits.push([m.index, m[0]]);
  }
  const found = [];
  for (const p of hits.sort((a, b) => a[0] - b[0]).map(h => h[1].trim())) {
    if (!p || p.includes('://') || (absoluteOnly && !ABSOLUTE.test(p)) || found.includes(p)) continue;
    found.push(p);
  }
  return found;
}
