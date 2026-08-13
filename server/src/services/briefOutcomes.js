/**
 * briefOutcomes — the tool's memory of the operator's judgement.
 *
 * Every approve / reject / push in the Kanban is a labeled example: this source
 * brand, this angle, this architecture → the operator said yes or no. This
 * module aggregates those labels into a track record that selection can READ,
 * which is the difference between a pipeline that generates and one that
 * learns.
 *
 * Design constraints, deliberate:
 *  - MINIMUM SAMPLE of 3 per group. One rejected brief must not blacklist a
 *    brand; small counts are reported as "provisional" and weighted as such by
 *    the consumer.
 *  - APPROVE = any status downstream of operator acceptance (approved, pushed,
 *    ready_to_launch, launched). REJECT = rejected. Everything else is pending
 *    and counts for neither side.
 *  - This is layer 1 of the loop (operator signal). Layer 2 — market results
 *    from launched ads — plugs into the same shape when a performance source
 *    is decided (Meta API vs. manual winner marking).
 */

import { pgQuery } from '../db/pg.js';

const APPROVED = ['approved', 'pushed', 'ready_to_launch', 'launched'];
const MIN_SAMPLE = 3;

/**
 * Aggregate the operator's decisions along the three axes selection can act
 * on: source brand, angle, and hook architecture. Cheap (one table scan over
 * generated briefs), so it is computed fresh per run rather than cached —
 * a track record that lags the operator's last hour of reviewing is worse
 * than none.
 */
export async function computeTrackRecord() {
  // brand_name lives on the REFERENCE, two joins away — the API responses that
  // show reference_brand_name are aliasing through this same chain.
  const rows = await pgQuery(`
    SELECT
      COALESCE(NULLIF(TRIM(r.brand_name), ''), '(unknown)')      AS brand,
      COALESCE(NULLIF(TRIM(g.angle), ''), '(none)')              AS angle,
      COALESCE(g.scores_json->>'architecture', '(unclassified)') AS architecture,
      g.status,
      COUNT(*)::int AS n
    FROM brief_pipeline_generated g
    LEFT JOIN brief_pipeline_winners w     ON w.id = g.winner_id
    LEFT JOIN brief_pipeline_references r  ON r.id = w.reference_id
    GROUP BY 1, 2, 3, 4
  `);

  const roll = (keyOf) => {
    const m = new Map();
    for (const r of rows) {
      const k = keyOf(r);
      if (!m.has(k)) m.set(k, { approved: 0, rejected: 0, pending: 0 });
      const g = m.get(k);
      if (APPROVED.includes(r.status)) g.approved += r.n;
      else if (r.status === 'rejected') g.rejected += r.n;
      else g.pending += r.n;
    }
    const out = [];
    for (const [k, g] of m) {
      const decided = g.approved + g.rejected;
      if (decided === 0) continue;
      out.push({
        key: k,
        approved: g.approved,
        rejected: g.rejected,
        pending: g.pending,
        approvalRate: Math.round((g.approved / decided) * 100),
        provisional: decided < MIN_SAMPLE,
      });
    }
    return out.sort((a, b) => (b.approved + b.rejected) - (a.approved + a.rejected));
  };

  return {
    brands: roll(r => r.brand),
    angles: roll(r => r.angle),
    architectures: roll(r => r.architecture),
    totalDecided: rows.filter(r => APPROVED.includes(r.status) || r.status === 'rejected')
                      .reduce((s, r) => s + r.n, 0),
  };
}

/**
 * The track record as a prompt block for the triage pass. Empty string when
 * there is nothing decided yet — an empty history must not manufacture
 * instructions. Provisional groups are labeled so the model treats them as
 * weak evidence, not law.
 */
export function trackRecordPromptBlock(tr) {
  if (!tr || tr.totalDecided === 0) return '';
  const fmt = (rows, label) => {
    const solid = rows.filter(r => !r.provisional);
    const prov = rows.filter(r => r.provisional);
    if (!solid.length && !prov.length) return '';
    let s = `${label}: `;
    if (solid.length) s += solid.map(r => `${r.key} ${r.approvalRate}% approved (${r.approved + r.rejected} reviewed)`).join('; ');
    if (prov.length) s += `${solid.length ? '; ' : ''}provisional (few samples): ` + prov.map(r => `${r.key} ${r.approved}✓/${r.rejected}✗`).join(', ');
    return s + '\n';
  };
  const body = fmt(tr.brands, 'By source brand') + fmt(tr.angles, 'By angle') + fmt(tr.architectures, 'By ad architecture');
  if (!body.trim()) return '';
  return `\nOPERATOR TRACK RECORD (what our reviewer has actually approved and rejected — weigh it, provisional entries lightly):\n${body}`;
}
