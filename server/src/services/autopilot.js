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
import { computeTrackRecord, trackRecordPromptBlock } from './briefOutcomes.js';
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
  // Non-English sources produce briefs the operator cannot use (the Spanish
  // "¡Cuerpo firme!" twin of an already-briefed English ad got through on
  // 2026-08-13). Scraping still collects them — they are competitive intel —
  // but selection refuses them. Toggleable if a non-English funnel ever exists.
  englishOnly: true,
  // Reference-fit triage: a cheap Haiku pass rates how well each candidate's
  // PSYCHOLOGY maps onto our product before we spend an Opus generation on it.
  // This is what turns selection from "filters + tier score" into judgement —
  // tier score measures how well an ad works for ITS product, not for ours
  // ("Today Only: Extra 20% Off" outranked story ads on tier alone).
  // Directed angle: when set, every queued job generates under this angle and
  // the triage rates fit FOR that angle specifically. This is what lets an
  // operator request ("5 briefs, The Surgeon's Secret") run through the full
  // selection brain instead of the triage-less manual queue — the gap that let
  // two thin offer ads into the 2026-08-14 batch.
  angle: null,
  fitTriage: true,
  minFit: 6,          // below this: skipped, with the model's reason attached
  triagePool: 30,     // top candidates triaged per run (one batched Haiku call)
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
 * Cheap language heuristic — no API call, deterministic, testable.
 *
 * Scores English vs Romance/Germanic stopwords and hard non-English characters
 * over headline + body text. Ads are short marketing copy, so stopwords are a
 * strong signal. Returns 'en', 'non-en', or 'unknown' when there is not enough
 * text to judge — and under englishOnly, UNKNOWN IS SKIPPED TOO: the empty-
 * headline path is precisely how unclassifiable ads sneak through a filter,
 * and a missed candidate is cheaper than a foreign-language brief.
 */
