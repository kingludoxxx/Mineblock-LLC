// ─────────────────────────────────────────────────────────────────────────────
// zipReader — minimal, dependency-free ZIP extraction for Composer imports.
//
// WHY NOT A LIBRARY: package.json carries no zip dependency, and it is a SHARED
// file that other lanes are actively committing to. The Composer import only
// needs to read a plain archive produced by Finder / `zip` / Python's zipfile,
// so the two compression methods those emit (stored + deflate) are enough, and
// Node's zlib already does the hard part.
//
// SUPPORTED:  method 0 (stored), method 8 (deflate), ZIP64 central directory.
// REFUSED:    encrypted entries, and anything else — loudly, per entry, never
//             silently skipped. An import that drops files must say which.
//
// Structure is read from the END of the file (End Of Central Directory record),
// which is the only correct way to enumerate a zip — scanning forward for local
// headers misreads any archive whose entries were updated or deleted.
// ─────────────────────────────────────────────────────────────────────────────

import { inflateRawSync } from 'node:zlib';

const EOCD_SIG    = 0x06054b50; // End of central directory
const EOCD64_SIG  = 0x06064b50; // ZIP64 end of central directory
const CDH_SIG     = 0x02014b50; // Central directory file header
const MAX_COMMENT = 0xffff;

class ZipError extends Error {}

/**
 * Locate the End Of Central Directory record by scanning backwards.
 * The record is 22 bytes plus an optional trailing comment of up to 64KB.
 */
function findEocd(buf) {
  const minPos = Math.max(0, buf.length - (22 + MAX_COMMENT));
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new ZipError('Not a ZIP file (no end-of-central-directory record found)');
}

/**
 * Read the central directory, honouring ZIP64 when the 32-bit fields are
 * saturated (0xffff / 0xffffffff), which is what any archive with >65535
 * entries or >4GB offsets looks like.
 */
function readCentralDirectory(buf) {
  const eocd = findEocd(buf);
  let entryCount = buf.readUInt16LE(eocd + 10);
  let cdSize     = buf.readUInt32LE(eocd + 12);
  let cdOffset   = buf.readUInt32LE(eocd + 16);

  if (entryCount === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    // ZIP64: the locator sits 20 bytes before the EOCD and points at the
    // ZIP64 EOCD, which carries the real 64-bit values.
    const locator = eocd - 20;
    if (locator >= 0 && buf.readUInt32LE(locator) === 0x07064b50) {
      const z64 = Number(buf.readBigUInt64LE(locator + 8));
      if (buf.readUInt32LE(z64) !== EOCD64_SIG) {
        throw new ZipError('ZIP64 locator points at a malformed ZIP64 EOCD record');
      }
      entryCount = Number(buf.readBigUInt64LE(z64 + 32));
      cdSize     = Number(buf.readBigUInt64LE(z64 + 40));
      cdOffset   = Number(buf.readBigUInt64LE(z64 + 48));
    }
  }
  if (cdOffset + cdSize > buf.length) {
    throw new ZipError('ZIP central directory extends past end of file (truncated upload?)');
  }
  return { entryCount, cdOffset, cdSize };
}

/**
 * Enumerate entries in a ZIP archive.
 *
 * @param {Buffer} buf                 the whole archive
 * @param {Object} [opts]
 * @param {number} [opts.maxEntryBytes] refuse a single entry larger than this
 *                                      (uncompressed) rather than inflating a
 *                                      zip bomb into memory
 * @returns {{entries: Array, errors: Array}} entries have {name, size, data}
 *          (directories are omitted); errors have {name, reason}
 */
export function readZipEntries(buf, { maxEntryBytes = 25 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(buf)) throw new ZipError('readZipEntries expects a Buffer');
  if (buf.length < 22) throw new ZipError('File is too small to be a ZIP archive');

  const { entryCount, cdOffset } = readCentralDirectory(buf);
  const entries = [];
  const errors  = [];
  let pos = cdOffset;

  for (let i = 0; i < entryCount; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== CDH_SIG) {
      errors.push({ name: `<entry ${i}>`, reason: 'malformed central directory header' });
      break;
    }
    const flags        = buf.readUInt16LE(pos + 8);
    const method       = buf.readUInt16LE(pos + 10);
    const compSize     = buf.readUInt32LE(pos + 20);
    const uncompSize   = buf.readUInt32LE(pos + 24);
    const nameLen      = buf.readUInt16LE(pos + 28);
    const extraLen     = buf.readUInt16LE(pos + 30);
    const commentLen   = buf.readUInt16LE(pos + 32);
    const localOffset  = buf.readUInt32LE(pos + 42);
    const name         = buf.slice(pos + 46, pos + 46 + nameLen).toString('utf8');
    pos += 46 + nameLen + extraLen + commentLen;

    // Directory entries carry no payload.
    if (name.endsWith('/')) continue;
    // Skip macOS resource forks / Finder metadata rather than reporting them as
    // errors — they are noise in every Finder-made zip, not operator mistakes.
    const base = name.split('/').pop() || '';
    if (name.startsWith('__MACOSX') || name.includes('/__MACOSX/') || base === '.DS_Store' || base.startsWith('._')) {
      continue;
    }
    if (flags & 0x1) { errors.push({ name, reason: 'entry is encrypted' }); continue; }
    if (method !== 0 && method !== 8) {
      errors.push({ name, reason: `unsupported compression method ${method} (only stored/deflate)` });
      continue;
    }
    if (uncompSize > maxEntryBytes) {
      errors.push({ name, reason: `entry is ${uncompSize} bytes, over the ${maxEntryBytes}-byte per-file limit` });
      continue;
    }

    // Local header: 30 bytes + name + extra. Its own name/extra lengths are the
    // authority here (they can differ from the central directory's extra field).
    if (localOffset + 30 > buf.length) {
      errors.push({ name, reason: 'local header offset is past end of file' });
      continue;
    }
    const lNameLen  = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const dataEnd   = dataStart + compSize;
    if (dataEnd > buf.length) {
      errors.push({ name, reason: 'entry data extends past end of file' });
      continue;
    }

    const raw = buf.slice(dataStart, dataEnd);
    try {
      const data = method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: maxEntryBytes });
      entries.push({ name, size: data.length, data });
    } catch (err) {
      errors.push({ name, reason: `inflate failed: ${err.message}` });
    }
  }

  return { entries, errors };
}

export { ZipError };
