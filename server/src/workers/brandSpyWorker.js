/**
 * Brand Spy — scrape worker + tier scoring
 */

import { query } from '../config/db.js';
import { withTransaction, recomputeBrandCounters } from '../db/brandSpyDb.js';
import { getScrapeCreatorsClient, ScrapeCreatorsError } from '../services/scrapeCreators.js';

// ---------------------------------------------------------------------------
// Tier engine (pure functions)
// ---------------------------------------------------------------------------

const BANGER_AGE_DAYS   = 10;
const BANGER_PERCENTILE = 0.03;
const CHAMP_PERCENTILE  = 0.10;
const A_PERCENTILE      = 0.25;
const B_PERCENTILE      = 0.50;
const C_PERCENTILE      = 0.75;
const MID_PERCENTILE    = 0.90;

function rankAndTier(ads) {
  const active   = ads.filter((a) => a.isActive);
  const inactive = ads.filter((a) => !a.isActive);
  const poolSize = active.length;

  if (poolSize === 0) return ads.map((a) => ({ ...a, rank: null, poolSize: 0, tier: null }));

  if (poolSize === 1) {
    const tier = isBanger(active[0]) ? 'BANGER' : 'CHAMP';
    return [
      { ...active[0], rank: 1, poolSize: 1, tier },
      ...inactive.map((a) => ({ ...a, rank: null, poolSize: 1, tier: null })),
    ];
  }

  const champEnd  = Math.max(1, Math.ceil(poolSize * CHAMP_PERCENTILE));
  const aEnd      = Math.max(champEnd, Math.ceil(poolSize * A_PERCENTILE));
  const bEnd      = Math.max(aEnd,    Math.ceil(poolSize * B_PERCENTILE));
  const cEnd      = Math.max(bEnd,    Math.ceil(poolSize * C_PERCENTILE));
  const midEnd    = Math.max(cEnd,    Math.ceil(poolSize * MID_PERCENTILE));
  const bangerCut = Math.max(1, Math.ceil(poolSize * BANGER_PERCENTILE));

  const ranked = active.map((ad, idx) => {
    const rank = idx + 1;
    let tier;
    if (rank <= bangerCut && isBanger(ad))  tier = 'BANGER';
    else if (rank <= champEnd)              tier = 'CHAMP';
    else if (rank <= aEnd)                  tier = 'A';
    else if (rank <= bEnd)                  tier = 'B';
    else if (rank <= cEnd)                  tier = 'C';
    else if (rank <= midEnd)                tier = 'MID';
    else                                    tier = 'TEST';
    return { ...ad, rank, poolSize, tier };
  });

  return [...ranked, ...inactive.map((a) => ({ ...a, rank: null, poolSize, tier: null }))];
}

function isBanger(ad) {
  return ad.activeDays !== null && ad.activeDays < BANGER_AGE_DAYS && ad.isActive;
}

function summarizeTiers(ranked) {
  const out = { banger: 0, champ: 0, a: 0, b: 0, c: 0, mid: 0, test: 0 };
  for (const r of ranked) {
    switch (r.tier) {
      case 'BANGER': out.banger++; break;
      case 'CHAMP':  out.champ++;  break;
      case 'A':      out.a++;      break;
      case 'B':      out.b++;      break;
      case 'C':      out.c++;      break;
      case 'MID':    out.mid++;    break;
      case 'TEST':   out.test++;   break;
    }
  }
  return out;
}

function computeVelocity({ currentRank, rank7d, rank21d }) {
  return {
    velocity7d:  currentRank !== null && rank7d  !== null ? rank7d  - currentRank : null,
    velocity21d: currentRank !== null && rank21d !== null ? rank21d - currentRank : null,
  };
}

// ---------------------------------------------------------------------------
// Score brand (rank + tier + snapshots)
// ---------------------------------------------------------------------------

