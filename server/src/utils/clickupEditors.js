/**
 * Dynamic editor discovery from ClickUp.
 *
 * Fetches the member list of the Video Ads Pipeline list in ClickUp.
 * When editors are added/removed from that list, the app picks it up
 * automatically (within the cache TTL — 5 minutes).
 *
 * Exports:
 *   getEditors()       → { Name: numericId, ... }   (excludes Ludovico)
 *   getEditorNames()   → ['Name', ...]              (excludes Ludovico)
 *   OWNER_ID           → 266421907                  (Ludovico's ClickUp ID)
 *   invalidateCache()  → force next call to re-fetch
 */

const CLICKUP_TOKEN = process.env.CLICKUP_API_TOKEN || '';
const CLICKUP_API = 'https://api.clickup.com/api/v2';
const VIDEO_ADS_LIST_ID = '901518716584';
const OWNER_ID = 266421907; // Ludovico — always excluded from editor list

const EXCLUDED_EDITORS = new Set(['Jesame', 'Roman', 'Ultino', 'Abdullah', 'Aleksandra']);

// Cache
let editorsCache = { editors: null, timestamp: 0 };
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch editors from ClickUp list members.
 * Returns a Map-like object { DisplayName: numericId }.
 * Excludes Ludovico (the owner/strategist).
 */
export async function getEditors() {
  // Return cached if fresh
  if (editorsCache.editors && (Date.now() - editorsCache.timestamp < CACHE_TTL)) {
    return editorsCache.editors;
  }

  if (!CLICKUP_TOKEN) {
    console.warn('[ClickUp Editors] CLICKUP_API_TOKEN not set — returning empty editors');
    return {};
  }

  try {
    const res = await fetch(`${CLICKUP_API}/list/${VIDEO_ADS_LIST_ID}/member`, {
      headers: { Authorization: CLICKUP_TOKEN, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[ClickUp Editors] API error ${res.status}: ${text.slice(0, 200)}`);
      // Return stale cache if available, otherwise empty
      return editorsCache.editors || {};
    }

    const data = await res.json();
    const members = data.members || [];
    const editors = {};

    for (const member of members) {
      const id = member.id || member.user?.id;
      const username = member.username || member.user?.username || '';

      // Skip owner and excluded editors
      if (id === OWNER_ID) continue;

      // Derive short display name (matches ad naming convention: first names)
      // "DIMARANAN, NEIL JOHN B" → "Dimaranan" (comma = LAST, FIRST format)
      // "Fazlul Joarder" → "Fazlul" (space = FIRST LAST format)
      // "Uly Castres" → "Uly"
      let displayName;
      if (username.includes(',')) {
        // Last-name-first format: take the part before comma
        displayName = username.split(',')[0].trim();
      } else {
        // First-name-first format: take the first word
        displayName = username.split(/\s+/)[0].trim();
      }
      // Capitalize properly
      displayName = displayName.charAt(0).toUpperCase() + displayName.slice(1).toLowerCase();

      if (displayName && id && !EXCLUDED_EDITORS.has(displayName)) {
        editors[displayName] = id;
      }
    }

    console.log(`[ClickUp Editors] Fetched ${Object.keys(editors).length} editors: ${Object.keys(editors).join(', ')}`);
    editorsCache = { editors, timestamp: Date.now() };
    return editors;
  } catch (err) {
    console.error('[ClickUp Editors] Fetch error:', err.message);
    // Return stale cache if available
    return editorsCache.editors || {};
  }
}

/**
 * Get just the editor names (for dropdowns).
 */
export async function getEditorNames() {
  const editors = await getEditors();
  return Object.keys(editors);
}

/**
 * Force cache invalidation (e.g. after creating a brief).
 */
export function invalidateEditorCache() {
  editorsCache = { editors: null, timestamp: 0 };
}

export { OWNER_ID };
