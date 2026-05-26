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

      const tierScore = r.rank !== null ? (r.poolSize - r.rank + 1) : null;

      await client.query(
        `UPDATE brand_spy.ads SET
           current_rank    = $2::integer,
           rank_3d         = $3,
           rank_7d         = $4,
           rank_21d        = $5,
           velocity_7d     = $6,
           velocity_21d    = $7,
           pool_size       = $8::integer,
           tier            = $9,
           tier_score      = $10,
           tier_updated_at = NOW()
         WHERE id = $1`,
        [r.id, r.rank, hist.d3, hist.d7, hist.d21, velocity.velocity7d, velocity.velocity21d, r.poolSize, r.tier, tierScore],
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
          AND snapshot_at BETWEEN NOW() - ($3::text || ' days')::INTERVAL
                              AND NOW() - ($2::text || ' days')::INTERVAL
        ORDER BY ad_archive_id,
                 ABS(EXTRACT(EPOCH FROM (NOW() - snapshot_at - ($2::text || ' days')::INTERVAL)))`,
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
    const stats = await scrapeAdsByDomain(brand.id, brand.domain, sc, async () => {
      await recomputeBrandCounters(brand.id);
      await recomputeDomainRollup(brand.id);
      await recomputePageRollup(brand.id);
    });
    onCredits(stats.creditsUsed);

    const pagesRes = await query(
      `SELECT COUNT(*) AS count FROM brand_spy.brand_pages WHERE brand_id = $1`,
      [brand.id],
    );
    const pagesDiscovered = parseInt(pagesRes.rows[0].count, 10);

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
      [jobId, pagesDiscovered, stats.discovered, stats.updated, creditsUsed],
    );
    await query(
      `UPDATE brand_spy.brands
          SET last_scraped_at = NOW(), last_scrape_status = 'DONE', last_scrape_error = NULL
        WHERE id = $1`,
      [brand.id],
    );

    return { jobId, status: 'DONE', pagesDiscovered, adsDiscovered: stats.discovered, adsUpdated: stats.updated, creditsUsed };
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
// Domain-based ad scraping
// ---------------------------------------------------------------------------

async function upsertBrandPage(brandId, metaPageId, pageName, profilePic) {
  const { rows } = await query(
    `INSERT INTO brand_spy.brand_pages (brand_id, meta_page_id, page_name, page_profile_pic)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (brand_id, meta_page_id) DO UPDATE SET
       page_name        = COALESCE(EXCLUDED.page_name, brand_spy.brand_pages.page_name),
       page_profile_pic = COALESCE(EXCLUDED.page_profile_pic, brand_spy.brand_pages.page_profile_pic),
       last_seen_at     = NOW()
     RETURNING id`,
    [brandId, metaPageId, pageName ?? metaPageId, profilePic ?? null],
  );
  return rows[0].id;
}

const PHASE2_CONCURRENCY = 3;
const AD_COLS = 20;

function extractDomain(url) {
  if (!url) return null;
  const m = url.replace(/^https?:\/\/(www\.)?/, '').match(/^([^/?# ]+)/);
  return m ? m[1].toLowerCase() : null;
}

// crossDomains: optional Set — collects link_url domains seen in this batch
async function upsertAdBatch(brandId, ads, pageCache, pageIdFallback = null, crossDomains = null) {
  if (!ads.length) return { d: 0, u: 0 };

  // Resolve page IDs (may upsert new pages) before entering bulk transaction
  const rows = [];
  for (const ad of ads) {
    const metaPageId = String(ad.page_id ?? ad.meta_page_id ?? pageIdFallback ?? '');
    const pageName   = ad.page_name ?? null;
    const profilePic = ad.snapshot?.page_profile_picture_url ?? null;

    if (crossDomains) {
      const d = extractDomain(ad.snapshot?.link_url ?? null);
      if (d) crossDomains.add(d);
    }

    let brandPageId = pageCache.get(metaPageId) ?? null;
    if (metaPageId && !brandPageId) {
      brandPageId = await upsertBrandPage(brandId, metaPageId, pageName, profilePic);
      pageCache.set(metaPageId, brandPageId);
    }

    const startDate  = ad.start_date ? new Date(ad.start_date * 1000) : null;
    const endDate    = ad.end_date   ? new Date(ad.end_date   * 1000) : null;
    const activeDays = computeActiveDays(startDate, endDate, ad.is_active);

    rows.push([
      brandId, brandPageId, ad.ad_archive_id, metaPageId,
      ad.is_active ?? false, startDate, endDate, ad.total_active_time ?? null, activeDays,
      ad.snapshot?.display_format ?? null,
      ad.snapshot?.cta_text       ?? null,
      ad.snapshot?.cta_type       ?? null,
      ad.snapshot?.title          ?? null,
      ad.snapshot?.body?.text     ?? null,
      ad.snapshot?.link_url       ?? null,
      ad.snapshot?.caption        ?? null,
      ad.publisher_platform       ?? [],
      ad.collation_id             ?? null,
      ad.collation_count          ?? null,
      ad.snapshot                 ?? null,
    ]);
  }

  // Single bulk INSERT — 1 DB round-trip for the whole batch
  const placeholders = rows
    .map((_, i) =>
      `(${Array.from({ length: AD_COLS }, (_, j) => `$${i * AD_COLS + j + 1}`).join(',')})`,
    )
    .join(',');

  let discovered = 0, updated = 0;
  await withTransaction(async (client) => {
    const res = await client.query(
      `INSERT INTO brand_spy.ads (
         brand_id, brand_page_id, ad_archive_id, meta_page_id,
         is_active, start_date, end_date, total_active_time, active_days,
         display_format, cta_text, cta_type, headline, body_text,
         link_url, caption, publisher_platforms,
         collation_id, collation_count, raw_snapshot
       ) VALUES ${placeholders}
       ON CONFLICT (brand_id, ad_archive_id) DO UPDATE SET
         is_active         = (brand_spy.ads.is_active OR EXCLUDED.is_active),
         end_date          = EXCLUDED.end_date,
         total_active_time = EXCLUDED.total_active_time,
         active_days       = EXCLUDED.active_days,
         last_seen_at      = NOW(),
         raw_snapshot      = EXCLUDED.raw_snapshot
       RETURNING (xmax = 0) AS inserted`,
      rows.flat(),
    );
    for (const row of res.rows) {
      if (row.inserted) discovered++; else updated++;
    }
  });
  return { d: discovered, u: updated };
}

async function scrapeAdsByDomain(brandId, domain, sc, onPhase1Done) {
  let discovered = 0, updated = 0, creditsUsed = 0;
  const pageCache    = new Map(); // metaPageId → brandPageId (UUID)
  const p2Launched   = new Set(); // pages already queued for Phase 2
  const p2Promises   = [];
  const crossDomains = new Set(); // link_url domains seen in Phase 2 ads

  // Semaphore: cap Phase 2 at PHASE2_CONCURRENCY concurrent page scrapes
  let activeP2 = 0;
  const waiters = [];
  function acquireP2() {
    if (activeP2 < PHASE2_CONCURRENCY) { activeP2++; return Promise.resolve(); }
    return new Promise(r => waiters.push(r));
  }
  function releaseP2() {
    const next = waiters.shift();
    if (next) next(); else activeP2--;
  }

  async function runPhase2Page(metaPageId) {
    await acquireP2();
    try {
      for await (const batch of sc.iterateCompanyAds({ pageId: metaPageId, status: 'ALL', country: 'ALL', maxPages: 20 })) {
        creditsUsed += 1;
        // Pass crossDomains so Phase 2 ads' link_url domains are collected
        const { d, u } = await upsertAdBatch(brandId, batch, pageCache, metaPageId, crossDomains);
        discovered += d; updated += u;
      }
    } finally {
      releaseP2();
    }
  }

  function launchNewPages() {
    for (const metaPageId of pageCache.keys()) {
      if (metaPageId && !p2Launched.has(metaPageId)) {
        p2Launched.add(metaPageId);
        p2Promises.push(runPhase2Page(metaPageId));
      }
    }
  }

  // Phase 1a: active-only pass — captures every currently running ad regardless of
  // impression rank. This is the critical pass for matching Meta's "active ads" count.
  console.log(`[brand-spy] phase-1a: active-only keyword search for "${domain}" (US)`);
  for await (const batch of sc.iterateAdsByDomain({ domain, status: 'ACTIVE', country: 'US' })) {
    creditsUsed += 1;
    const { d, u } = await upsertAdBatch(brandId, batch, pageCache);
    discovered += d; updated += u;
    launchNewPages();
  }
  console.log(`[brand-spy] phase-1a done: ${discovered} new, ${updated} updated, ${pageCache.size} pages, ${creditsUsed} credits`);

  // Phase 1b: all-status pass — discovers historical inactive ads and any pages not
  // yet found by the active-only pass (sorts by total_impressions, capped at 50 pages).
  console.log(`[brand-spy] phase-1b: all-status keyword search for "${domain}" (US)`);
  for await (const batch of sc.iterateAdsByDomain({ domain, status: 'ALL', country: 'US' })) {
    creditsUsed += 1;
    const { d, u } = await upsertAdBatch(brandId, batch, pageCache);
    discovered += d; updated += u;
    launchNewPages();
  }
  console.log(`[brand-spy] phase-1 done: ${discovered} new, ${updated} updated, ${pageCache.size} pages, ${creditsUsed} credits`);

  // Flush counters so UI shows Phase 1 results while Phase 2 is still running
  await onPhase1Done?.();

  // Await all Phase 2 workers (already running concurrently since Phase 1)
  await Promise.all(p2Promises);
  console.log(`[brand-spy] phase-2 done: ${discovered} new, ${updated} updated, ${pageCache.size} pages, ${creditsUsed} credits`);

  // Phase 3: cross-domain expansion
  // Query the DB for all distinct link_url domains stored so far — this is more
  // reliable than reading from the live API response, which may use different field
  // names across endpoints (search/ads vs company/ads).
  const { rows: domainRows } = await query(
    `SELECT DISTINCT lower(split_part(regexp_replace(link_url, '^https?://(www\\.)?', ''), '/', 1)) AS d
       FROM brand_spy.ads
      WHERE brand_id = $1 AND link_url IS NOT NULL AND link_url <> ''`,
    [brandId],
  );
  for (const { d } of domainRows) {
    if (d) crossDomains.add(d);
  }

  const toExpand = [...crossDomains].filter(d =>
    d &&
    d !== domain &&
    !d.endsWith('.' + domain), // skip subdomains of primary already covered
  );

  if (toExpand.length > 0) {
    // Keyword search doesn't work for cross-domains — the domain only appears in the
    // destination URL, not in ad text, so Meta's keyword index doesn't find it.
    // Instead: searchCompanies by name → find their pages → Phase 2 scrape (US filter).
    console.log(`[brand-spy] phase-3: company search for [${toExpand.join(', ')}]`);
    for (const xDomain of toExpand) {
      // Strip TLD: 'dailynationalnews.com' → 'dailynationalnews'
      const companyName = xDomain.replace(/\.[a-z]{2,}(\.[a-z]{2})?$/, '');
      let result;
      try {
        result = await sc.searchCompanies(companyName);
        creditsUsed += 1;
      } catch (err) {
        console.error(`[brand-spy] phase-3 company search failed for "${companyName}":`, err.message);
        continue;
      }
      // Handle various response shapes from the API.
      // The search/companies endpoint returns { searchResults: [...] } (same key as search/ads).
      const pages = result?.searchResults ?? result?.results ?? result?.data ?? result?.companies ?? [];
      console.log(`[brand-spy] phase-3: "${companyName}" → ${pages.length} pages`);
      for (const page of pages.slice(0, 5)) { // cap at 5 per domain to avoid credit blowout
        const metaPageId = String(page.page_id ?? page.id ?? page.pageId ?? '');
        if (!metaPageId || p2Launched.has(metaPageId)) continue;
        if (!pageCache.has(metaPageId)) {
          const pageName = page.page_name ?? page.name ?? page.pageName ?? null;
          const brandPageId = await upsertBrandPage(brandId, metaPageId, pageName, null);
          pageCache.set(metaPageId, brandPageId);
        }
        p2Launched.add(metaPageId);
        p2Promises.push(runPhase2Page(metaPageId)); // Phase 2 runs with country:US
      }
    }
    // Await Phase 2 workers kicked off by Phase 3
    await Promise.all(p2Promises);
    console.log(`[brand-spy] phase-3 done: total ${discovered} new, ${updated} updated, ${creditsUsed} credits`);
  }

  return { discovered, updated, creditsUsed };
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
