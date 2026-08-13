// ─────────────────────────────────────────────────────────────────────────────
// unzip — browser-side ZIP reading for Composer imports. No dependencies.
//
// WHY IN THE BROWSER: a 50-static export runs ~80MB. express.json is capped at
// 50mb, this repo deliberately ships no multipart parser, and base64 adds ~33%
// on top — so a whole-archive upload cannot carry the operator's actual use
// case. Unzipping here means each image is posted on its own, which also gives
// real per-file progress and lets one bad file fail without losing the rest.
//
// Uses DecompressionStream('deflate-raw'), which is native in Chrome/Edge 80+,
// Safari 16.4+ and Firefox 113+. Callers should feature-detect via
// `isUnzipSupported()` and say so plainly rather than failing mid-import.
// ─────────────────────────────────────────────────────────────────────────────

const EOCD_SIG   = 0x06054b50;
const EOCD64_SIG = 0x06064b50;
const LOC64_SIG  = 0x07064b50;
const CDH_SIG    = 0x02014b50;

export function isUnzipSupported() {
  return typeof DecompressionStream === 'function';
}

export class UnzipError extends Error {}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function findEocd(view, len) {
  const min = Math.max(0, len - (22 + 0xffff));
  for (let i = len - 22; i >= min; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  throw new UnzipError('Not a ZIP file (no end-of-central-directory record)');
}

/**
 * Read every file entry from a ZIP archive.
 *
 * @param {ArrayBuffer} buffer
 * @returns {Promise<{entries: Array<{name:string, bytes:Uint8Array}>, errors: Array<{name:string, reason:string}>}>}
 */
export async function readZip(buffer) {
  const len = buffer.byteLength;
  if (len < 22) throw new UnzipError('File is too small to be a ZIP archive');
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);

  const eocd = findEocd(view, len);
  let count    = view.getUint16(eocd + 10, true);
  let cdOffset = view.getUint32(eocd + 16, true);

  // ZIP64 — 32-bit fields saturate on big archives, which a 50-static export
  // can absolutely hit.
  if (count === 0xffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && view.getUint32(loc, true) === LOC64_SIG) {
      const z64 = Number(view.getBigUint64(loc + 8, true));
      if (view.getUint32(z64, true) !== EOCD64_SIG) {
        throw new UnzipError('Malformed ZIP64 end-of-central-directory record');
      }
      count    = Number(view.getBigUint64(z64 + 32, true));
      cdOffset = Number(view.getBigUint64(z64 + 48, true));
    }
  }

  const entries = [];
  const errors = [];
  const decoder = new TextDecoder();
  let pos = cdOffset;

  for (let i = 0; i < count; i++) {
    if (pos + 46 > len || view.getUint32(pos, true) !== CDH_SIG) {
      errors.push({ name: `<entry ${i}>`, reason: 'malformed central directory header' });
      break;
    }
    const flags      = view.getUint16(pos + 8, true);
    const method     = view.getUint16(pos + 10, true);
    const compSize   = view.getUint32(pos + 20, true);
    const nameLen    = view.getUint16(pos + 28, true);
    const extraLen   = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localOff   = view.getUint32(pos + 42, true);
    const name       = decoder.decode(u8.subarray(pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;                      // directory
    const base = name.split('/').pop() || '';
    // Finder noise — skipped, not reported as an operator error.
    if (name.startsWith('__MACOSX') || name.includes('/__MACOSX/') || base === '.DS_Store' || base.startsWith('._')) continue;
    if (flags & 0x1) { errors.push({ name, reason: 'entry is encrypted' }); continue; }
    if (method !== 0 && method !== 8) {
      errors.push({ name, reason: `unsupported compression method ${method}` });
      continue;
    }

    const lNameLen  = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    if (start + compSize > len) { errors.push({ name, reason: 'entry data extends past end of file' }); continue; }
    const raw = u8.subarray(start, start + compSize);

    try {
      entries.push({ name, bytes: method === 0 ? raw : await inflateRaw(raw) });
    } catch (err) {
      errors.push({ name, reason: `inflate failed: ${err.message}` });
    }
  }

  return { entries, errors };
}

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

/** Strip directories and extension so images, prompts and manifest rows pair up. */
export function stemOf(path) {
  const base = (path.split('/').pop() || '');
  return base.replace(/\.[^.]+$/, '');
}

/**
 * Parse a manifest.csv into { stem → {prompt, angle} }.
 *
 * Deliberately minimal but quote-aware: prompt text routinely contains commas,
 * and splitting on ',' would silently truncate every such prompt.
 */
export function parseManifest(text) {
  const rows = [];
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length === 0) return {};

  const splitCsv = (line) => {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }  // escaped quote
          else quoted = false;
        } else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map(s => s.trim());
  };

  const header = splitCsv(lines[0]).map(h => h.toLowerCase());
  const iFile   = header.findIndex(h => ['filename', 'file', 'image', 'name'].includes(h));
  const iPrompt = header.findIndex(h => ['prompt', 'description', 'brief'].includes(h));
  const iAngle  = header.findIndex(h => ['angle', 'marketing_angle'].includes(h));
  if (iFile === -1) return {};   // no filename column ⇒ cannot pair anything

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsv(lines[i]);
    const file = cells[iFile];
    if (!file) continue;
    rows.push({
      stem:   stemOf(file),
      prompt: iPrompt >= 0 ? (cells[iPrompt] || '') : '',
      angle:  iAngle  >= 0 ? (cells[iAngle]  || '') : '',
    });
  }
  return Object.fromEntries(rows.map(r => [r.stem, { prompt: r.prompt, angle: r.angle }]));
}

/**
 * Turn raw zip entries into the import payload: images, each paired with its
 * prompt (from prompts/<name>.txt or manifest.csv) and optional angle.
 *
 * Precedence: manifest.csv wins over a prompts/ file, because a manifest is an
 * explicit index while a matching filename is an inference.
 */
export function pairEntries({ entries, errors = [] }) {
  const images  = entries.filter(e => IMAGE_EXT.test(e.name));
  const prompts = {};
  let manifest = {};
  const decoder = new TextDecoder();

  for (const e of entries) {
    const base = (e.name.split('/').pop() || '').toLowerCase();
    if (base === 'manifest.csv') {
      manifest = parseManifest(decoder.decode(e.bytes));
    } else if (/\.txt$/i.test(e.name)) {
      prompts[stemOf(e.name)] = decoder.decode(e.bytes).trim();
    }
  }

  const files = images.map((img) => {
    const stem = stemOf(img.name);
    const m = manifest[stem] || {};
    return {
      name: img.name,
      bytes: img.bytes,
      prompt: (m.prompt || prompts[stem] || '') || null,
      angle: (m.angle || '') || null,
    };
  });

  // A zip with no images at all is a real failure, not an empty success.
  const nonImageNames = entries.filter(e => !IMAGE_EXT.test(e.name)).map(e => e.name);
  return { files, errors, skippedNonImages: nonImageNames, manifestRows: Object.keys(manifest).length };
}

/** Base64-encode bytes in chunks — btoa(String.fromCharCode(...huge)) blows the stack. */
export function bytesToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
