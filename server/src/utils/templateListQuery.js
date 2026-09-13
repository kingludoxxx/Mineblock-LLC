// The Statics template list query. It never reads the two heavy columns: a whole-row read (SELECT *, to_jsonb(t))
// pulls every stored image and every deep analysis out of storage just to drop them - 8.5 MB and 2.8 s of database
// time on a live store (2026-09-13), which under the page's request burst passed the query limit and answered 500.
// The list gets a flag for each instead; the image is served by /inline-images, the analysis by
// /statics-generation/templates/:id/analysis when a template is opened.

export const TEMPLATE_HEAVY_COLUMNS = ['image_url', 'deep_analysis'];

const IDENT = /^[a-z_][a-z0-9_]*$/;

/**
 * @param {string[]} columns  the table's columns, read from information_schema so new columns ship without edits
 * @param {{category?: string, search?: string, showHidden?: boolean}} filters
 * @returns {{text: string, params: any[]}} one row per template, as jsonb in column `r`
 */
export function templateListQuery(columns, { category, search, showHidden } = {}) {
  if (!Array.isArray(columns) || columns.length === 0) throw new Error('templateListQuery: no column list');
  for (const c of columns) {
    if (typeof c !== 'string' || !IDENT.test(c)) throw new Error(`templateListQuery: refused column name ${JSON.stringify(c)}`);
  }
  const light = columns.filter((c) => !TEMPLATE_HEAVY_COLUMNS.includes(c)).map((c) => `"${c}"`);
  const select = [
    ...light,
    `CASE WHEN left("image_url", 5) = 'data:' THEN NULL ELSE "image_url" END AS "image_url"`,
    `COALESCE(left("image_url", 5) = 'data:', false) AS "image_url__inline"`,
    // A new store's table has no deep_analysis column until the generation routes add it at boot.
    columns.includes('deep_analysis') ? `("deep_analysis" IS NOT NULL) AS "has_analysis"` : `false AS "has_analysis"`,
  ];

  const where = ['1=1'];
  const params = [];
  if (!showHidden) where.push(`"is_hidden" = false`);
  if (category) {
    params.push(category);
    where.push(`category = $${params.length}`);
  } else {
    // Uncategorized templates are unreviewed and clutter the picker; ?category=Uncategorized shows them.
    where.push(`(category IS NULL OR category != 'Uncategorized')`);
  }
  if (search) {
    params.push(`%${search}%`, `%${search}%`);
    where.push(`(name ILIKE $${params.length - 1} OR category ILIKE $${params.length})`);
  }

  const text = `SELECT to_jsonb(x) AS r FROM (
      SELECT ${select.join(', ')} FROM statics_templates WHERE ${where.join(' AND ')}
    ) x ORDER BY x.sort_order ASC, x.created_at DESC`;
  return { text, params };
}
