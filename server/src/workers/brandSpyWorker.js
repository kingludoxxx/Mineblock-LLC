/**
 * Brand Spy — scrape worker + tier scoring
 */

import { query } from '../config/db.js';
import { withTransaction, recomputeBrandCounters } from '../db/brandSpyDb.js';
import { getScrapeCreatorsClient, ScrapeCreatorsError } from '../services/scrapeCreators.js';

// ---------------------------------------------------------------------------
// Resilience: per-brand scrape lock + graceful-shutdown coordination
// ---------------------------------------------------------------------------

// Tracks which brands have a scrape in progress within this process.
// Prevents a cron/auto-scrape from racing with a manual scrape on the same
// brand — concurrent runs would interleave is_active writes and produce
// inconsistent end-of-scrape sweeps.
const activeScrapes = new Set();

// Set to true when SIGTERM is received so in-flight scrapes can bail out
// cleanly after their current API call rather than being hard-killed mid-reset.
let shutdownRequested = false;

/** Signal from server.js: a deploy is happening, wrap up current phases ASAP. */
export function requestShutdown() {
  shutdownRequested = true;
  console.log('[brand-spy] shutdown requested — in-flight scrapes will stop after current phase');
}

/**
 * Called on every server boot.
 * Finds brands left in RUNNING or INTERRUPTED state by a previous deploy that
 * killed a scrape mid-flight, resets their status to PENDING, and returns their
 * IDs so the caller can re-queue them immediately.
 */
