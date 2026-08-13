/**
 * Autopilot Mode — unattended brief generation for the Brief Pipeline.
 *
 * Picks the best unbriefed competitor ads from the League, generates briefs from
 * them, and leaves them in the Kanban for the operator to review. It NEVER
 * pushes to ClickUp: the operator reviews and approves, so nothing reaches an
 * editor unseen. That is a deliberate scope decision, not a missing feature.
 *
 * WHY THE SELECTION MATTERS MORE THAN THE GENERATION
 * The point of this is not volume — it is choosing well. Generation is the
 * expensive step (an Opus call per brief), so candidates are triaged FIRST on
 * signals that cost nothing, and only the survivors are generated.
 *
 * THE DIVERSITY CAP IS THE LOAD-BEARING PART
 * Measured across the existing corpus, briefs converge hard: a mean of 6.9 of
 * the same 9 proof devices per script, and the selected angle barely changes the
 * output. Automating that without a cap would produce a nightly batch of near
 * identical briefs, and since the operator reviews every one, the cost lands on
 * their attention. So the batch refuses to generate a second brief from the same
 * source ad, and (once available) from the same proof signature.
 */

import { pgQuery } from '../db/pg.js';
import sendSlackAlert from '../utils/slackAlert.js';

export const AUTOPILOT_SETTINGS_KEY = 'brief_pipeline_autopilot';

export const DEFAULT_CONFIG = {
  enabled: false,
  // Madrid wall-clock hour the run starts. Stored as an hour + the IANA zone so
  // it survives DST rather than drifting an hour twice a year.
  startHour: 21,
  timezone: 'Europe/Madrid',
  briefsPerRun: 5,          // the operator sets this; not derived from capacity
  brands: [],               // domains; empty = every followed brand
  tiers: ['BANGER', 'CHAMP', 'A'],
  maxAgeDays: null,         // null = no recency limit
  maxPerSourceAd: 1,        // diversity: never two briefs off one ad in a run
  maxPerBrand: 2,           // diversity: spread across brands
  productId: 37,            // Puure
  productCode: 'PUURE',
  // The queue worker TRANSCRIBES as part of the job, so requiring a transcript
  // at selection time was wrong: only ~21 of 511 League ads carry one, so it
  // excluded ~96% of the pool and a run considered 3 candidates. Select on
  // having a usable VIDEO instead, and let the worker do the transcription.
  requireVideo: true,
  minTranscriptChars: 400,   // applies only when a transcript already exists
  slackChannel: null,       // null = the default ops webhook
  dryRun: false,
};

export async function getAutopilotConfig() {
  const rows = await pgQuery(
    `SELECT value FROM system_settings WHERE key = $1`, [AUTOPILOT_SETTINGS_KEY]
  );
  if (!rows.length) return { ...DEFAULT_CONFIG };
  const v = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
  return { ...DEFAULT_CONFIG, ...(v || {}) };
}