export async function scoreBrand(brandId) {
  return withTransaction(async (client) => {
    const adsRes = await client.query(
      `SELECT id, ad_archive_id, is_active, start_date, active_days, total_active_time, last_seen_at
         FROM brand_spy.ads WHERE brand_id = $1
         ORDER BY is_active DESC, total_active_time DESC NULLS LAST, last_seen_at DESC`,
      [brandId],
    );

    const ads = adsRes.rows.map((r) => ({
      id: r.id,
      adArchiveId: r.ad_archive_id,
      isActive: r.is_active,
      startDateMs: r.start_date ? new Date(r.start_date).getTime() : null,
      activeDays: r.active_days,
    }));

    const ranked = rankAndTier(ads);
    const breakdown = summarizeTiers(ranked);
    const poolSize = ranked.find((r) => r.rank === 1)?.poolSize ?? 0;

    const historical = await loadHistoricalRanks(client, brandId);

    let snapshotsWritten = 0;
    for (const r of ranked) {
      const hist = historical.get(r.adArchiveId) ?? { d3: null, d7: null, d21: null };
      const velocity = computeVelocity({ currentRank: r.rank, rank7d: hist.d7, rank21d: hist.d21 });

      await client.query(
        `UPDATE brand_spy.ads SET
           current_rank    = $2,
           rank_3d         = $3,
           rank_7d         = $4,
           rank_21d        = $5,
           velocity_7d     = $6,
           velocity_21d    = $7,
           pool_size       = $8,
           tier            = $9,
           tier_score      = CASE WHEN $2 IS NULL THEN NULL ELSE ($8::numeric - $2 + 1) END,
           tier_updated_at = NOW()
         WHERE id = $1`,
        [r.id, r.rank, hist.d3, hist.d7, hist.d21, velocity.velocity7d, velocity.velocity21d, r.poolSize, r.tier],
      );

      if (r.rank !== null && r.tier !== null) {
        await client.query(
          `INSERT INTO brand_spy.ad_rank_snapshots (brand_id, ad_id, ad_archive_id, rank, pool_size, tier, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
          [brandId, r.id, r.adArchiveId, r.rank, r.poolSize, r.tier],
        );
        snapshotsWritten += 1;
      }
    }

    await client.query(
      `UPDATE brand_spy.brands SET
         banger_count    = $2,
         champ_count     = $3,
         tier_a_count    = $4,
         tier_b_count    = $5,
         tier_c_count    = $6,
         tier_low_count  = $7,
         tier_test_count = $8
       WHERE id = $1`,
      [brandId, breakdown.banger, breakdown.champ, breakdown.a, breakdown.b, breakdown.c, breakdown.mid, breakdown.test],
    );

    return { poolSize, tierBreakdown: breakdown, snapshotsWritten };
  });
}

async function loadHistoricalRanks(client, brandId) {
  const result = new Map();
  const windows = [
    { key: 'd3',  centerDays: 3,  halfWidthDays: 1 },
    { key: 'd7',  centerDays: 7,  halfWidthDays: 2 },
    { key: 'd21', centerDays: 21, halfWidthDays: 4 },
  ];

  for (const w of windows) {
    const upper = w.centerDays + w.halfWidthDays;
    const { rows } = await client.query(
      `SELECT DISTINCT ON (ad_archive_id) ad_archive_id, rank
         FROM brand_spy.ad_rank_snapshots
        WHERE brand_id = $1
          AND snapshot_at BETWEEN NOW() - ($3 || ' days')::INTERVAL
                              AND NOW() - ($2 || ' days')::INTERVAL
        ORDER BY ad_archive_id,
                 ABS(EXTRACT(EPOCH FROM (NOW() - snapshot_at - ($2 || ' days')::INTERVAL)))`,
      [brandId, w.centerDays.toString(), upper.toString()],
    );
    for (const row of rows) {
      const existing = result.get(row.ad_archive_id) ?? { d3: null, d7: null, d21: null };
      existing[w.key] = row.rank;
      result.set(row.ad_archive_id, existing);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Scrape worker
// ---------------------------------------------------------------------------

const CONFIDENCE_THRESHOLD = 0.4;
const NOISY_THRESHOLD = 0.5;

export async function runBrandScrape({ brandId, trigger, client: scClient }) {
  const sc = scClient ?? getScrapeCreatorsClient();

  const brandRow = await query(
    `SELECT id, domain, display_name FROM brand_spy.brands WHERE id = $1`,
    [brandId],
  );
  if (!brandRow.rows.length) throw new Error(`Brand ${brandId} not found`);
  const brand = brandRow.rows[0];

  const jobRow = await query(
    `INSERT INTO brand_spy.scrape_jobs (brand_id, job_type, status, trigger, started_at)
     VALUES ($1, 'REFRESH', 'RUNNING', $2, NOW()) RETURNING id`,
    [brand.id, trigger],
  );
  const jobId = jobRow.rows[0].id;

  await query(
    `UPDATE brand_spy.brands SET last_scrape_status = 'RUNNING', last_scrape_error = NULL WHERE id = $1`,
    [brand.id],
  );

  let creditsUsed = 0;
  const onCredits = (delta) => { creditsUsed += delta; };

  try {
    const existingPages = await query(
      `SELECT meta_page_id FROM brand_spy.brand_pages WHERE brand_id = $1`,
      [brand.id],
    );

    let pagesDiscovered = 0;
    if (existingPages.rows.length === 0) {
      pagesDiscovered = await discoverPages(brand, sc, onCredits);
    }

    const allPages = await query(
      `SELECT id, meta_page_id FROM brand_spy.brand_pages WHERE brand_id = $1`,
      [brand.id],
    );

    let adsDiscovered = 0;
    let adsUpdated = 0;
    for (const page of allPages.rows) {
      const stats = await scrapeAdsForPage(brand.id, page.id, page.meta_page_id, sc);
      adsDiscovered += stats.discovered;
      adsUpdated += stats.updated;
      onCredits(stats.creditsUsed);
    }

    await recomputeBrandCounters(brand.id);
    await recomputeDomainRollup(brand.id);
    await recomputePageRollup(brand.id);

    try {
      await scoreBrand(brand.id);
    } catch (scoreErr) {
      console.error(`[brand-spy] tier scoring failed for ${brand.id}:`, scoreErr);
    }

    await query(
      `UPDATE brand_spy.scrape_jobs
          SET status = 'DONE', finished_at = NOW(),
              pages_discovered = $2, ads_discovered = $3, ads_updated = $4, credits_used = $5
        WHERE id = $1`,
      [jobId, pagesDiscovered, adsDiscovered, adsUpdated, creditsUsed],
    );
    await query(
      `UPDATE brand_spy.brands
          SET last_scraped_at = NOW(), last_scrape_status = 'DONE', last_scrape_error = NULL
        WHERE id = $1`,
      [brand.id],
    );

    return { jobId, status: 'DONE', pagesDiscovered, adsDiscovered, adsUpdated, creditsUsed };
  } catch (err) {
    const message =
      err instanceof ScrapeCreatorsError ? `${err.code}: ${err.message}`
        : err instanceof Error ? err.message
        : 'Unknown error';

    await query(
      `UPDATE brand_spy.scrape_jobs SET status = 'ERROR', finished_at = NOW(), error_message = $2, credits_used = $3 WHERE id = $1`,
      [jobId, message, creditsUsed],
    );
    await query(
      `UPDATE brand_spy.brands SET last_scrape_status = 'ERROR', last_scrape_error = $2 WHERE id = $1`,
      [brand.id, message],
    );

    return { jobId, status: 'ERROR', pagesDiscovered: 0, adsDiscovered: 0, adsUpdated: 0, creditsUsed, errorMessage: message };
  }
}

// ---------------------------------------------------------------------------
// Page discovery
// ---------------------------------------------------------------------------

async function discoverPages(brand, sc, onCredits) {
  const queryTerm = brand.display_name ?? extractBrandLabel(brand.domain);
  const resp = await sc.searchCompanies(queryTerm);
  onCredits(1);

  if (!resp.searchResults?.length) {
    await query(`UPDATE brand_spy.brands SET status = 'NOISY' WHERE id = $1`, [brand.id]);
    return 0;
  }

  let inserted = 0;
  let bestConfidence = 0;

  for (const result of resp.searchResults) {
    const confidence = scoreMatch(queryTerm, result.name, result.page_alias);
    if (confidence < CONFIDENCE_THRESHOLD) continue;
    bestConfidence = Math.max(bestConfidence, confidence);

    await query(
      `INSERT INTO brand_spy.brand_pages (brand_id, meta_page_id, page_name, page_profile_pic, match_confidence)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (brand_id, meta_page_id) DO UPDATE SET
         page_name = EXCLUDED.page_name,
         page_profile_pic = COALESCE(EXCLUDED.page_profile_pic, brand_spy.brand_pages.page_profile_pic),
         match_confidence = GREATEST(brand_spy.brand_pages.match_confidence, EXCLUDED.match_confidence),
         last_seen_at = NOW()`,
      [brand.id, result.page_id, result.name, result.image_uri ?? null, confidence],
    );
    inserted += 1;
  }

  if (bestConfidence < NOISY_THRESHOLD) {
    await query(`UPDATE brand_spy.brands SET status = 'NOISY' WHERE id = $1`, [brand.id]);
  }
  return inserted;
}

function extractBrandLabel(domain) {
  const cleaned = domain.toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '');
  const host = cleaned.split('/')[0];
  const parts = host.split('.');
  if (parts.length < 2) return host;
  return parts[parts.length - 2];
}

function scoreMatch(q, name, alias) {
  const qNorm = q.toLowerCase().replace(/[^a-z0-9]/g, '');
  const candidates = [name, alias ?? '']
    .filter(Boolean)
    .map((s) => s.toLowerCase().replace(/[^a-z0-9]/g, ''));

  let best = 0;
  for (const c of candidates) {
    if (!c) continue;
    if (c === qNorm) return 1.0;
    if (c.includes(qNorm) || qNorm.includes(c)) {
      const ratio = Math.min(c.length, qNorm.length) / Math.max(c.length, qNorm.length);
      best = Math.max(best, ratio);
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Ad scraping
// ---------------------------------------------------------------------------

async function scrapeAdsForPage(brandId, brandPageId, metaPageId, sc) {
  let discovered = 0;
  let updated = 0;
  let creditsUsed = 0;

  for await (const batch of sc.iterateCompanyAds({ pageId: metaPageId, status: 'ALL' })) {
    creditsUsed += 1;
    const result = await upsertAdsBatch(brandId, brandPageId, metaPageId, batch);
    discovered += result.inserted;
    updated += result.updated;
  }
  return { discovered, updated, creditsUsed };
}

async function upsertAdsBatch(brandId, brandPageId, metaPageId, ads) {
  let inserted = 0;
  let updated = 0;

  await withTransaction(async (client) => {
    for (const ad of ads) {
      const startDate = ad.start_date ? new Date(ad.start_date * 1000) : null;
      const endDate   = ad.end_date   ? new Date(ad.end_date   * 1000) : null;
      const activeDays = computeActiveDays(startDate, endDate, ad.is_active);

      const res = await client.query(
        `INSERT INTO brand_spy.ads (
           brand_id, brand_page_id, ad_archive_id, meta_page_id,
           is_active, start_date, end_date, total_active_time, active_days,
           display_format, cta_text, cta_type, headline, body_text,
           link_url, caption, publisher_platforms,
           collation_id, collation_count, raw_snapshot
         ) VALUES (
           $1, $2, $3, $4,
           $5, $6, $7, $8, $9,
           $10, $11, $12, $13, $14,
           $15, $16, $17,
           $18, $19, $20
         )
         ON CONFLICT (brand_id, ad_archive_id) DO UPDATE SET
           is_active = EXCLUDED.is_active,
           end_date = EXCLUDED.end_date,
           total_active_time = EXCLUDED.total_active_time,
           active_days = EXCLUDED.active_days,
           last_seen_at = NOW(),
           raw_snapshot = EXCLUDED.raw_snapshot
         RETURNING (xmax = 0) AS inserted`,
        [
          brandId, brandPageId, ad.ad_archive_id, metaPageId,
          ad.is_active, startDate, endDate, ad.total_active_time, activeDays,
          ad.snapshot?.display_format ?? null,
          ad.snapshot?.cta_text ?? null,
          ad.snapshot?.cta_type ?? null,
          ad.snapshot?.title ?? null,
          ad.snapshot?.body?.text ?? null,
          ad.snapshot?.link_url ?? null,
          ad.snapshot?.caption ?? null,
          ad.publisher_platform ?? [],
          ad.collation_id,
          ad.collation_count,
          ad.snapshot ?? null,
        ],
      );
      if (res.rows[0]?.inserted) inserted += 1;
      else updated += 1;
    }
  });

  return { inserted, updated };
}

function computeActiveDays(start, end, isActive) {
  if (!start) return null;
  const endTime = isActive ? Date.now() : end?.getTime() ?? null;
  if (!endTime) return null;
  return Math.max(0, Math.floor((endTime - start.getTime()) / (1000 * 60 * 60 * 24)));
}

// ---------------------------------------------------------------------------
// Rollups
// ---------------------------------------------------------------------------

async function recomputePageRollup(brandId) {
  await query(
    `UPDATE brand_spy.brand_pages bp SET
       active_ads_count = COALESCE((SELECT COUNT(*) FROM brand_spy.ads WHERE brand_page_id = bp.id AND is_active = TRUE), 0),
       total_ads_count  = COALESCE((SELECT COUNT(*) FROM brand_spy.ads WHERE brand_page_id = bp.id), 0),
       last_seen_at = NOW()
     WHERE bp.brand_id = $1`,
    [brandId],
  );
}

async function recomputeDomainRollup(brandId) {
  await query(
    `INSERT INTO brand_spy.brand_domains (brand_id, domain, active_ads_count, total_ads_count)
     SELECT
       $1 AS brand_id,
       lower(split_part(regexp_replace(link_url, '^https?://(www\\.)?', ''), '/', 1)) AS domain,
       COUNT(*) FILTER (WHERE is_active) AS active_ads_count,
       COUNT(*) AS total_ads_count
     FROM brand_spy.ads
     WHERE brand_id = $1 AND link_url IS NOT NULL AND link_url <> ''
     GROUP BY domain
     ON CONFLICT (brand_id, domain) DO UPDATE SET
       active_ads_count = EXCLUDED.active_ads_count,
       total_ads_count  = EXCLUDED.total_ads_count`,
    [brandId],
  );
  await query(
    `UPDATE brand_spy.brand_domains
        SET is_primary = (id = (
          SELECT id FROM brand_spy.brand_domains
           WHERE brand_id = $1
           ORDER BY active_ads_count DESC, total_ads_count DESC LIMIT 1
        ))
      WHERE brand_id = $1`,
    [brandId],
  );
}

// ---------------------------------------------------------------------------
// Scrape-all background helper
// ---------------------------------------------------------------------------

export async function scrapeAllInBackground(brandIds) {
  const CONCURRENCY = 3;
  const queue = [...brandIds];
  async function worker() {
    while (queue.length) {
      const brandId = queue.shift();
      if (!brandId) return;
      try { await runBrandScrape({ brandId, trigger: 'CRON' }); }
      catch (err) { console.error(`[brand-spy] scrape failed for ${brandId}:`, err); }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
}
