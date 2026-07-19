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
const editorsCache = new Map(); // listId → { editors, timestamp } (per-list: MB and Puure have different rosters)
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch editors from a ClickUp list's members.
 * @param {string} listId - the ClickUp list to read members from. Defaults to
 *   the MinerForge Video Ads list. Puure briefs must pass the Puure list id so
 *   editors on that pipeline (Harmain, Sajal, ...) are recognized too.
 * Returns a Map-like object { DisplayName: numericId }. Excludes Ludovico.
 */
export async function getEditors(listId = VIDEO_ADS_LIST_ID) {
  // Return cached if fresh (cache is keyed per-list)
  const cached = editorsCache.get(listId);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
    return cached.editors;
  }

  if (!CLICKUP_TOKEN) {
    console.warn('[ClickUp Editors] CLICKUP_API_TOKEN not set — returning empty editors');
    return {};
  }

  try {
    const res = await fetch(`${CLICKUP_API}/list/${listId}/member`, {
      headers: { Authorization: CLICKUP_TOKEN, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[ClickUp Editors] API error ${res.status}: ${text.slice(0, 200)}`);
      // Return stale cache if available, otherwise empty
      return cached?.editors || {};
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
    editorsCache.set(listId, { editors, timestamp: Date.now() });
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
export async function getEditorNames(listId = VIDEO_ADS_LIST_ID) {
  const editors = await getEditors(listId);
  return Object.keys(editors);
}

/**
 * Force cache invalidation (e.g. after creating a brief).
 */
export function invalidateEditorCache() {
  editorsCache.clear();
}

export { OWNER_ID };
