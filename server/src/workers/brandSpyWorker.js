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
      await recomputeDomainRollup(brand.id, brand.domain);
      await recomputePageRollup(brand.id);
    });
    onCredits(stats.creditsUsed);

    const pagesRes = await query(
      `SELECT COUNT(*) AS count FROM brand_spy.brand_pages WHERE brand_id = $1`,
      [brand.id],
    );
    const pagesDiscovered = parseInt(pagesRes.rows[0].count, 10);

    await recomputeBrandCounters(brand.id);
    await recomputeDomainRollup(brand.id, brand.domain);
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

async function upsertBrandDomain(brandId, domain, domainType) {
  await query(
    `INSERT INTO brand_spy.brand_domains (brand_id, domain, domain_type, last_seen_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (brand_id, domain) DO UPDATE SET
       domain_type  = EXCLUDED.domain_type,
       last_seen_at = NOW()`,
    [brandId, domain, domainType],
  );
}

// Phase 2 concurrency: how many FB pages to scrape in parallel.
// ScrapeCreators' /company/ads is rate-limited per API key; set to 5 so
// N pages run simultaneously. p2Blocked fast-fails all workers on first 431.
const PHASE2_CONCURRENCY = 5;
const AD_COLS = 20;

// Meta's own platform pages appear in Phase 1 keyword results because some brands
// advertise through them (no dedicated FB page). Phase 2 scraping these pages returns
// ALL their ads (for hundreds of brands), not just the target brand's ads. To avoid
// storing irrelevant ads, Phase 2 filters batches from these pages to only include
// ads whose link_url contains the brand's root fragment.
const META_PLATFORM_PAGE_NAMES_LOWER = new Set([
  'instagram for business',
  'instagram',
  'facebook',
  'facebook for business',
  'creators',
  'meta',
  'meta for business',
  'facebook ads',
  'whatsapp business',
  'messenger',
  'reels',
]);

function isMetaPlatformPage(pageName) {
  if (!pageName) return false;
  const lower = pageName.toLowerCase().trim();
  if (META_PLATFORM_PAGE_NAMES_LOWER.has(lower)) return true;
  // Catch variants like "Instagram - Online Business" or "Reels Maker for Instagram"
  if (lower.startsWith('instagram') || lower.startsWith('facebook') || lower.startsWith('meta ')) return true;
  return false;
}