export async function recoverStuckScrapes() {
  try {
    // Only recover brands stuck >2h. Without this guard, every deploy SIGTERMs
    // an in-flight scrape and the next boot's recovery immediately re-runs it
    // — burning credits on partial work the user is about to manually refresh
    // anyway. 2h cooldown lets back-to-back deploys settle without re-scraping.
    const { rows } = await query(
      `SELECT id FROM brand_spy.brands
        WHERE last_scrape_status IN ('RUNNING', 'INTERRUPTED')
          AND (last_scraped_at IS NULL OR last_scraped_at < NOW() - INTERVAL '2 hours')`,
    );
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    console.log(`[brand-spy] boot recovery: ${ids.length} brand(s) stuck > 2h — re-queuing: ${ids.join(', ')}`);
    await query(
      `UPDATE brand_spy.brands SET last_scrape_status = 'PENDING', last_scrape_error = NULL
       WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    // Also close any dangling RUNNING scrape_jobs so the log stays clean.
    await query(
      `UPDATE brand_spy.scrape_jobs SET status = 'INTERRUPTED', finished_at = NOW()
       WHERE brand_id = ANY($1::uuid[]) AND status = 'RUNNING'`,
      [ids],
    );
    return ids;
  } catch (err) {
    console.error('[brand-spy] boot recovery failed:', err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tier engine (pure functions)
// ---------------------------------------------------------------------------

// BANGER tier window: ad must be at LEAST 3 days old (so we have multiple
// scrape snapshots confirming it sustained top-3% rank, not a 1-day spike)
// and AT MOST 10 days old (the "explosive growth" definition). Ads under
// 3 days that rank top-3% fall through to CHAMP/A — they're still flagged
// as fast climbers via velocity, but can't claim BANGER until sustained.
// BANGER tier — the recent ad that's scaling fastest.
// We compute the BANGER percentile INSIDE the recent-age window rather than
// against the whole pool. Previously a brand whose top 3% by impressions
// were all 80+ day-old ads literally couldn't crown a BANGER, no matter how
// well a 5-day-old ad performed. The new rule: among ads aged
// [MIN_AGE, MAX_AGE), the top BANGER_PERCENTILE_OF_WINDOW are BANGERs.
const BANGER_MIN_AGE_DAYS         = 3;
const BANGER_AGE_DAYS             = 14;
const BANGER_PERCENTILE_OF_WINDOW = 0.20;
// Legacy whole-pool cap kept as a sanity ceiling so a tiny age window with
// only 1 ad doesn't auto-crown a TEST-tier ad as BANGER. An ad must STILL
// be in the top 10% of all active ads by impressions to qualify.
const BANGER_PERCENTILE   = 0.10;
const CHAMP_PERCENTILE  = 0.10;
const A_PERCENTILE      = 0.25;
const B_PERCENTILE      = 0.50;
const C_PERCENTILE      = 0.75;
const MID_PERCENTILE    = 0.90;

// Tier-priority used for the final league-rank ordering. Lower = better.
const TIER_PRIORITY = { BANGER: 1, CHAMP: 2, A: 3, B: 4, C: 5, MID: 6, TEST: 7 };

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
  const bangerWholeCap = Math.max(1, Math.ceil(poolSize * BANGER_PERCENTILE));

  // BANGER eligibility within the recent-age window. Without this, a brand
  // dominated by old top-impression ads literally couldn't crown a BANGER
  // because no fresh ad cracks the global top 3%.
  const ageWindow = active.filter(isBangerAgeEligible);
  ageWindow.sort((a, b) => (a.impressionRank ?? Infinity) - (b.impressionRank ?? Infinity));
  // (ad → impressionRank not assigned yet; sort by meta_rank order — index
  //  in the parent `active` array is already that order.)
  const bangerWindowCap = Math.max(1, Math.ceil(ageWindow.length * BANGER_PERCENTILE_OF_WINDOW));
  const bangerIds = new Set();
  let bangerCount = 0;
  for (const ad of active) {
    if (!isBangerAgeEligible(ad)) continue;
    // active is in meta_rank order, so iterating it gives ad-order asc.
    // First N age-eligible ads up to bangerWindowCap AND inside global top 10%.
    if (bangerCount >= bangerWindowCap) break;
    const impressionRankApprox = active.indexOf(ad) + 1;
    if (impressionRankApprox > bangerWholeCap) continue;
    bangerIds.add(ad.adArchiveId ?? ad.id);
    bangerCount++;
  }

  // Step 1 — Assign each active ad an *impression rank* (idx+1 after the
  // SQL ORDER BY meta_rank ASC). This is the percentile basis for the
  // tier label below; it is NOT what we display as the user-facing rank.
  const withTier = active.map((ad, idx) => {
    const impressionRank = idx + 1;
    let tier;
    if (bangerIds.has(ad.adArchiveId ?? ad.id))       tier = 'BANGER';
    else if (impressionRank <= champEnd)              tier = 'CHAMP';
    else if (impressionRank <= aEnd)                  tier = 'A';
    else if (impressionRank <= bEnd)                  tier = 'B';
    else if (impressionRank <= cEnd)                  tier = 'C';
    else if (impressionRank <= midEnd)                tier = 'MID';
    else                                              tier = 'TEST';
    return { ...ad, impressionRank, tier };
  });

  // Step 2 — Re-order by tier priority (BANGER first, then CHAMP, then A,
  // B, C, MID, TEST). Within each tier, keep the impression-rank order
  // (best impressions of that tier first). Assign the displayed `rank` as
  // the position in this league-ordered array.
  withTier.sort((a, b) => {
    const ta = TIER_PRIORITY[a.tier] ?? 99;
    const tb = TIER_PRIORITY[b.tier] ?? 99;
    if (ta !== tb) return ta - tb;
    return a.impressionRank - b.impressionRank;
  });

  const ranked = withTier.map((ad, idx) => ({
    ...ad,
    rank: idx + 1,
    poolSize,
  }));

  return [...ranked, ...inactive.map((a) => ({ ...a, rank: null, poolSize, tier: null }))];
}

function isBangerAgeEligible(ad) {
  return ad.activeDays !== null
    && ad.activeDays >= BANGER_MIN_AGE_DAYS
    && ad.activeDays <  BANGER_AGE_DAYS
    && ad.isActive;
}
// Backwards-compat shim — the pool=1 fast path still asks "is this a banger?".
function isBanger(ad) { return isBangerAgeEligible(ad); }

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

function computeVelocity({ currentRank, rank7d, rank21d, activeDays }) {
  // Velocity is meaningless when the ad is younger than the lookback window
  // — there's no rank to compare against because the ad didn't exist N days
  // ago. The historical snapshot table may still have a row (e.g. inserted
  // at first-seen) but it doesn't represent a real position.
  const ageDays = activeDays ?? null;
  return {
    velocity7d:
      currentRank !== null && rank7d !== null && (ageDays === null || ageDays >= 7)
        ? rank7d - currentRank
        : null,
    velocity21d:
      currentRank !== null && rank21d !== null && (ageDays === null || ageDays >= 21)
        ? rank21d - currentRank
        : null,
  };
}

// ---------------------------------------------------------------------------
// Score brand (rank + tier + snapshots)
// ---------------------------------------------------------------------------

export async function scoreBrand(brandId) {
  return withTransaction(async (client) => {
    // Ranking signal: meta_rank ASC (Meta's impression rank — captured during
    // Phase 1d from ScrapeCreators' sort_by=total_impressions results). Lower
    // meta_rank = more impressions = better. Ads not seen in Phase 1d's
    // top-90 window have NULL meta_rank and fall to the tail (NULLS LAST),
    // ordered by total_active_time as a secondary signal.
    //
    // This is what makes BANGER actually work: it's "young ad already in the
    // top X positions by impressions" — exactly what the Meta Ad Library
    // surfaces when you sort by impressions DESC.
    const adsRes = await client.query(
      `SELECT id, ad_archive_id, is_active, start_date, active_days, total_active_time, last_seen_at
         FROM brand_spy.ads WHERE brand_id = $1
         ORDER BY is_active            DESC,
                  meta_rank            ASC  NULLS LAST,
                  total_active_time    DESC NULLS LAST,
                  last_seen_at         DESC`,
      [brandId],
    );

    if (!adsRes.rows.length) return { poolSize: 0, tierBreakdown: {}, snapshotsWritten: 0 };

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

    // ---------------------------------------------------------------------------
    // Bulk UPDATE ads — chunked to stay under PostgreSQL's 65535 param limit.
    // Each row has AD_UPDATE_COLS=10 params. Max rows per batch: 65535/10 = 6553.
    // We use 500 rows/batch (5000 params) for headroom and predictable latency.
    // ---------------------------------------------------------------------------
    const AD_UPDATE_COLS = 10; // id, cr, r3, r7, r21, v7d, v21d, ps, tier, ts
    const BULK_CHUNK     = 500;

    // Pre-compute all param rows so we can slice them cleanly per chunk.
    const updateRows = ranked.map((r) => {
      const hist = historical.get(r.adArchiveId) ?? { d3: null, d7: null, d21: null };
      const { velocity7d, velocity21d } = computeVelocity({
        currentRank: r.rank,
        rank7d:  hist.d7,
        rank21d: hist.d21,
        activeDays: r.activeDays,
      });
      const tierScore = r.rank !== null ? (r.poolSize - r.rank + 1) : null;
      return [r.id, r.rank, hist.d3, hist.d7, hist.d21, velocity7d, velocity21d, r.poolSize, r.tier, tierScore];
    });

    for (let i = 0; i < updateRows.length; i += BULK_CHUNK) {
      const chunk = updateRows.slice(i, i + BULK_CHUNK);
      const placeholders = chunk.map((_, j) => {
        const b = j * AD_UPDATE_COLS + 1;
        return `($${b}::uuid,$${b+1}::integer,$${b+2}::integer,$${b+3}::integer,$${b+4}::integer,$${b+5}::integer,$${b+6}::integer,$${b+7}::integer,$${b+8}::text,$${b+9}::integer)`;
      });
      await client.query(
        `UPDATE brand_spy.ads AS a SET
           current_rank    = v.cr,
           rank_3d         = v.r3,
           rank_7d         = v.r7,
           rank_21d        = v.r21,
           velocity_7d     = v.v7d,
           velocity_21d    = v.v21d,
           pool_size       = v.ps,
           tier            = v.tier,
           tier_score      = v.ts,
           tier_updated_at = NOW()
         FROM (VALUES ${placeholders.join(',')})
           AS v(id, cr, r3, r7, r21, v7d, v21d, ps, tier, ts)
         WHERE a.id = v.id`,
        chunk.flat(),
      );
    }

    // ---------------------------------------------------------------------------
    // Bulk INSERT snapshots — chunked to stay under 65535 param limit.
    // ON CONFLICT DO NOTHING prevents duplicate snapshots if scoreBrand is
    // called twice within the same second (e.g. retry after transient deadlock).
    // ---------------------------------------------------------------------------
    const snapshotRows = ranked.filter((r) => r.rank !== null && r.tier !== null);
    let snapshotsWritten = 0;
    if (snapshotRows.length > 0) {
      const SNAP_COLS  = 6; // brandId, adId, archiveId, rank, poolSize, tier
      const SNAP_CHUNK = 500; // 6 cols × 500 = 3000 params/batch

      for (let i = 0; i < snapshotRows.length; i += SNAP_CHUNK) {
        const chunk = snapshotRows.slice(i, i + SNAP_CHUNK);
        const snapPlaceholders = chunk.map((_, j) => {
          const b = j * SNAP_COLS + 1;
          return `($${b}::uuid,$${b+1}::uuid,$${b+2},$${b+3}::integer,$${b+4}::integer,$${b+5}::text,TRUE)`;
        });
        const snapParams = chunk.flatMap((r) => [brandId, r.id, r.adArchiveId, r.rank, r.poolSize, r.tier]);
        await client.query(
          `INSERT INTO brand_spy.ad_rank_snapshots (brand_id, ad_id, ad_archive_id, rank, pool_size, tier, is_active)
           VALUES ${snapPlaceholders.join(',')}
           ON CONFLICT DO NOTHING`,
          snapParams,
        );
        snapshotsWritten += chunk.length;
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
  // Snapshot windows for historical rank lookup.
  // halfWidthDays = centerDays so lower = max(0, center-half) = 0 for all windows.
  // This means the query searches from NOW() back to upper days ago, and the
  // ORDER BY picks whichever snapshot is CLOSEST to centerDays.
  //
  // Behaviour over time:
  //   Day 0 (just started): all three windows find the same "oldest available"
  //     snapshot (from the previous scrape run, minutes/hours ago). d3=d7=d21
  //     all show the same prior rank → velocity reflects change since last scrape.
  //   Day 3+:  d3 finds a genuine ~3-day-old snapshot; d7/d21 still use best available.
  //   Day 7+:  d3 finds 3-day, d7 finds 7-day; d21 uses best available.
  //   Day 21+: all three find their ideal historical snapshots.
  //
  // This ensures velocity columns are ALWAYS populated after at least two scrapes,
  // and progressively improve in accuracy as more snapshot history accumulates.
  const windows = [
    { key: 'd3',  centerDays: 3,  halfWidthDays: 3  },  // 0–6 days ago
    { key: 'd7',  centerDays: 7,  halfWidthDays: 7  },  // 0–14 days ago
    { key: 'd21', centerDays: 21, halfWidthDays: 21 },  // 0–42 days ago
  ];

  for (const w of windows) {
    // lower = center - halfWidth (e.g. 3-2=1 for d3) — the most-recent end of the window.
    // upper = center + halfWidth (e.g. 3+2=5 for d3) — the oldest end of the window.
    // Bug fix: was passing centerDays as $2 (newer bound) instead of lower, which made
    // the actual range center→upper (3-5d) instead of lower→upper (1-5d) as intended.
    const lower = Math.max(0, w.centerDays - w.halfWidthDays);
    const upper = w.centerDays + w.halfWidthDays;
    const { rows } = await client.query(
      `SELECT DISTINCT ON (ad_archive_id) ad_archive_id, rank
         FROM brand_spy.ad_rank_snapshots
        WHERE brand_id = $1
          AND snapshot_at BETWEEN NOW() - ($3::text || ' days')::INTERVAL
                              AND NOW() - ($2::text || ' days')::INTERVAL
        ORDER BY ad_archive_id,
                 ABS(EXTRACT(EPOCH FROM (NOW() - snapshot_at - ($4::text || ' days')::INTERVAL)))`,
      [brandId, lower.toString(), upper.toString(), w.centerDays.toString()],
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
  // Guard: skip duplicate concurrent scrapes on the same brand.
  if (activeScrapes.has(brandId)) {
    console.log(`[brand-spy] scrape for ${brandId} already running — skipping (trigger: ${trigger})`);
    return { jobId: null, status: 'SKIPPED', pagesDiscovered: 0, adsDiscovered: 0, adsUpdated: 0, creditsUsed: 0 };
  }
  activeScrapes.add(brandId);
  try {

  const sc = scClient ?? getScrapeCreatorsClient();

  // Pre-flight: refuse to start if the upstream account is already out of
  // credits. Without this, runBrandScrape would burn the first 5-10 credits
  // attempting Phase 1 calls before they fail with the "no credits" error.
  // /account/credit-balance is itself free at ScrapeCreators.
  try {
    const balance = await sc.getCreditBalance();
    const remaining = balance?.creditCount;
    if (typeof remaining === 'number' && remaining <= 0) {
      throw new ScrapeCreatorsError(
        `Out of credits (balance: ${remaining}). Top up at https://app.scrapecreators.com to resume scraping.`,
        402, 'NO_CREDITS', false,
      );
    }
    console.log(`[brand-spy] pre-flight: ${remaining} credits remaining`);
  } catch (e) {
    if (e instanceof ScrapeCreatorsError && e.code === 'NO_CREDITS') throw e;
    // Balance fetch failed for some other reason — proceed; real calls will surface the actual error
    console.warn(`[brand-spy] pre-flight balance check failed, proceeding anyway: ${e.message}`);
  }

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

    let scoreBrandError = null;
    try {
      console.log(`[brand-spy] scoreBrand starting for ${brand.id} (${brand.domain})`);
      // Retry on deadlock (40P01) — can occur when concurrent brand scrapes contend on
      // shared B-tree index pages. Back off exponentially between attempts.
      const MAX_SCORE_RETRIES = 3;
      for (let attempt = 1; attempt <= MAX_SCORE_RETRIES; attempt++) {
        try {
          await scoreBrand(brand.id);
          break; // success
        } catch (scoreErr) {
          if (scoreErr?.code === '40P01' && attempt < MAX_SCORE_RETRIES) {
            const backoffMs = attempt * 2000;
            console.warn(`[brand-spy] scoreBrand deadlock for ${brand.id}, retry ${attempt}/${MAX_SCORE_RETRIES} in ${backoffMs}ms`);
            await new Promise((r) => setTimeout(r, backoffMs));
          } else {
            throw scoreErr;
          }
        }
      }
      console.log(`[brand-spy] scoreBrand done for ${brand.id}`);
    } catch (scoreErr) {
      scoreBrandError = `scoreBrand: ${scoreErr?.message ?? String(scoreErr)}`;
      console.error(`[brand-spy] scoreBrand FAILED for ${brand.id}:`, scoreErr?.message, scoreErr?.stack);
    }

    await query(
      `UPDATE brand_spy.scrape_jobs
          SET status = 'DONE', finished_at = NOW(),
              pages_discovered = $2, ads_discovered = $3, ads_updated = $4, credits_used = $5
        WHERE id = $1`,
      [jobId, pagesDiscovered, stats.discovered, stats.updated, creditsUsed],
    );
    // Preserve scoreBrand error if scoring failed — don't overwrite with NULL.
    // Clear it only when scoring also succeeded so the error stays visible via the API.
    await query(
      `UPDATE brand_spy.brands
          SET last_scraped_at = NOW(), last_scrape_status = 'DONE', last_scrape_error = $2
        WHERE id = $1`,
      [brand.id, scoreBrandError],
    );

    return { jobId, status: 'DONE', pagesDiscovered, adsDiscovered: stats.discovered, adsUpdated: stats.updated, creditsUsed, scoreBrandError };
  } catch (err) {
    const isShutdown  = err?.isShutdown === true;
    const jobStatus   = isShutdown ? 'INTERRUPTED' : 'ERROR';
    const message     = isShutdown
      ? 'Server shutdown during scrape'
      : err instanceof ScrapeCreatorsError ? `${err.code}: ${err.message}`
        : err instanceof Error ? err.message
        : 'Unknown error';

    await query(
      `UPDATE brand_spy.scrape_jobs SET status = $2, finished_at = NOW(), error_message = $3, credits_used = $4 WHERE id = $1`,
      [jobId, jobStatus, message, creditsUsed],
    );
    await query(
      `UPDATE brand_spy.brands SET last_scrape_status = $2, last_scrape_error = $3 WHERE id = $1`,
      [brand.id, jobStatus, isShutdown ? null : message],
    );

    return { jobId, status: jobStatus, pagesDiscovered: 0, adsDiscovered: 0, adsUpdated: 0, creditsUsed, errorMessage: message };
  }

  } finally {
    activeScrapes.delete(brandId);
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
const AD_COLS = 21;  // 20 existing + meta_rank (impression position from Meta)

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

// Returns true if link_url's hostname is exactly the primary domain OR a direct subdomain.
// e.g. primaryDomain='thegreatproject.com':
//   try.thegreatproject.com  → true  (subdomain)
//   thegreatproject.com      → true  (exact)
//   thegreatprojects.com     → false (different SLD — different company)
//   try-melina.com           → false (unrelated)
// String-contains would wrongly match 'thegreatprojects.com' for rootFragment 'thegreatproject'.
// Hostname comparison enforces a hard domain boundary.
function linkBelongsToBrand(url, primaryDomain) {
  const host = extractDomain(url);
  if (!host) return false;
  return host === primaryDomain || host.endsWith('.' + primaryDomain);
}

// crossDomains: optional Set — collects link_url domains seen in this batch
// pageNameCache: optional Map — populated with metaPageId → pageName for Phase 2 filtering
// metaRankStart: optional integer — if provided, each ad in `ads` gets a meta_rank
//   value equal to metaRankStart + array index. ScrapeCreators returns ads sorted
//   by total_impressions DESC, so this captures Meta's impression rank per brand.
async function upsertAdBatch(brandId, ads, pageCache, pageIdFallback = null, crossDomains = null, pageNameCache = null, metaRankStart = null) {
  if (!ads.length) return { d: 0, u: 0 };

  // Resolve page IDs (may upsert new pages) before entering bulk transaction
  const rows = [];
  for (let i = 0; i < ads.length; i++) {
    const ad = ads[i];
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
    // Meta returns `end_date` for ACTIVE ads too — usually a sentinel matching
    // the scrape day or the ad's scheduled stop time. For our model
    // `end_date` should only be set when the ad has actually ended; an
    // ACTIVE ad has no end yet. Force NULL when active so the UI's
    // "Oct 24, 2024 — May 27, 2026" range doesn't render a fake end day.
    const isActive   = !!ad.is_active;
    const endDate    = isActive
      ? null
      : (ad.end_date ? new Date(ad.end_date * 1000) : null);
    const activeDays = computeActiveDays(startDate, endDate, isActive);
    const metaRank   = (metaRankStart != null) ? (metaRankStart + i) : null;

    rows.push([
      brandId, brandPageId, ad.ad_archive_id, metaPageId,
      isActive, startDate, endDate, ad.total_active_time ?? null, activeDays,
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
      metaRank,
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
         collation_id, collation_count, raw_snapshot, meta_rank
       ) VALUES ${placeholders}
       ON CONFLICT (brand_id, ad_archive_id) DO UPDATE SET
         is_active         = EXCLUDED.is_active,
         -- end_date semantics:
         --   • Ad is currently active → end_date must be NULL. Explicitly
         --     wipe any stale stamp the old worker left behind.
         --   • Ad is currently inactive → take the new value if Meta gave
         --     us one; otherwise keep what we already recorded.
         end_date          = CASE
                               WHEN EXCLUDED.is_active THEN NULL
                               ELSE COALESCE(EXCLUDED.end_date, brand_spy.ads.end_date)
                             END,
         total_active_time = EXCLUDED.total_active_time,
         active_days       = EXCLUDED.active_days,
         -- Only refresh last_seen_at when we observe the ad serving. Pulsing
         -- it on inactive scrapes makes any "last_seen >= now() - 2 days"
         -- freshness heuristic match every ad we ever scraped.
         last_seen_at      = CASE
                               WHEN EXCLUDED.is_active THEN NOW()
                               ELSE brand_spy.ads.last_seen_at
                             END,
         raw_snapshot      = EXCLUDED.raw_snapshot,
         meta_rank         = COALESCE(EXCLUDED.meta_rank, brand_spy.ads.meta_rank)
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

  // Shutdown guard: if SIGTERM was received before we even started, bail out.
  if (shutdownRequested) throw Object.assign(new Error('Shutdown requested before scrape start'), { isShutdown: true });

  // Capture scrape start time from the DB clock so the end-of-scrape sweep can
  // identify which ads were touched this run (every upsert sets last_seen_at = NOW()).
  // Any ad with last_seen_at < scrapeStartedAt at the end was not seen → mark inactive.
  // Deferred reset (instead of a pre-reset) means a mid-scrape failure preserves the
  // previous run's is_active values rather than wiping them to FALSE and leaving the
  // DB in a half-state with stale tier values.
  const { rows: [{ now: scrapeStartedAt }] } = await query(`SELECT NOW() AS now`);
  console.log(`[brand-spy] scrape start sentinel ${scrapeStartedAt.toISOString()} for "${domain}"`);

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

  // First-scrape vs re-scrape branch.
  //
  // First scrape (no pages yet): bootstrap full history. We need both the
  //   ACTIVE and ALL passes across keyword search + per-page so the DB starts
  //   with every ad the brand has ever run.
  //
  // Re-scrape (≥1 known page): the DB already holds history. All we need is
  //   (a) refresh which ads are still active, and (b) discover any new pages.
  //   Per-page ACTIVE pass on every known page is the ground truth for (a) and
  //   automatically picks up newly-launched ads. Phase 1d ACTIVE with maxPages=3
  //   handles (b) cheaply. Every other ALL-status pass would re-fetch data we
  //   already have — pure waste. Gating those phases here cuts ~70% of credits
  //   on the daily auto-scrape and the manual Refresh button.
  const isFirstScrape = knownPageIds.size === 0;
  console.log(`[brand-spy] ${isFirstScrape ? 'FIRST SCRAPE' : 'RE-SCRAPE'} for "${domain}" — ${knownPageIds.size} known pages`);

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
      if (p2Blocked || shutdownRequested) {
        console.warn(`[brand-spy] phase-2 page ${metaPageId} skipped (${shutdownRequested ? 'shutdown' : 'endpoint blocked'})`);
        return;
      }

      // Dead-page skip: known pages that returned 0 active ads on the last
      // Phase 2 ACTIVE check are re-checked once a week instead of every
      // scrape. Saves ~1 credit per dead page per scrape (16-page brands
      // with 10 dead pages → ~10 credits saved per re-scrape).
      // Brand-new pages (added by Phase 1 during this run) have NULL
      // last_active_check_at so this check naturally falls through.
      if (knownPageIds.has(metaPageId)) {
        const brandPageId = pageCache.get(metaPageId);
        if (brandPageId) {
          const { rows } = await query(
            `SELECT active_ads_count, last_active_check_at
               FROM brand_spy.brand_pages WHERE id = $1`,
            [brandPageId],
          );
          const p = rows[0];
          const fresh = p?.last_active_check_at
            && (Date.now() - new Date(p.last_active_check_at).getTime()) < 6 * 86400000;
          if (p && p.active_ads_count === 0 && fresh) {
            console.log(`[brand-spy] phase-2 page ${metaPageId}: SKIP (dead — 0 active, last check < 6d ago)`);
            return;
          }
        }
      }

      const pageName = pageNameCache.get(metaPageId) ?? null;
      const isMetaPage = isMetaPlatformPage(pageName);

      // Apply strict domain filter to ALL Phase 2 pages.
      // Uses linkBelongsToBrand() — exact hostname match (hostname === domain OR
      // hostname.endsWith('.'+domain)) — NOT string-contains on rootFragment.
      // String-contains wrongly matches sibling domains: searching 'thegreatproject'
      // would include ads from 'thegreatprojects.com' (a different company).
      // Hostname boundary check excludes those while still accepting all subdomains
      // (try.thegreatproject.com, shop.try-forge.com, secure.try-forge.com, etc.).
      //
      // Meta platform pages (Instagram for Business, etc.): strict — require link_url.
      //   No link_url on a Meta platform ad = system/promo content, exclude it.
      // Regular brand pages: allow ads with no link_url (benefit of the doubt — they were
      //   discovered because the page runs this brand's ads, so unlabelled ads are likely
      //   brand-related). Ads WITH a link_url must pass linkBelongsToBrand.
      const filterBatch = (batch) => batch.filter((ad) => {
        const url = ad.snapshot?.link_url ?? '';
        if (!url) return !isMetaPage;
        return linkBelongsToBrand(url, domain);
      });

      if (isMetaPage) {
        console.log(`[brand-spy] phase-2 page ${metaPageId} ("${pageName}") — Meta platform page, filtering to "${rootFragment}" ads only`);
      }

      // ACTIVE/US pass: always run — source of truth for is_active. Marks all currently
      // running ads true; any ad NOT seen this run is swept to false by the end-of-scrape
      // deferred-reset (last_seen_at < scrapeStartedAt).
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
      // build their initial history. The ACTIVE pass above already wrote the correct
      // is_active=TRUE for currently-live ads; ALL fills in the historical inactives.
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

      // Mark this page as freshly checked — drives the dead-page skip on the
      // next scrape. Only updates on successful Phase 2 ACTIVE; failed pages
      // (p2Blocked) leave last_active_check_at unchanged so they're retried.
      const brandPageId = pageCache.get(metaPageId);
      if (brandPageId) {
        await query(
          `UPDATE brand_spy.brand_pages SET last_active_check_at = NOW() WHERE id = $1`,
          [brandPageId],
        );
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

  // Phase 1a/1b: keyword-search the full domain. ONLY runs on first scrape when
  // Phase 1d (rootFragment) cannot run because rootFragment is too short
  // (<5 chars, e.g. "fit", "go"). When Phase 1d does run it catches everything
  // 1a/1b would, plus subdomain ads — so 1a/1b would be pure duplicate work.
  // On re-scrapes we skip entirely; per-page Phase 2 ACTIVE refreshes is_active.
  if (isFirstScrape && rootFragment.length < 5) {
    console.log(`[brand-spy] phase-1a: active-only keyword search for "${domain}" (US) — rootFragment too short for Phase 1d`);
    for await (const batch of sc.iterateAdsByDomain({ domain, status: 'ACTIVE', country: 'US' })) {
      creditsUsed += 1;
      const { d, u } = await upsertAdBatch(brandId, batch, pageCache, null, crossDomains, pageNameCache);
      discovered += d; updated += u;
      launchNewPages();
    }
    console.log(`[brand-spy] phase-1a done: ${discovered} new, ${updated} updated, ${pageCache.size} pages, ${creditsUsed} credits`);
    if (shutdownRequested) { p2Blocked = true; throw Object.assign(new Error('Shutdown requested after phase-1a'), { isShutdown: true }); }

    console.log(`[brand-spy] phase-1b: all-status keyword search for "${domain}" (US)`);
    for await (const batch of sc.iterateAdsByDomain({ domain, status: 'ALL', country: 'US' })) {
      creditsUsed += 1;
      const { d, u } = await upsertAdBatch(brandId, batch, pageCache, null, crossDomains, pageNameCache);
      discovered += d; updated += u;
      launchNewPages();
    }
    console.log(`[brand-spy] phase-1 done: ${discovered} new, ${updated} updated, ${pageCache.size} pages, ${creditsUsed} credits`);
    if (shutdownRequested) { p2Blocked = true; throw Object.assign(new Error('Shutdown requested after phase-1b'), { isShutdown: true }); }
  } else {
    console.log(`[brand-spy] phase-1a/1b: skipped (${isFirstScrape ? 'Phase 1d covers it' : 're-scrape; per-page Phase 2 ACTIVE is sufficient'})`);
  }

  // Phase 1d adaptive skip on re-scrape:
  //
  // Phase 1d's purpose on re-scrape is to discover NEW FB pages we don't yet
  // know about. For a brand whose page set has been stable for 14+ days AND
  // was scraped less than 23h ago, running 1d every refresh is wasted credits
  // — the page set isn't changing. Skip it; the next auto-scrape (24h cadence)
  // will re-probe.
  //
  // First-scrape never hits this branch (no known pages).
  // The 23h gate ensures the daily auto-scrape always probes for new pages.
  // The 14-day "stable" gate ensures we don't skip too aggressively on
  // freshly-onboarded brands whose page set is still expanding.
  let skipPhase1d = false;
  if (!isFirstScrape) {
    const { rows } = await query(
      `SELECT
         b.last_scraped_at,
         (SELECT MAX(first_seen_at) FROM brand_spy.brand_pages WHERE brand_id = b.id) AS last_new_page_at
       FROM brand_spy.brands b WHERE b.id = $1`,
      [brandId],
    );
    const r = rows[0];
    if (r?.last_scraped_at && r?.last_new_page_at) {
      const hoursSinceScrape = (Date.now() - new Date(r.last_scraped_at).getTime()) / 3600000;
      const daysSinceNewPage = (Date.now() - new Date(r.last_new_page_at).getTime()) / 86400000;
      if (hoursSinceScrape < 23 && daysSinceNewPage > 14) {
        skipPhase1d = true;
        console.log(`[brand-spy] phase-1d: SKIP (page set stable for ${daysSinceNewPage.toFixed(0)}d, last scrape ${hoursSinceScrape.toFixed(1)}h ago — next auto-scrape will probe)`);
      }
    }
  }

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
  // noise (e.g. "fit", "go", "app"). Also skip if the adaptive-skip flag above
  // decided this brand's page set is stable enough to defer to the next auto-scrape.
  if (rootFragment.length >= 5 && !skipPhase1d) {
    const p1dBefore = pageCache.size;
    const p1dIsFirstScrape = (p1dBefore === 0); // no pre-loaded pages → first discovery run
    // Phase 1d serves two purposes now:
    //   1) Discover new FB pages (any cursor page surfaces those)
    //   2) Capture meta_rank per ad — impression position in Meta's library.
    //      Without this the league's lower tiers (A/B/C/MID/TEST) and the
    //      V7D/V21D velocity columns degrade to longevity-based proxies for
    //      ads outside the top-N. To rank the FULL active set by impressions
    //      we need to walk enough cursor pages to cover every active ad.
    //
    // maxPages=30 captures the top ~900 ads by impressions per scrape —
    // covers EarthBreeze (910 active), all of try-forge / pestlab /
    // thegreatproject, and most of norseorganics (1289). First scrapes
    // still use the wider 50 since they're bootstrapping history.
    const p1dMaxPages = p1dIsFirstScrape ? 50 : 30;
    let p1dDiscovered = 0, p1dUpdated = 0, p1dNewPages = 0;
    // metaRankCursor tracks the running impression position across cursor pages.
    // ScrapeCreators returns results sorted by total_impressions DESC, so the
    // first ad in the first cursor page is impression rank 1 globally for
    // this keyword search. We pass metaRankCursor to upsertAdBatch as the
    // starting index — it assigns each ad's meta_rank within the batch.
    let metaRankCursor = 1;
    console.log(`[brand-spy] phase-1d: rootFragment search for "${rootFragment}" (US active, maxPages=${p1dMaxPages})`);
    for await (const batch of sc.iterateAdsByDomain({ domain: rootFragment, status: 'ACTIVE', country: 'US', maxPages: p1dMaxPages })) {
      creditsUsed += 1;
      const filtered = batch.filter((ad) => {
        const url = ad.snapshot?.link_url ?? ad.link_url ?? '';
        return linkBelongsToBrand(url, domain);
      });
      if (filtered.length > 0) {
        const { d, u } = await upsertAdBatch(brandId, filtered, pageCache, null, crossDomains, pageNameCache, metaRankCursor);
        p1dDiscovered += d; p1dUpdated += u;
        launchNewPages();
      }
      // Advance the rank cursor by the FULL batch size (not just filtered),
      // so an ad at position 30 (page 1, last slot) remains rank 30 even if
      // earlier ads were filtered out as belonging to other brands.
      metaRankCursor += batch.length;
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
          const url = ad.snapshot?.link_url ?? ad.link_url ?? '';
          return linkBelongsToBrand(url, domain);
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
  if (shutdownRequested) { p2Blocked = true; throw Object.assign(new Error('Shutdown requested after phase-1d'), { isShutdown: true }); }

  // Phase 1.5: company-name search — discovers FB pages not found via domain
  // keyword search (common when brands use subdomains/redirect URLs). Only runs
  // on first scrape: on re-scrapes we already know the pages and Phase 1d ACTIVE
  // (maxPages=3) is enough to catch any newly-launched brand pages.
  //
  // IMPORTANT: we search only the FULL domain name (e.g. "try-forge"), NOT a
  // prefix-stripped variant (e.g. "forge"). Generic fragments like "forge" match
  // completely unrelated companies (Forge of Empires, Forge Men, Forgeurban…) and
  // cause Phase 2 to store their ads under the wrong brand.
  //
  // Relevance check uses normalised comparison so "Try Forge" matches "try-forge"
  // and "TryForge" matches "try-forge" regardless of hyphens/spaces.
  if (isFirstScrape) {
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
  } else {
    console.log(`[brand-spy] phase-1.5: skipped (re-scrape; Phase 1d ACTIVE handles new-page discovery)`);
  }
  if (shutdownRequested) { p2Blocked = true; throw Object.assign(new Error('Shutdown requested after phase-1.5'), { isShutdown: true }); }

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
  // call). With deferred-reset, mid-scrape counts would still be partial — the sweep
  // that marks not-seen ads inactive runs after Phase 3. Counters are flushed at the
  // very end so the brands table never displays a transient partial total.
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
      // ALL pass only on first scrape (bootstraps subdomain history).
      // Re-scrapes already have the subdomain's history in the DB — the ACTIVE
      // pass above + per-page Phase 2 ACTIVE on its FB pages is sufficient.
      if (isFirstScrape) {
        for await (const batch of sc.iterateAdsByDomain({ domain: subDomain, status: 'ALL', country: 'US' })) {
          creditsUsed += 1;
          const { d, u } = await upsertAdBatch(brandId, batch, pageCache, null, crossDomains, pageNameCache);
          discovered += d; updated += u;
          launchNewPages();
        }
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

  // Deferred is_active reset — runs only on success path (after every phase
  // completed). Any ad whose last_seen_at is older than this scrape's start
  // sentinel was not observed in this run by either Phase 1 (keyword) or
  // Phase 2 (per-page ACTIVE), so it is no longer running. Marking it inactive
  // here keeps scoreBrand's tier output in sync with is_active.
  //
  // If anything before this line threw (out-of-credits, network, SIGTERM,
  // deadlock), this query is skipped and the DB keeps the previous run's
  // is_active values intact — no more "OFF + TIER=BANGER" half-state.
  const sweep = await query(
    `UPDATE brand_spy.ads SET is_active = FALSE
       WHERE brand_id = $1 AND is_active = TRUE AND last_seen_at < $2`,
    [brandId, scrapeStartedAt],
  );
  console.log(`[brand-spy] end-of-scrape sweep: ${sweep.rowCount} ads marked inactive (last_seen_at < ${scrapeStartedAt.toISOString()})`);

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
  // Concurrency 1: scrape brands serially to avoid inter-brand deadlocks.
  // scoreBrand holds long-running transactions that contend on shared B-tree
  // index pages when multiple brands run concurrently — serialising eliminates this.
  // Per-brand Phase 2 still uses PHASE2_CONCURRENCY=5 for internal parallelism.
  const CONCURRENCY = 1;
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