export function detectEnglish(text) {
  const t = ' ' + String(text || '').toLowerCase().replace(/\s+/g, ' ') + ' ';
  if (t.trim().length < 12) return 'unknown';
  // hard markers: inverted punctuation and n-tilde are effectively conclusive
  if (/[¡¿ñ]/.test(t)) return 'non-en';
  const count = words => words.reduce((n, w) => n + (t.split(` ${w} `).length - 1), 0);
  const en = count(['the','your','you','and','for','with','this','that','are','not','was','have','from','get','now']);
  const xx = count([
    'el','la','los','las','que','para','por','con','una','este','esta','tu','más','pero','como','desde','casa','sin','tus','hasta', // es
    'le','les','des','est','pour','avec','vous','votre','dans','pas',                             // fr
    'der','die','das','und','für','mit','nicht','sie','ist',                                      // de
    'il','di','che','per','con','del','della','questo','non',                                     // it
    'o','os','uma','você','com','não','para','mais',                                              // pt
  ]);
  // accented latin chars add weight — common in es/fr/pt/it, rare in English ads
  const accents = (t.match(/[àáâãäèéêëìíîïòóôõöùúûüç]/g) || []).length;
  const score = xx * 2 + accents - en;
  if (en === 0 && xx === 0 && accents === 0) return 'unknown';
  return score > 0 ? 'non-en' : 'en';
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
      -- CONTENT-LEVEL dedup, not just ad-id. Brands run the same creative under
      -- many ad ids: "Firm Body or Money Back!" had been briefed SEVEN times via
      -- seven different archive ids before this guard existed. Ad-id dedup is
      -- necessary but blind to that. Headline is the cheap, good-enough proxy
      -- for "same creative family" — it can rarely exclude a genuinely new
      -- video that reuses an old headline, and that trade is deliberate: a
      -- missed candidate costs nothing, a duplicate brief costs review time and
      -- an editor's day.
      AND NOT EXISTS (
        SELECT 1 FROM brief_pipeline_references r2
         WHERE r2.headline IS NOT NULL AND a.headline IS NOT NULL
           AND LOWER(TRIM(r2.headline)) = LOWER(TRIM(a.headline))
      )
    ORDER BY a.tier_score DESC NULLS LAST, a.start_date DESC NULLS LAST
    LIMIT 200
  `, params);
}

/**
 * Rate candidates for CLONABILITY onto our product. One batched Haiku call for
 * the whole pool — pennies — returning per-candidate {fit 0-10, angle, why}.
 *
 * Resilient by design: any failure (no key, malformed JSON, API down) returns
 * null and the caller falls back to tier ordering. Triage must never be the
 * reason a nightly run produced nothing.
 */
export async function triageFit(candidates, cfg) {
  // CHUNKED: one batched call silently overflowed max_tokens at pool=100,
  // parseTriage returned null, and the run fell back to tier ordering with
  // nothing saying so. Chunks of 25 keep every call inside its budget, and a
  // failed chunk degrades only ITS 25 candidates.
  const CHUNK = 25;
  if (!process.env.ANTHROPIC_API_KEY || !candidates.length) return null;
  const merged = new Map();
  let chunksOk = 0;
  const chunksTotal = Math.ceil(candidates.length / CHUNK);
  for (let off = 0; off < candidates.length; off += CHUNK) {
    const part = candidates.slice(off, off + CHUNK);
    const fits = await triageFitChunk(part, cfg);
    if (fits) { chunksOk++; for (const [i, r] of fits) merged.set(off + i, r); }
  }
  if (!merged.size) return null;
  return { fits: merged, chunksOk, chunksTotal };
}

async function triageFitChunk(candidates, cfg) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !candidates.length) return null;

  let productLine = 'Puure: an at-home red light device for lifting and firming the female chest, women 40+.';
  let angleNames = [];
  try {
    const rows = await pgQuery(`SELECT oneliner, angles FROM product_profiles WHERE id = $1 LIMIT 1`, [cfg.productId]);
    if (rows.length) {
      if (rows[0].oneliner) productLine = rows[0].oneliner;
      let a = rows[0].angles; if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = []; } }
      if (Array.isArray(a)) angleNames = a.map(x => x.name).filter(Boolean);
    }
  } catch { /* profile unavailable — generic product line is fine for triage */ }

  // The tool's memory: what the operator has actually approved and rejected.
  // Injected into the triage prompt so selection learns from every review the
  // operator makes, with no extra work on their part. Failure to compute it
  // must never block a run — an empty history is a valid history.
  let track = '';
  try { track = trackRecordPromptBlock(await computeTrackRecord()); }
  catch (e) { console.warn('[autopilot] track record unavailable:', e.message); }

  const list = candidates.map((c, i) =>
    `${i}. [${c.brand_domain} | ${c.tier} | substance: ${(String(c.transcript || '').length || String(c.body_text || '').length)} chars] headline: ${String(c.headline || '(none)').slice(0, 90)}\n   copy: ${String(c.body_text || '').replace(/\s+/g, ' ').slice(0, 260)}${c.transcript ? `\n   transcript: ${String(c.transcript).replace(/\s+/g, ' ').slice(0, 340)}` : ''}`
  ).join('\n');

  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1800,
    system: 'You are a senior direct response strategist choosing which competitor ads are worth cloning for a specific product. You judge transferability of the PSYCHOLOGY, not the quality of the ad for its own product. Return only JSON.',
    messages: [{ role: 'user', content:
`OUR PRODUCT: ${productLine}
OUR ANGLES: ${angleNames.join(' | ') || '(none defined)'}${cfg.angle ? `\nOPERATOR-DIRECTED ANGLE: every brief will be generated under "${cfg.angle}" — rate FIT FOR THAT ANGLE. For a narrative or authority angle, a bare offer card cannot carry it. For a PROMO or OFFER angle the reverse holds: a well-built offer ad IS the right raw material — judge its offer CRAFT (urgency devices, price anchoring, gift stacking, a reason-why for the deal) and ignore the generic substance rule below.` : ''}\n${track}

For each candidate ad below, rate FIT 0-10: how well would this ad's structure and psychology clone onto OUR product?
High fit: same audience (women 40+), an emotional or bodily problem analogous to sagging/firmness, a narrative or authority structure that survives a product swap.
Low fit: bare discount/offer ads with no transferable structure, unrelated audiences or problems (pest control, supplements for stamina), pure brand spots.
HARD RULE ON SUBSTANCE: an ad under ~600 chars whose copy is only an offer or a discount CANNOT score above 5, whatever its tier — UNLESS the operator-directed angle is itself a promo/offer angle, in which case judge offer craft instead: for a promo clone, the source's craft IS the substance.

CANDIDATES:
${list}

Return ONLY a JSON array: [{"i":0,"fit":8,"angle":"which of our angles it serves, or null","why":"one short clause"}]` }],
  };

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) { console.warn('[autopilot] triage call failed HTTP', res.status); return null; }
    const j = await res.json();
    return parseTriage(j.content?.[0]?.text || '', candidates.length);
  } catch (e) {
    console.warn('[autopilot] triage failed:', e.message);
    return null;
  }
}

/** Pure and separately testable: model text -> validated array or null. */
export function parseTriage(text, poolSize) {
  try {
    const arr = JSON.parse(String(text).replace(/^```json\s*|\s*```$/g, '').trim());
    if (!Array.isArray(arr)) return null;
    const out = new Map();
    for (const r of arr) {
      const i = Number(r?.i);
      if (!Number.isInteger(i) || i < 0 || i >= poolSize) continue;
      const fit = Number(r?.fit);
      if (!Number.isFinite(fit)) continue;
      out.set(i, { fit: Math.max(0, Math.min(10, fit)), angle: r.angle || null, why: String(r.why || '').slice(0, 140) });
    }
    return out.size ? out : null;
  } catch { return null; }
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
  const seenHeadlines = new Set();
  const perAngle = new Map();
  const maxPerBrand = Number(cfg.maxPerBrand) || Infinity;
  const target = Number(cfg.briefsPerRun) || DEFAULT_CONFIG.briefsPerRun;

  for (const c of candidates) {
    if (typeof c.fit === 'number' && c.fit < (Number(cfg.minFit) || 0)) {
      skipped.push({ ad: c.id, brand: c.brand_domain, headline: c.headline, reason: `low fit ${c.fit}/10 — ${c.fitWhy || 'psychology does not transfer'}` });
      continue;
    }
    if (cfg.englishOnly !== false) {
      const verdict = detectEnglish(`${c.headline || ''} ${c.body_text || ''}`);
      if (verdict !== 'en') {
        skipped.push({ ad: c.id, brand: c.brand_domain, headline: c.headline, reason: verdict === 'non-en' ? 'non-English source' : 'language undeterminable (englishOnly)' });
        continue;
      }
    }
    if (picked.length >= target) {
      skipped.push({ ad: c.id, brand: c.brand_domain, headline: c.headline, reason: 'batch full' });
      continue;
    }
    if (seenAds.has(c.ad_archive_id)) {
      skipped.push({ ad: c.id, brand: c.brand_domain, headline: c.headline, reason: 'duplicate of another ad in this batch' });
      continue;
    }
    // Same rule within the batch: one run queued two "Use This On Wrinkles…"
    // ads side by side — different ad ids, same creative. One per family.
    // Portfolio: a batch is a spread, not five of one argument — cap two
    // picks per triage-assigned angle.
    if (c.fitAngle) {
      const nA = perAngle.get(c.fitAngle) || 0;
      if (nA >= 2) {
        skipped.push({ ad: c.id, brand: c.brand_domain, headline: c.headline, reason: 'portfolio: angle "' + c.fitAngle + '" already covered twice' });
        continue;
      }
      perAngle.set(c.fitAngle, nA + 1);
    }
    const headKey = String(c.headline || '').trim().toLowerCase();
    if (headKey && seenHeadlines.has(headKey)) {
      skipped.push({ ad: c.id, brand: c.brand_domain, headline: c.headline, reason: 'same headline as another ad in this batch' });
      continue;
    }
    if (headKey) seenHeadlines.add(headKey);
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
export function formatReport({ picked, skipped, generated, failures, dryRun, startedAt, triaged }) {
  const secs = ((Date.now() - startedAt) / 1000).toFixed(0);
  const lines = [];
  lines.push(`*Autopilot Mode*${dryRun ? ' _(dry run — nothing generated)_' : ''} — ${secs}s`);
  lines.push(`Selected *${picked.length}*, generated *${generated.length}*, failed *${failures.length}*, skipped *${skipped.length}*`);
  if (triaged) lines.push(`_Ranked by reference-fit (${triaged})._`);
  else lines.push('⚠ _Fit triage UNAVAILABLE — this batch was TIER-SORTED. Selection quality degraded._');
  const withFit = picked.filter(p => typeof p.fit === 'number');
  if (withFit.length) lines.push('*Picked* ' + withFit.map(p => `${p.brand_domain} ${p.fit}/10`).join(' · '));
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


/**
 * Run one batch. Shared by the route and the scheduler so a scheduled run and a
 * manual "Run now" are the same code path — a difference between them would be
 * the kind of bug you only find at 21:00 with nobody watching.
 *
 * Enqueues into brief_generation_jobs; the existing worker does
 * import -> transcribe -> generate. Never pushes to ClickUp.
 */
export async function runAutopilotBatch({ dryRun = true, overrides = {} } = {}) {
  const startedAt = Date.now();
  const cfg = { ...(await getAutopilotConfig()), ...overrides };

  let candidates = await selectCandidates(cfg);
  const considered = candidates.length;
  let triaged = null;   // 'n/m chunks' when ranked; null = tier fallback
  if (cfg.fitTriage !== false && candidates.length) {
    const pool = candidates.slice(0, Number(cfg.triagePool) || 30);
    const t = await triageFit(pool, cfg);
    if (t) {
      triaged = t.chunksOk + '/' + t.chunksTotal + ' chunks';
      for (const [i, r] of t.fits) Object.assign(pool[i], { fit: r.fit, fitAngle: r.angle, fitWhy: r.why });
      // judged order: fit first, tier as the tiebreak; unrated sink to the back
      candidates = pool.slice().sort((a, b) => (b.fit ?? -1) - (a.fit ?? -1) || (b.tier_score ?? 0) - (a.tier_score ?? 0));
    }
    // fits === null -> tier ordering stands; the run must never die on triage
  }
  // A directed angle supplies the argument, so the bar for the source's
  // structure rises: minFit at least 7 on directed runs.
  if (cfg.angle) cfg.minFit = Math.max(Number(cfg.minFit) || 6, 7);   // cfg is const — mutate the property, don't reassign
  const { picked, skipped } = applyDiversityCap(candidates, cfg);
  const generated = [];
  const failures = [];

  if (!dryRun) {
    for (const c of picked) {
      try {
        const dupe = await pgQuery(
          `SELECT id FROM brief_generation_jobs
            WHERE ad_archive_id = $1 AND status IN ('queued','transcribing','generating') LIMIT 1`,
          [String(c.ad_archive_id)]
        );
        if (dupe.length) {
          skipped.push({ ad: c.id, brand: c.brand_domain, headline: c.headline, reason: 'already queued or running' });
          continue;
        }
        const ins = await pgQuery(
          `INSERT INTO brief_generation_jobs (
             brand_spy_ad_id, ad_archive_id, brand_id, brand_name, tier, headline,
             product_id, product_code, angle, model, fit_score, fit_angle, fit_why
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           RETURNING id`,
          [String(c.id), String(c.ad_archive_id), String(c.brand_id), c.brand_domain,
           c.tier, c.headline, cfg.productId, cfg.productCode, cfg.angle || null, 'claude',
           // the triage verdict rides with the job so "does fit predict the
           // operator's approval?" stays a one-query question forever
           c.fit ?? null, c.fitAngle ?? null, c.fitWhy ?? null]
        );
        generated.push({ jobId: ins[0].id, naming: `${c.brand_domain} — ${String(c.headline || '').slice(0, 44)}`, score: null, flags: [] });
      } catch (e) {
        failures.push({ brand: c.brand_domain, headline: c.headline, error: e.message });
      }
    }
  }

  const report = formatReport({ picked, skipped, generated, failures, dryRun, startedAt, triaged });
  return { cfg, considered, triaged, picked, skipped, generated, failures, report, dryRun };
}

/**
 * In-process scheduler, matching the pattern already used for the Monday editor
 * report. Checks every minute and fires once when the configured Madrid hour is
 * reached.
 *
 * Guards, each earning its place:
 *  - reads config on EVERY tick, so enabling/disabling or moving the hour takes
 *    effect without a redeploy
 *  - lastRunDate is the Madrid calendar date, so a run happens at most once a
 *    day and a restart mid-window cannot double-fire
 *  - the hour comparison uses Intl with an explicit timeZone, so it follows
 *    Madrid across DST instead of drifting an hour twice a year
 */
let _autopilotTimer = null;
let _lastRunDate = null;

export function startAutopilotScheduler({ intervalMs = 60_000 } = {}) {
  if (_autopilotTimer) return;
  _autopilotTimer = setInterval(async () => {
    try {
      const cfg = await getAutopilotConfig();
      if (!cfg.enabled) return;

      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: cfg.timezone || 'Europe/Madrid',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(new Date());
      const get = t => parts.find(p => p.type === t)?.value;
      const hour = parseInt(get('hour'), 10);
      const localDate = `${get('year')}-${get('month')}-${get('day')}`;

      if (hour !== Number(cfg.startHour)) return;
      if (_lastRunDate === localDate) return;
      _lastRunDate = localDate;

      console.log(`[Autopilot] firing scheduled run for ${localDate} ${String(cfg.startHour).padStart(2, '0')}:00 ${cfg.timezone}`);
      const result = await runAutopilotBatch({ dryRun: cfg.dryRun === true });
      console.log(`[Autopilot] run complete — considered ${result.considered}, queued ${result.generated.length}, skipped ${result.skipped.length}`);
      await reportToSlack(result.report);
    } catch (err) {
      console.error('[Autopilot] scheduled run failed:', err.message);
      await reportToSlack(`*Autopilot Mode* — run FAILED: ${err.message}`).catch(() => {});
    }
  }, intervalMs);
  if (_autopilotTimer.unref) _autopilotTimer.unref();
  console.log('[Autopilot] scheduler active — checks every minute, fires at the configured Madrid hour when enabled');
}

export function stopAutopilotScheduler() {
  if (_autopilotTimer) { clearInterval(_autopilotTimer); _autopilotTimer = null; }
}