function extractDomain(url) {
  if (!url) return null;
  const m = url.replace(/^https?:\/\/(www\.)?/, '').match(/^([^/?# ]+)/);
  return m ? m[1].toLowerCase() : null;
}

// crossDomains: optional Set — collects link_url domains seen in this batch
// pageNameCache: optional Map — populated with metaPageId → pageName for Phase 2 filtering
async function upsertAdBatch(brandId, ads, pageCache, pageIdFallback = null, crossDomains = null, pageNameCache = null) {
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
    // Populate page name cache so Phase 2 can identify Meta platform pages
    if (metaPageId && pageName && pageNameCache && !pageNameCache.has(metaPageId)) {
      pageNameCache.set(metaPageId, pageName);
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
  const pageCache     = new Map(); // metaPageId → brandPageId (UUID)
  const pageNameCache = new Map(); // metaPageId → pageName (string) — needed for Phase 2 filtering
  const p2Launched    = new Set(); // pages already queued for Phase 2
  const p2Promises    = [];
  let p2Blocked       = false;     // set true on first Phase 2 failure to fast-skip remainder
  const crossDomains  = new Set(); // link_url domains seen in ads

  // Root fragment for relevance filtering in Phase 2 Meta platform page scrapes.
  // 'try-forge.com' → 'try-forge' so ads linking to shop.try-forge.com also match.
  const rootFragment = domain.replace(/\.[a-z]{2,}(\.[a-z]{2,})?$/, '');

  // Reset all ads to is_active=false at the start of each scrape so the current
  // run reflects Meta's live state. OR-semantics in UPSERT then let the ACTIVE
  // passes re-mark the correct ones true within this run. Without the reset, ads
  // marked active by a previous run (e.g. with country:ALL) would be permanently
  // locked active by OR logic even after we switch to country:US.
  await query(`UPDATE brand_spy.ads SET is_active = FALSE WHERE brand_id = $1`, [brandId]);
  console.log(`[brand-spy] reset is_active=false for "${domain}"`);

  // Pre-populate pageCache from DB so Phase 2 covers ALL known pages, not just
  // those discovered by the current Phase 1 keyword search. Without this, brands
  // like thegreatproject.com whose keyword search only finds 1 page per run would
  // miss the other 15 stored pages — and their active ads — every scrape.
  // IMPORTANT: Skip Meta platform pages (Instagram for Business, Instagram, Creators, etc.)
  // from pre-loading. Those pages advertise many brands — Phase 2 scraping them without
  // a brand-domain filter would store thousands of irrelevant ads. They will still be
  // discovered by Phase 1 keyword search if relevant, and Phase 2 handles them with
  // link_url filtering when their page name is identified.
  const { rows: existingPages } = await query(
    `SELECT meta_page_id, id, page_name FROM brand_spy.brand_pages WHERE brand_id = $1`,
    [brandId],
  );
  let skippedMetaPages = 0;
  for (const row of existingPages) {
    if (!row.meta_page_id) continue;
    if (isMetaPlatformPage(row.page_name)) { skippedMetaPages++; continue; }
    pageCache.set(row.meta_page_id, row.id);
    if (row.page_name) pageNameCache.set(row.meta_page_id, row.page_name);
  }
  console.log(`[brand-spy] pre-loaded ${pageCache.size} known pages for "${domain}" (skipped ${skippedMetaPages} Meta platform pages)`);
  // Snapshot the pages known at scrape-start so Phase 2 can skip the expensive
  // ALL-status pass for them (their history is already in the DB). Only newly-
  // discovered pages (added during Phase 1) need a full ALL pass.
  const knownPageIds = new Set(pageCache.keys());

  // Pre-load all known domains (subdomains + cross-domains) from previous scrapes.
  // This allows Phase 1c to search subdomains discovered in earlier runs without
  // waiting for Phase 2 to re-discover them first.
  const { rows: knownDomainRows } = await query(
    `SELECT domain, domain_type FROM brand_spy.brand_domains WHERE brand_id = $1`,
    [brandId],
  );
  const knownSubdomains = knownDomainRows.filter(r => r.domain_type === 'subdomain').map(r => r.domain);
  if (knownSubdomains.length > 0) {
    console.log(`[brand-spy] pre-loaded ${knownSubdomains.length} known subdomains for "${domain}"`);
  }

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
      // Fast-fail: if any previous Phase 2 page was rate-limited (e.g. HTTP 431 from
      // ScrapeCreators /company/ads), skip remaining pages immediately without making
      // any API calls. Without this, each queued page would time-out (~90s × 3 retries)
      // before giving up, turning 27 pages into a ~40-minute stall.
      if (p2Blocked) {
        console.warn(`[brand-spy] phase-2 page ${metaPageId} skipped (endpoint blocked)`);
        return;
      }

      const pageName = pageNameCache.get(metaPageId) ?? null;
      const isMetaPage = isMetaPlatformPage(pageName);

      // Apply rootFragment link_url filter to ALL Phase 2 pages — not just Meta platform
      // pages. Pages like "USA Ready Families" run ads for multiple brands simultaneously
      // (thegreatproject.com AND tonicgympro.com). Without filtering, ALL their ads get
      // stored under this brand's ID, inflating active counts, polluting brand_domains
      // with unrelated domains, and triggering Phase 2 cascades on the wrong pages.
      //
      // Meta platform pages (Instagram for Business, etc.): strict — require link_url.
      //   No link_url on a Meta platform ad = system/promo content, exclude it.
      // Regular brand pages: allow ads with no link_url (benefit of the doubt — they were
      //   discovered because the page runs this brand's ads, so unlabelled ads are likely
      //   brand-related). Ads WITH a link_url must still contain rootFragment.
      const filterBatch = (batch) => batch.filter((ad) => {
        const url = (ad.snapshot?.link_url ?? '').toLowerCase();
        if (!url) return !isMetaPage;
        return url.includes(rootFragment.toLowerCase());
      });

      if (isMetaPage) {
        console.log(`[brand-spy] phase-2 page ${metaPageId} ("${pageName}") — Meta platform page, filtering to "${rootFragment}" ads only`);
      }

      // ACTIVE/US pass: always run — source of truth for is_active. Marks all currently
      // running ads true (everything else stays false from the reset at scrape-start).
      for await (const batch of sc.iterateCompanyAds({ pageId: metaPageId, status: 'ACTIVE', country: 'US', maxPages: 100 })) {
        creditsUsed += 1;
        const filtered = filterBatch(batch);
        if (filtered.length > 0) {
          const { d, u } = await upsertAdBatch(brandId, filtered, pageCache, metaPageId, crossDomains, pageNameCache);
          discovered += d; updated += u;
        }
      }

      // ALL/US pass: only run for pages discovered THIS run (not pre-loaded from DB).
      // Pre-known pages already have their full history in the DB — the ALL pass would
      // just re-iterate the same records (~half of Phase 2 time). New pages need it to
      // build their initial history. OR-semantics in UPSERT: is_active can only go
      // false→true within a run, never true→false.
      const isKnownPage = knownPageIds.has(metaPageId);
      if (!isKnownPage) {
        for await (const batch of sc.iterateCompanyAds({ pageId: metaPageId, status: 'ALL', country: 'US', maxPages: 100 })) {
          creditsUsed += 1;
          const filtered = filterBatch(batch);
          if (filtered.length > 0) {
            const { d, u } = await upsertAdBatch(brandId, filtered, pageCache, metaPageId, crossDomains, pageNameCache);
            discovered += d; updated += u;
          }
        }
      }
    } catch (p2Err) {
      // Phase 2 failures (e.g. 431 rate-limit from ScrapeCreators /company/ads endpoint)
      // are non-fatal. Phase 1 keyword searches already capture active ad counts accurately.
      // Set p2Blocked so all remaining queued workers skip immediately rather than timing out.
      p2Blocked = true;
      console.warn(`[brand-spy] phase-2 blocked after page ${metaPageId}: ${p2Err.message} — remaining pages will be skipped`);
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

  // Launch Phase 2 for all pre-loaded known pages immediately (in parallel with Phase 1).
  // New pages discovered by Phase 1 are also launched via launchNewPages() below.
  launchNewPages();

  // Phase 1a: active-only pass — captures every currently running ad regardless of
  // impression rank. This is the critical pass for matching Meta's "active ads" count.
  console.log(`[brand-spy] phase-1a: active-only keyword search for "${domain}" (US)`);
  for await (const batch of sc.iterateAdsByDomain({ domain, status: 'ACTIVE', country: 'US' })) {
    creditsUsed += 1;
    const { d, u } = await upsertAdBatch(brandId, batch, pageCache, null, crossDomains, pageNameCache);
    discovered += d; updated += u;
    launchNewPages();
  }
  console.log(`[brand-spy] phase-1a done: ${discovered} new, ${updated} updated, ${pageCache.size} pages, ${creditsUsed} credits`);

  // Phase 1b: all-status pass — discovers historical inactive ads and any pages not
  // yet found by the active-only pass (sorts by total_impressions, capped at 50 pages).
  console.log(`[brand-spy] phase-1b: all-status keyword search for "${domain}" (US)`);
  for await (const batch of sc.iterateAdsByDomain({ domain, status: 'ALL', country: 'US' })) {
    creditsUsed += 1;
    const { d, u } = await upsertAdBatch(brandId, batch, pageCache, null, crossDomains, pageNameCache);
    discovered += d; updated += u;
    launchNewPages();
  }
  console.log(`[brand-spy] phase-1 done: ${discovered} new, ${updated} updated, ${pageCache.size} pages, ${creditsUsed} credits`);

  // Phase 1d: rootFragment keyword search — catches ads whose link_url uses a subdomain
  // (e.g. shop.try-forge.com, secure.try-forge.com) that do NOT match the full domain
  // "try-forge.com" used in Phase 1a/b.
  //
  // WHY NEEDED: ScrapeCreators stores and matches the full hostname of each ad's
  // link_url. "try-forge.com" and "shop.try-forge.com" are indexed as separate domains;
  // a keyword_exact_phrase search for "try-forge.com" returns 0 results for a brand
  // whose ads all land on subdomains.  Searching the rootFragment "try-forge" (without
  // TLD) matches any URL containing that string, including all subdomains.
  //
  // SAFETY: before adding any page to pageCache, the batch is filtered to only ads
  // whose link_url contains rootFragment.  This prevents pages that mention "try-forge"
  // in ad copy (but link to a different domain) from being added.  Only pages that
  // actually advertise to try-forge.com URLs are enqueued for Phase 2.
  //
  // SKIP if rootFragment is too short (< 5 chars) — generic fragments cause too much
  // noise (e.g. "fit", "go", "app").
  if (rootFragment.length >= 5) {
    const p1dBefore = pageCache.size;
    const p1dIsFirstScrape = (p1dBefore === 0); // no pre-loaded pages → first discovery run
    // On re-scrapes, cap Phase 1d at 3 cursor pages — enough to surface any new pages
    // from the top impressions results without iterating the full 460-ad history.
    // Full iteration only needed on first discovery (no pages known yet).
    const p1dMaxPages = p1dIsFirstScrape ? 50 : 3;
    let p1dDiscovered = 0, p1dUpdated = 0, p1dNewPages = 0;
    console.log(`[brand-spy] phase-1d: rootFragment search for "${rootFragment}" (US active, maxPages=${p1dMaxPages})`);
    for await (const batch of sc.iterateAdsByDomain({ domain: rootFragment, status: 'ACTIVE', country: 'US', maxPages: p1dMaxPages })) {
      creditsUsed += 1;
      const filtered = batch.filter((ad) => {
        const url = (ad.snapshot?.link_url ?? ad.link_url ?? '').toLowerCase();
        return url.includes(rootFragment.toLowerCase());
      });
      if (filtered.length > 0) {
        const { d, u } = await upsertAdBatch(brandId, filtered, pageCache, null, crossDomains, pageNameCache);
        p1dDiscovered += d; p1dUpdated += u;
        launchNewPages();
      }
    }
    p1dNewPages = pageCache.size - p1dBefore;

    // ALL-status pass: only run on first scrape (pages unknown) or when ACTIVE just
    // found new pages (brand has grown). On re-scrapes with known pages, Phase 2's
    // ALL-status pass already covers historical inactive ads per page — the ALL pass
    // here would just re-iterate the same ads and waste ~50s.
    if (p1dIsFirstScrape || p1dNewPages > 0) {
      console.log(`[brand-spy] phase-1d: rootFragment search for "${rootFragment}" (US all-status)`);
      for await (const batch of sc.iterateAdsByDomain({ domain: rootFragment, status: 'ALL', country: 'US' })) {
        creditsUsed += 1;
        const filtered = batch.filter((ad) => {
          const url = (ad.snapshot?.link_url ?? ad.link_url ?? '').toLowerCase();
          return url.includes(rootFragment.toLowerCase());
        });
        if (filtered.length > 0) {
          const { d, u } = await upsertAdBatch(brandId, filtered, pageCache, null, crossDomains, pageNameCache);
          p1dDiscovered += d; p1dUpdated += u;
          launchNewPages();
        }
      }
    } else {
      console.log(`[brand-spy] phase-1d: skipping ALL pass (${p1dBefore} pages pre-loaded, no new pages found)`);
    }
    console.log(`[brand-spy] phase-1d done: ${p1dDiscovered} new, ${p1dUpdated} updated, ${pageCache.size - p1dBefore} new pages`);
    discovered += p1dDiscovered; updated += p1dUpdated;
  }

  // Phase 1.5: company-name search — always runs to discover FB pages not found via
  // domain keyword search (common when brands use subdomains, redirect URLs, or
  // tracking domains as ad destinations).
  //
  // IMPORTANT: we search only the FULL domain name (e.g. "try-forge"), NOT a
  // prefix-stripped variant (e.g. "forge"). Generic fragments like "forge" match
  // completely unrelated companies (Forge of Empires, Forge Men, Forgeurban…) and
  // cause Phase 2 to store their ads under the wrong brand.
  //
  // Relevance check uses normalised comparison so "Try Forge" matches "try-forge"
  // and "TryForge" matches "try-forge" regardless of hyphens/spaces.
  {
    const domainWithoutTld = domain.replace(/\.[a-z]{2,}(\.[a-z]{2})?$/, ''); // 'try-forge.com' → 'try-forge'
    // Use only the exact brand name — no prefix-stripped variants.
    const candidates = [domainWithoutTld].filter(c => c && c.length > 2);
    const pageSizeBefore = pageCache.size;
    console.log(`[brand-spy] phase-1.5: company-name search for [${candidates.join(', ')}] (${pageSizeBefore} pages known)`);

    // Normalised comparison: strip hyphens/underscores/spaces so "try-forge",
    // "try forge", "TryForge" all resolve to the same canonical token.
    const normalise = (s) => (s ?? '').toLowerCase().replace(/[-_\s]+/g, '');
    const normKeyword = normalise(domainWithoutTld);

    for (const name of candidates) {
      let result;
      try {
        result = await sc.searchCompanies(name);
        creditsUsed += 1;
      } catch (err) {
        console.error(`[brand-spy] phase-1.5 company search failed for "${name}":`, err.message);
        continue;
      }
      const pages = result?.searchResults ?? result?.results ?? result?.data ?? result?.companies ?? [];
      console.log(`[brand-spy] phase-1.5: "${name}" → ${pages.length} pages found`);
      let addedFromThisSearch = 0;
      for (const page of pages.slice(0, 10)) {
        const metaPageId = String(page.page_id ?? page.id ?? page.pageId ?? '');
        if (!metaPageId || p2Launched.has(metaPageId)) continue;
        const pageName = page.page_name ?? page.name ?? page.pageName ?? null;
        // Strict name-match filter: the page name (normalised) must contain the brand
        // keyword.  searchCompanies() is a TEXT search, not a domain search — querying
        // "try-forge" returns "NightForge", "CreativeForge", "Trying to forget you",
        // etc. because ScrapeCreators matches loose word fragments.  Without this gate,
        // every text-adjacent page gets added and Phase 2 runs on them for nothing.
        // Meta platform pages like "Instagram for Business" are correctly discovered
        // via Phase 1a/b (when keyword search finds their ads linking to the brand
        // domain) — they should NOT be added here via name fallback.
        const nameMatches = normalise(pageName).includes(normKeyword);
        if (!nameMatches) continue;
        const brandPageId = await upsertBrandPage(brandId, metaPageId, pageName, null);
        pageCache.set(metaPageId, brandPageId);
        if (pageName) pageNameCache.set(metaPageId, pageName);
        p2Launched.add(metaPageId);
        p2Promises.push(runPhase2Page(metaPageId));
        addedFromThisSearch++;
      }
      console.log(`[brand-spy] phase-1.5: "${name}" added ${addedFromThisSearch} pages`);
    }
    console.log(`[brand-spy] phase-1.5 done: ${pageCache.size} pages total`);
  }

  // Phase 1c: keyword searches for known SUBDOMAINS of the primary domain.
  // SKIP when Phase 1d ran (rootFragment.length >= 5): Phase 1d already searches
  // the rootFragment which matches all subdomain URLs, making per-subdomain searches
  // redundant.  Phase 1c only runs when Phase 1d is skipped (rootFragment too short,
  // e.g. "go", "fit") where explicit subdomain searches are the only coverage.
  const subdomainsToSearch = knownSubdomains.filter(d =>
    d && d !== domain && d.endsWith('.' + domain),
  );
  const phase1dRan = rootFragment.length >= 5;

  if (subdomainsToSearch.length > 0 && !phase1dRan) {
    console.log(`[brand-spy] phase-1c: keyword search for subdomains [${subdomainsToSearch.join(', ')}]`);
    for (const subDomain of subdomainsToSearch) {
      for await (const batch of sc.iterateAdsByDomain({ domain: subDomain, status: 'ACTIVE', country: 'US' })) {
        creditsUsed += 1;
        const { d, u } = await upsertAdBatch(brandId, batch, pageCache, null, crossDomains, pageNameCache);
        discovered += d; updated += u;
        launchNewPages();
      }
      for await (const batch of sc.iterateAdsByDomain({ domain: subDomain, status: 'ALL', country: 'US' })) {
        creditsUsed += 1;
        const { d, u } = await upsertAdBatch(brandId, batch, pageCache, null, crossDomains, pageNameCache);
        discovered += d; updated += u;
        launchNewPages();
      }
    }
    console.log(`[brand-spy] phase-1c done: ${discovered} new, ${updated} updated, ${pageCache.size} pages, ${creditsUsed} credits`);
  } else if (subdomainsToSearch.length > 0 && phase1dRan) {
    console.log(`[brand-spy] phase-1c: skipped (Phase 1d rootFragment search already covers subdomains)`);
  }

  // Await all Phase 2 workers (already running concurrently since Phase 1).
  // NOTE: we intentionally do NOT flush counters here (removed onPhase1Done mid-scrape
  // call) because the is_active reset at scrape-start zeros all ads — a mid-Phase-2
  // recompute would write 0 or a partial count to the brands table, which the UI
  // would then display as "0 active". Counters are flushed once at the very end.
  await Promise.all(p2Promises);
  console.log(`[brand-spy] phase-2 done: ${discovered} new, ${updated} updated, ${pageCache.size} pages, ${creditsUsed} credits`);

  // Phase 3: subdomain keyword search for subdomains discovered in this run.
  // After Phase 2 finishes, crossDomains contains all link_url domains seen in ads.
  // We search for TRUE SUBDOMAINS of the primary domain (*.primary-domain.com) that
  // were just discovered this run and not yet covered by Phase 1c.
  // NOTE: We restrict to subdomains ONLY. Expanding to arbitrary cross-domains (e.g.
  // balearicpostcards.com, blinkit.com) causes a runaway cascade: Phase 2 on Meta
  // platform pages stores ads for hundreds of brands, their link_urls pollute
  // crossDomains, and Phase 3 then finds and scrapes all those unrelated pages.
  const newSubdomains = [...crossDomains].filter(d =>
    d && d !== domain && d.endsWith('.' + domain) && !subdomainsToSearch.includes(d),
  );

  if (newSubdomains.length > 0) {
    console.log(`[brand-spy] phase-3: keyword search for newly-discovered subdomains [${newSubdomains.join(', ')}]`);
    for (const subDomain of newSubdomains) {
      for await (const batch of sc.iterateAdsByDomain({ domain: subDomain, status: 'ACTIVE', country: 'US' })) {
        creditsUsed += 1;
        const { d, u } = await upsertAdBatch(brandId, batch, pageCache, null, crossDomains, pageNameCache);
        discovered += d; updated += u;
        launchNewPages();
      }
      for await (const batch of sc.iterateAdsByDomain({ domain: subDomain, status: 'ALL', country: 'US' })) {
        creditsUsed += 1;
        const { d, u } = await upsertAdBatch(brandId, batch, pageCache, null, crossDomains, pageNameCache);
        discovered += d; updated += u;
        launchNewPages();
      }
    }
    // Await Phase 2 workers kicked off by Phase 3 subdomain pages
    await Promise.all(p2Promises);
    console.log(`[brand-spy] phase-3 done: total ${discovered} new, ${updated} updated, ${creditsUsed} credits`);
  }

  // Flush all discovered domains to brand_domains with correct classification.
  // Subdomains of the primary: shop.try-forge.com → 'subdomain'
  // Other domains: tonicgympro.com → 'cross'
  // This runs after Phase 3 so the full crossDomains Set is populated.
  for (const d of crossDomains) {
    if (!d) continue;
    let domainType;
    if (d === domain) {
      domainType = 'primary';
    } else if (d.endsWith('.' + domain)) {
      domainType = 'subdomain';
    } else {
      domainType = 'cross';
    }
    try {
      await upsertBrandDomain(brandId, d, domainType);
    } catch (err) {
      console.warn(`[brand-spy] upsertBrandDomain failed for "${d}":`, err.message);
    }
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

async function recomputeDomainRollup(brandId, primaryDomain) {
  await query(
    `INSERT INTO brand_spy.brand_domains (brand_id, domain, domain_type, active_ads_count, total_ads_count, last_seen_at)
     SELECT
       $1 AS brand_id,
       lower(split_part(regexp_replace(link_url, '^https?://(www\\.)?', ''), '/', 1)) AS domain,
       CASE
         WHEN lower(split_part(regexp_replace(link_url, '^https?://(www\\.)?', ''), '/', 1)) = $2 THEN 'primary'
         WHEN $2 IS NOT NULL AND lower(split_part(regexp_replace(link_url, '^https?://(www\\.)?', ''), '/', 1)) LIKE '%.' || $2 THEN 'subdomain'
         ELSE 'cross'
       END AS domain_type,
       COUNT(*) FILTER (WHERE is_active) AS active_ads_count,
       COUNT(*) AS total_ads_count,
       NOW() AS last_seen_at
     FROM brand_spy.ads
     WHERE brand_id = $1 AND link_url IS NOT NULL AND link_url <> ''
     GROUP BY domain
     ON CONFLICT (brand_id, domain) DO UPDATE SET
       domain_type      = EXCLUDED.domain_type,
       active_ads_count = EXCLUDED.active_ads_count,
       total_ads_count  = EXCLUDED.total_ads_count,
       last_seen_at     = NOW()`,
    [brandId, primaryDomain ?? null],
  );
  await query(
    `UPDATE brand_spy.brand_domains
        SET is_primary = (domain = $2)
      WHERE brand_id = $1`,
    [brandId, primaryDomain ?? null],
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