export async function saveAutopilotConfig(patch) {
  const merged = { ...(await getAutopilotConfig()), ...(patch || {}) };
  await pgQuery(
    `INSERT INTO system_settings (key, value, description)
     VALUES ($1, $2::jsonb, 'Autopilot Mode settings for the Brief Pipeline')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [AUTOPILOT_SETTINGS_KEY, JSON.stringify(merged)]
  );
  return merged;
}

/**
 * Candidate selection. Everything here is a cheap SQL-side decision — no model
 * calls — so a run can consider hundreds of ads and only pay for the few it
 * actually generates.
 *
 * Excludes, in order of how much they would waste:
 *  - ads already imported as a reference (the operator must never re-brief work
 *    already done; this is the label restored to Puure on 2026-08-13)
 *  - ads with no usable transcript (a bad reference guarantees a bad brief, and
 *    autopilot cannot see that it happened)
 *  - ads outside the configured brands / tiers / recency window
 */
export async function selectCandidates(cfg) {
  const tiers = (cfg.tiers && cfg.tiers.length ? cfg.tiers : DEFAULT_CONFIG.tiers)
    .filter(t => ['BANGER', 'CHAMP', 'A', 'B', 'C'].includes(String(t).toUpperCase()));
  if (!tiers.length) return [];

  const params = [tiers];
  let brandClause = '';
  if (Array.isArray(cfg.brands) && cfg.brands.length) {
    params.push(cfg.brands);
    brandClause = `AND b.domain = ANY($${params.length}::text[])`;
  }
  let ageClause = '';
  if (cfg.maxAgeDays) {
    params.push(Number(cfg.maxAgeDays));
    ageClause = `AND a.start_date IS NOT NULL AND a.start_date >= NOW() - ($${params.length} * INTERVAL '1 day')`;
  }
  params.push(Number(cfg.minTranscriptChars) || 0);
  const minChars = `$${params.length}`;

  return pgQuery(`
    SELECT
      a.id, a.ad_archive_id, a.brand_id, a.tier, a.tier_score, a.headline,
      a.body_text, a.transcript, a.start_date, a.active_days,
      b.domain AS brand_domain,
      a.raw_snapshot->'videos'->0->>'video_hd_url' AS video_hd_url,
      a.raw_snapshot->'videos'->0->>'video_sd_url' AS video_sd_url
    FROM brand_spy.ads a
    JOIN brand_spy.brands b ON b.id = a.brand_id
    WHERE a.is_active = TRUE
      AND a.tier = ANY($1::text[])
      ${brandClause}
      ${ageClause}
      AND (
        a.raw_snapshot->'videos'->0->>'video_hd_url' IS NOT NULL
        OR a.raw_snapshot->'videos'->0->>'video_sd_url' IS NOT NULL
      )
      -- when a transcript already exists it must be substantial; a stub
      -- transcript is worse than none because the worker will not redo it
      AND (a.transcript IS NULL OR length(a.transcript) >= ${minChars})
      AND NOT EXISTS (
        SELECT 1 FROM brief_pipeline_references r
         WHERE r.ad_archive_id = a.ad_archive_id::text
      )
    ORDER BY a.tier_score DESC NULLS LAST, a.start_date DESC NULLS LAST
    LIMIT 200
  `, params);
}

/**
 * Apply the diversity cap to an ordered candidate list.
 *
 * Returns { picked, skipped } — skipped carries a REASON per ad, because the
 * Slack report is only useful if it says what was declined and why. A report
 * that says "5 briefs generated" tells the operator nothing about whether the
 * thing is thinking.
 */
export function applyDiversityCap(candidates, cfg) {
  const picked = [];
  const skipped = [];
  const perBrand = new Map();
  const seenAds = new Set();
  const maxPerBrand = Number(cfg.maxPerBrand) || Infinity;
  const target = Number(cfg.briefsPerRun) || DEFAULT_CONFIG.briefsPerRun;

  for (const c of candidates) {
    if (picked.length >= target) {
      skipped.push({ ad: c.id, brand: c.brand_domain, headline: c.headline, reason: 'batch full' });
      continue;
    }
    if (seenAds.has(c.ad_archive_id)) {
      skipped.push({ ad: c.id, brand: c.brand_domain, headline: c.headline, reason: 'duplicate of another ad in this batch' });
      continue;
    }
    const n = perBrand.get(c.brand_domain) || 0;
    if (n >= maxPerBrand) {
      skipped.push({ ad: c.id, brand: c.brand_domain, headline: c.headline, reason: `brand cap reached (${maxPerBrand} per run)` });
      continue;
    }
    seenAds.add(c.ad_archive_id);
    perBrand.set(c.brand_domain, n + 1);
    picked.push(c);
  }
  return { picked, skipped };
}

/** Human-readable run report, for Slack and for the API response. */
export function formatReport({ picked, skipped, generated, failures, dryRun, startedAt }) {
  const secs = ((Date.now() - startedAt) / 1000).toFixed(0);
  const lines = [];
  lines.push(`*Autopilot Mode*${dryRun ? ' _(dry run — nothing generated)_' : ''} — ${secs}s`);
  lines.push(`Selected *${picked.length}*, generated *${generated.length}*, failed *${failures.length}*, skipped *${skipped.length}*`);
  if (generated.length) {
    lines.push('\n*Generated*');
    for (const g of generated) {
      const flags = g.flags?.length ? `  _${g.flags.join(', ')}_` : '';
      lines.push(`• ${g.naming || g.briefId} — score ${g.score ?? 'n/a'}${flags}`);
    }
  }
  if (failures.length) {
    lines.push('\n*Failed*');
    for (const f of failures) lines.push(`• ${f.brand} "${String(f.headline || '').slice(0, 40)}" — ${f.error}`);
  }
  if (skipped.length) {
    const byReason = skipped.reduce((m, s) => { m[s.reason] = (m[s.reason] || 0) + 1; return m; }, {});
    lines.push('\n*Skipped* — ' + Object.entries(byReason).map(([r, n]) => `${n} ${r}`).join(', '));
  }
  lines.push('\nBriefs are waiting in the Kanban for review. Nothing was pushed to ClickUp.');
  return lines.join('\n');
}

export async function reportToSlack(text) {
  try {
    await sendSlackAlert(text);
    return true;
  } catch (e) {
    console.error('[autopilot] Slack report failed:', e.message);
    return false;
  }
}
