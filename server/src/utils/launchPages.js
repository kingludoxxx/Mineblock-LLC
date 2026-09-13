// Which Facebook page(s) a launch runs from. The page belongs to the copy (a doctor's script runs from the doctor's
// page), so a copy set that names a page wins; otherwise the template's selected pages, rotated as before.

const safeArr = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { let p = JSON.parse(v); if (typeof p === 'string') p = JSON.parse(p); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
};

export function pagesForLaunch(template, copySet) {
  const pageId = copySet?.page_id == null ? '' : String(copySet.page_id).trim();
  if (pageId) {
    if (!/^\d{5,25}$/.test(pageId)) throw new Error(`copy set has an invalid Facebook page id ${JSON.stringify(pageId)}`);
    return [{ id: pageId, name: copySet.page_name || pageId }];
  }
  return safeArr(template?.page_ids).filter((p) => p.selected !== false);
}
