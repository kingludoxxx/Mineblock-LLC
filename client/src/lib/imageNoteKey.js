// Fingerprint of a stored product photo, used to key its AI rule in product_profiles.image_notes.
// MUST stay identical to imageNoteKey in server/src/utils/staticsPrompts.js (a test compares the two).
export function imageNoteKey(src) {
  if (typeof src !== 'string' || !src) return null;
  let h = 0x811c9dc5;
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16).padStart(8, '0')}-${src.length}`;
}
