// Facebook page picker of the copy-set editor: each copy set names the page its ads run from.
// Kept framework-free so it can be tested directly.

const toAct = (a) => {
  const id = String(a.id || a.account_id || '');
  return id.startsWith('act_') ? id : `act_${id}`;
};

/** Pages of every ad account this store can launch into, each page once. Any failing call rejects. */
export async function loadLaunchPages(get) {
  const { data } = await get('/ad-launcher/meta/accounts');
  const accounts = (data?.data || []).map(toAct).filter((id) => id !== 'act_');
  const seen = new Set();
  const pages = [];
  for (const acc of accounts) {
    const res = await get(`/brief-pipeline/meta/pages/${encodeURIComponent(acc)}`);
    for (const p of res.data?.data || []) {
      const id = String(p.id);
      if (seen.has(id)) continue;
      seen.add(id);
      pages.push({ id, name: p.name });
    }
  }
  return pages;
}

/** Options for the picker; a saved page that is not in the list stays visible so it is never silently dropped. */
export function pageOptions(pages, copySet) {
  const current = copySet?.page_id ? String(copySet.page_id) : '';
  if (!current || pages.some((p) => p.id === current)) return pages;
  return [...pages, { id: current, name: `${copySet.page_name || current} (not in the ad account)` }];
}

/** Fields sent on save: page_id is always present ('' clears the page), page_name follows the chosen page. */
export function pageFields(pages, pageId, copySet) {
  if (!pageId) return { page_id: '', page_name: '' };
  const page = pages.find((p) => p.id === pageId);
  if (page) return { page_id: pageId, page_name: page.name };
  return { page_id: pageId, page_name: String(copySet?.page_id) === pageId ? copySet.page_name || '' : '' };
}
