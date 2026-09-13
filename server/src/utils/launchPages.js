// Which Facebook page a statics or brief-pipeline launch runs from: the copy set's page, and only that
// (Ludo 2026-09-14: the page lives in the copy set, never in the template). No copy set or no page is refused.

export function pagesForLaunch(copySet) {
  if (!copySet) throw new Error('Choose a copy set with a Facebook page. The page is set on the copy set, not the template.');
  const pageId = copySet.page_id == null ? '' : String(copySet.page_id).trim();
  const name = copySet.angle ? `"${copySet.angle}"` : 'This copy set';
  if (!pageId) throw new Error(`Copy set ${name} has no Facebook page. Set one in Ad Copy Sets before launching.`);
  if (!/^\d{5,25}$/.test(pageId)) throw new Error(`Copy set ${name} has an invalid Facebook page id ${JSON.stringify(pageId)}`);
  return [{ id: pageId, name: copySet.page_name || pageId }];
}
