/**
 * Brand Spy — database queries
 * Uses the existing pg Pool from config/db.js
 */

import { query, getClient } from '../config/db.js';

// ---------------------------------------------------------------------------
// Transaction helper
// ---------------------------------------------------------------------------

export async function withTransaction(fn) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function mapBrand(row) {
  // The DB doesn't store a human-readable brand name; derive one from the
  // best signal we have so the UI never renders blank labels.
  //   1. display_name if explicitly set
  //   2. first page name (joined separately via getBrandExpanded)
  //   3. primary domain stripped of its TLD ("norseorganics.co" → "Norse Organics")
  const titleCaseFromDomain = (d) => {
    if (!d) return null;
    const base = d.replace(/^www\./, '').split('.')[0];
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  };
  const fallbackName = row.display_name || row.first_page_name || titleCaseFromDomain(row.domain);
  return {
    id: row.id,
    domain: row.domain,
    name: fallbackName,             // canonical name field for the UI
    displayName: fallbackName,      // legacy alias — keep until callers migrate
    status: row.status,
    activeAdsCount: Number(row.active_ads_count),
    totalAdsCount: Number(row.total_ads_count),
    pagesCount: Number(row.pages_count),
    domainsCount: Number(row.domains_count),
    tierBreakdown: {
      banger: row.banger_count,
      champ: row.champ_count,
      a: row.tier_a_count,
      b: row.tier_b_count,
      c: row.tier_c_count,
      mid: row.tier_low_count,      // canonical key — column is named tier_low_count for legacy
      low: row.tier_low_count,      // keep old key one release for any caller still reading it
      test: row.tier_test_count,
    },
    lastScrapedAt: row.last_scraped_at ? new Date(row.last_scraped_at).toISOString() : null,
    lastScrapeStatus: row.last_scrape_status ?? null,
    lastScrapeError: row.last_scrape_error,
    intelScrapedAt: row.intel_scraped_at ? new Date(row.intel_scraped_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function extractThumbnail(raw) {
  if (!raw) return null;
  // Video preview (for VIDEO/mixed ads)
  if (raw.videos?.[0]?.video_preview_image_url) return raw.videos[0].video_preview_image_url;
  // Direct images array (IMAGE, DCO with creatives)
  if (raw.images?.[0]?.resized_image_url)   return raw.images[0].resized_image_url;
  if (raw.images?.[0]?.original_image_url)  return raw.images[0].original_image_url;
  // Carousel cards
  if (raw.cards?.[0]?.resized_image_url)    return raw.cards[0].resized_image_url;
  if (raw.cards?.[0]?.original_image_url)   return raw.cards[0].original_image_url;
  // Last-resort DCO fallback: the page's profile picture. The frontend
  // detects DCO ads and renders with object-contain so this doesn't get
  // stretched as a full-bleed creative.
  if (raw.page_profile_picture_url) return raw.page_profile_picture_url;
  return null;
}

function extractVideo(raw) {
  if (!raw) return null;
  return raw.videos?.[0]?.video_hd_url ?? raw.videos?.[0]?.video_sd_url ?? null;
}

// Collapse Meta's many format labels (IMAGE / VIDEO / CAROUSEL / DCO / DPA /
// EVENT / etc.) down to the two we actually show in the league: VID or IMG.
// Rules:
//   • If Meta says VIDEO, or we have an extracted video URL, it's VID.
//   • Everything else (IMAGE, CAROUSEL, DCO without a video variant, etc.)
//     is IMG.
//   • If we have no display_format at all and no video, return null and let
//     the UI render an em-dash.
function collapseDisplayFormat(raw, videoUrl) {
  if (raw === 'VIDEO' || videoUrl) return 'VID';
  if (raw) return 'IMG';
  return null;
}

function mapAdListItem(row) {
  const videoUrl = row.video_url !== undefined
    ? (row.video_url ?? null)
    : extractVideo(row.raw_snapshot);
  const rawFormat = row.display_format;
  return {
    id: row.id,
    adArchiveId: row.ad_archive_id,
    brandId: row.brand_id,
    brandPageId: row.brand_page_id,
    pageName: row.page_name,
    metaRank: row.meta_rank ?? null,
    metaPageId: row.meta_page_id,
    isActive: row.is_active,
    startDate: row.start_date ? new Date(row.start_date).toISOString() : null,
    endDate: row.end_date ? new Date(row.end_date).toISOString() : null,
    activeDays: row.active_days,
    totalActiveTime: row.total_active_time ?? null,
    displayFormat: collapseDisplayFormat(rawFormat, videoUrl),
    // DCO ads have no canonical creative — the thumbnail is the page logo
    // fallback. Expose this so the UI can render with object-contain instead
    // of object-cover (which would stretch the logo awkwardly).
    isDco: rawFormat === 'DCO',
    ctaText: row.cta_text,
    ctaType: row.cta_type,
    headline: row.headline,
    bodyText: row.body_text,
    linkUrl: row.link_url,
    caption: row.caption,
    publisherPlatforms: row.publisher_platforms ?? [],
    collationId: row.collation_id,
    collationCount: row.collation_count,
    tier: row.tier,
    currentRank: row.current_rank,
    rank3d: row.rank_3d,
    rank7d: row.rank_7d,
    rank21d: row.rank_21d,
    velocity7d: row.velocity_7d,
    velocity21d: row.velocity_21d,
    poolSize: row.pool_size,
    // Use the SQL-extracted columns when present (listAds); fall back to
    // raw_snapshot extraction for callers that still SELECT the full JSON
    // (getAdDetail).
    thumbnailUrl: row.thumbnail_url !== undefined
      ? (row.thumbnail_url ?? null)
      : extractThumbnail(row.raw_snapshot),
    videoUrl,
    firstSeenAt: new Date(row.first_seen_at).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Brand queries
// ---------------------------------------------------------------------------

export async function listBrands(workspaceId) {
  // LEFT JOIN brand_pages to pick the page with the highest ad count as the
  // brand's display name. Some brands have no display_name set; falling back
  // to "Norse Organics" beats falling back to "norseorganics.co".
  const { rows } = await query(
    `SELECT b.*,
            -- Orders on the count brand_pages already stores. This used to run
            -- a correlated COUNT(*) over brand_spy.ads for EVERY page of EVERY
            -- brand — ~200 pages against 46k ads on each load of the Following
            -- list, which measured 9.8 s. Same page wins, no table scan.
            (SELECT bp.page_name
               FROM brand_spy.brand_pages bp
              WHERE bp.brand_id = b.id
              ORDER BY bp.total_ads_count DESC NULLS LAST, bp.active_ads_count DESC
              LIMIT 1) AS first_page_name
       FROM brand_spy.brands b
      WHERE ($1::uuid IS NULL AND b.workspace_id IS NULL)
         OR b.workspace_id = $1::uuid
      ORDER BY b.active_ads_count DESC, b.created_at DESC`,
    [workspaceId],
  );
  return rows.map(mapBrand);
}

export async function getBrand(id) {
  const { rows } = await query(
    `SELECT b.*,
            (SELECT bp.page_name FROM brand_spy.brand_pages bp
              WHERE bp.brand_id = b.id
              ORDER BY bp.total_ads_count DESC NULLS LAST, bp.active_ads_count DESC
              LIMIT 1) AS first_page_name
       FROM brand_spy.brands b WHERE b.id = $1`,
    [id],
  );
  return rows[0] ? mapBrand(rows[0]) : null;
}

export async function getBrandExpanded(id) {
  const brand = await getBrand(id);
  if (!brand) return null;

  const [pagesRes, domainsRes] = await Promise.all([
    query(
      // Compute live per-page ad counts via a join — the column-based
      // active_ads_count was never being populated, so the UI dropdown
      // had no way to show counts.
      `SELECT bp.id, bp.meta_page_id, bp.page_name, bp.page_profile_pic, bp.page_profile_pic_r2,
              bp.active_ads_count, bp.total_ads_count, bp.match_confidence, bp.first_seen_at,
              (SELECT COUNT(*) FROM brand_spy.ads a
                 WHERE a.brand_page_id = bp.id AND a.is_active = TRUE) AS live_active_ads,
              (SELECT COUNT(*) FROM brand_spy.ads a
                 WHERE a.brand_page_id = bp.id) AS live_total_ads
         FROM brand_spy.brand_pages bp WHERE bp.brand_id = $1
         ORDER BY live_active_ads DESC`,
      [id],
    ),
    query(
      `SELECT id, domain, is_primary, active_ads_count, total_ads_count
         FROM brand_spy.brand_domains WHERE brand_id = $1
         ORDER BY is_primary DESC, active_ads_count DESC`,
      [id],
    ),
  ]);

  const pages = pagesRes.rows.map((r) => {
    const live = Number(r.live_active_ads ?? 0);
    const liveTotal = Number(r.live_total_ads ?? 0);
    return {
      id: r.id,
      metaPageId: r.meta_page_id,
      pageName: r.page_name,
      // R2-mirrored URL preferred (never expires); fbcdn URL is a fallback.
      pageProfilePic: r.page_profile_pic_r2 || r.page_profile_pic,
      // Prefer the live computed counts (always current) over the column
      // values (which the worker historically forgot to populate).
      activeAdsCount: live || Number(r.active_ads_count) || 0,
      totalAdsCount:  liveTotal || Number(r.total_ads_count) || 0,
      adCount:        live || Number(r.active_ads_count) || 0,
      matchConfidence: r.match_confidence !== null ? Number(r.match_confidence) : null,
      firstSeenAt: new Date(r.first_seen_at).toISOString(),
    };
  });

  const domains = domainsRes.rows.map((r) => ({
    id: r.id,
    domain: r.domain,
    isPrimary: r.is_primary,
    activeAdsCount: Number(r.active_ads_count),
    totalAdsCount: Number(r.total_ads_count),
  }));

  return { ...brand, pages, domains };
}

export async function createBrand({ domain, workspaceId, ownerUserId, displayName }) {
  const { rows } = await query(
    `INSERT INTO brand_spy.brands (domain, display_name, workspace_id, owner_user_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), domain)
       DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, brand_spy.brands.display_name)
     RETURNING *`,
    [domain, displayName ?? null, workspaceId, ownerUserId],
  );
  // Also seed brand_domains with the primary domain. The worker only adds
  // domains it sees in ad link_urls — if all of a brand's ads link to a
  // subdomain (sale.brand.com), the bare brand.com would never appear in
  // brand_domains and the UI would show "no primary domain". This insert
  // guarantees the canonical primary is always there.
  await query(
    `INSERT INTO brand_spy.brand_domains (brand_id, domain, is_primary)
       VALUES ($1, $2, TRUE)
       ON CONFLICT (brand_id, domain) DO UPDATE SET is_primary = TRUE`,
    [rows[0].id, domain],
  ).catch((err) => console.warn(`[brand-spy] failed to seed primary domain for ${rows[0].id}: ${err.message}`));
  return mapBrand(rows[0]);
}

export async function deleteBrand(id) {
  const res = await query(`DELETE FROM brand_spy.brands WHERE id = $1`, [id]);
  return (res.rowCount ?? 0) > 0;
}

export async function recomputeBrandCounters(brandId, client) {
  const q = client ? (text, params) => client.query(text, params) : query;
  await q(
    `UPDATE brand_spy.brands b SET
       active_ads_count = COALESCE((SELECT COUNT(*) FROM brand_spy.ads WHERE brand_id = b.id AND is_active = TRUE), 0),
       total_ads_count  = COALESCE((SELECT COUNT(*) FROM brand_spy.ads WHERE brand_id = b.id), 0),
       pages_count      = COALESCE((SELECT COUNT(*) FROM brand_spy.brand_pages WHERE brand_id = b.id), 0),
       domains_count    = COALESCE((SELECT COUNT(*) FROM brand_spy.brand_domains WHERE brand_id = b.id), 0)
     WHERE b.id = $1`,
    [brandId],
  );
}

// ---------------------------------------------------------------------------
// Ad queries
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 100;

export async function listAds(brandId, q) {
  const page = Math.max(1, q.page ?? 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, q.pageSize ?? DEFAULT_PAGE_SIZE));
  const offset = (page - 1) * pageSize;
  const sort = q.sort ?? 'rank_asc';

  const where = ['a.brand_id = $1'];
  const params = [brandId];
  let p = 2;

  if (q.tier && q.tier !== 'ALL') {
    if (q.tier === 'ACTIVE_ONLY') {
      where.push(`a.is_active = TRUE`);
    } else {
      where.push(`a.tier = $${p++}`);
      params.push(q.tier);
    }
  }

  // status filter — Active / Inactive Status dropdown in the UI.
  // Now that the worker no longer pulses last_seen_at on inactive scrapes
  // (and stops stamping end_date on active ads), we can trust is_active as
  // the single source of truth. The brand counter and this filter return
  // the same number.
  if (q.status === 'ACTIVE') {
    where.push(`a.is_active = TRUE`);
  } else if (q.status === 'INACTIVE') {
    where.push(`a.is_active = FALSE`);
  }

  if (q.format) {
    // Accept both raw Meta formats (VIDEO/IMAGE/CAROUSEL/DCO/…) for legacy
    // callers and the collapsed UI labels (VID/IMG) the API now returns.
    // The UI dropdown is built from response values, so it can only show
    // VID/IMG — translate those into a SQL clause that matches the
    // underlying raw values.
    const f = String(q.format).toUpperCase();
    if (f === 'VID') {
      where.push(`(a.display_format = 'VIDEO' OR (a.raw_snapshot->'videos' IS NOT NULL AND jsonb_array_length(a.raw_snapshot->'videos') > 0))`);
    } else if (f === 'IMG') {
      where.push(`NOT (a.display_format = 'VIDEO' OR (a.raw_snapshot->'videos' IS NOT NULL AND jsonb_array_length(a.raw_snapshot->'videos') > 0))`);
    } else {
      where.push(`a.display_format = $${p++}`);
      params.push(f);
    }
  }

  if (q.brandPageId) {
    where.push(`a.brand_page_id = $${p++}`);
    params.push(q.brandPageId);
  }

  if (q.minStartDate) {
    where.push(`a.start_date >= $${p++}`);
    params.push(q.minStartDate);
  }

  // Default sort uses current_rank, which scoreBrand now writes as the
  // tier-priority league rank (BANGERs get ranks 1..N first, then CHAMPs
  // continue from N+1, then A, B, C, MID, TEST). So sorting by current_rank
  // ASC gives the right league order: strongest tier first, best impressions
  // within each tier.
  let orderBy;
  switch (sort) {
    case 'velocity_7d_desc':
      orderBy = 'a.velocity_7d DESC NULLS LAST, a.current_rank ASC NULLS LAST';
      break;
    case 'active_days_desc':
      orderBy = 'a.is_active DESC, a.active_days DESC NULLS LAST';
      break;
    case 'first_seen_desc':
      // "Most recent" must order by the date the CARD shows — start_date, the
      // ad's launch date. It used to order by first_seen_at (when WE first
      // scraped it) behind is_active, which produced visibly scrambled dates:
      // every ad discovered in the same scrape shares a near-identical
      // first_seen_at, so within a batch the order was arbitrary relative to
      // the launch dates on screen, and the is_active bucket came first.
      // first_seen_at stays as the tie-breaker for ads with no start_date.
      orderBy = 'a.start_date DESC NULLS LAST, a.first_seen_at DESC';
      break;
    case 'impressions_desc':
      // Meta's raw impression order — mirrors what the FB Ad Library shows
      // when sorted by total_impressions DESC. meta_rank ASC = most
      // impressions first. Ads outside Phase 1d's top-N window have NULL
      // meta_rank and fall to the tail, ordered by active_days as proxy.
      orderBy = 'a.is_active DESC, a.meta_rank ASC NULLS LAST, a.active_days DESC NULLS LAST';
      break;
    default:
      // No leading `is_active DESC`. It blocked ads_brand_rank_idx
      // (brand_id, current_rank) WHERE is_active — the index that serves
      // exactly this ordering — forcing a sort of all 10k rows on every page
      // open (measured 4.3 s vs 1.1 s for the one sort that lacks the prefix).
      // It is also redundant: scoreBrand leaves inactive ads with a NULL
      // current_rank, so NULLS LAST already puts them last. Same visible
      // order, without the full sort.
      orderBy = 'a.current_rank ASC NULLS LAST, a.first_seen_at DESC';
  }

  const whereClause = where.join(' AND ');

  // The grid header only needs "10,057 Ads". Counting that exactly meant a
  // COUNT(*) across every matching row of a table whose rows carry a multi-KB
  // raw_snapshot — measured ~5.5 s per page view on a 10k-ad brand, and it ran
  // BEFORE the data query rather than alongside it, so the user waited for both
  // in series.
  //
  // Unfiltered (brand_id only) the answer is already on the brand row, kept up
  // to date by the scrape worker — one indexed lookup instead of a scan. With
  // filters applied we still count for real, because the number has to match
  // what the filter actually returns.
  const isUnfiltered = where.length === 1;
  const countPromise = isUnfiltered
    ? query('SELECT total_ads_count AS count FROM brand_spy.brands WHERE id = $1', [params[0]])
    : query(`SELECT COUNT(*) AS count FROM brand_spy.ads a WHERE ${whereClause}`, params);

  // raw_snapshot can be a large JSON blob (~5-10 KB each). For the LIST view
  // we only need the thumbnail URL and video URL; computing them in SQL with
  // JSON-path operators lets us drop raw_snapshot from the SELECT entirely,
  // cutting the DB→server payload by ~80% per page and shaving 100-300 ms off
  // a 48-ad list load on big brands. getAdDetail still returns raw_snapshot
  // for IntelDrawer's deep view.
  const dataRes = await query(
    `SELECT
       a.id, a.ad_archive_id, a.brand_id, a.brand_page_id,
       bp.page_name,
       a.meta_page_id, a.is_active, a.start_date, a.end_date, a.active_days,
       a.total_active_time,
       a.display_format, a.cta_text, a.cta_type, a.headline, a.body_text,
       a.link_url, a.caption, a.publisher_platforms,
       a.collation_id, a.collation_count,
       a.tier, a.current_rank, a.meta_rank, a.rank_3d, a.rank_7d, a.rank_21d,
       a.velocity_7d, a.velocity_21d, a.pool_size,
       -- Prefer the R2-mirrored URL if the media-mirror worker has already
       -- processed this ad. R2 URLs never expire; fbcdn does (~2-4 weeks).
       -- For ads not yet mirrored, fall through the existing fbcdn chain.
       COALESCE(
         a.thumbnail_url_r2,
         a.raw_snapshot->'videos'->0->>'video_preview_image_url',
         a.raw_snapshot->'images'->0->>'resized_image_url',
         a.raw_snapshot->'images'->0->>'original_image_url',
         a.raw_snapshot->'cards'->0->>'resized_image_url',
         a.raw_snapshot->'cards'->0->>'original_image_url',
         a.raw_snapshot->>'page_profile_picture_url'
       ) AS thumbnail_url,
       COALESCE(
         a.video_url_r2,
         a.raw_snapshot->'videos'->0->>'video_hd_url',
         a.raw_snapshot->'videos'->0->>'video_sd_url'
       ) AS video_url,
       a.first_seen_at, a.last_seen_at
     FROM brand_spy.ads a
     LEFT JOIN brand_spy.brand_pages bp ON bp.id = a.brand_page_id
     WHERE ${whereClause}
     ORDER BY ${orderBy}
     LIMIT $${p++} OFFSET $${p++}`,
    [...params, pageSize, offset],
  );

  // Awaited here, not above: the count and the page of rows are independent,
  // so they run concurrently instead of one after the other.
  const countRes = await countPromise;
  const total = parseInt(countRes.rows[0]?.count ?? '0', 10);

  return { ads: dataRes.rows.map(mapAdListItem), total, page, pageSize };
}

export async function getAdDetail(adId) {
  const { rows } = await query(
    `SELECT
       a.id, a.ad_archive_id, a.brand_id, a.brand_page_id,
       bp.page_name,
       a.meta_page_id, a.is_active, a.start_date, a.end_date, a.active_days,
       a.total_active_time,
       a.display_format, a.cta_text, a.cta_type, a.headline, a.body_text,
       a.link_url, a.caption, a.publisher_platforms,
       a.collation_id, a.collation_count,
       a.tier, a.current_rank, a.meta_rank, a.rank_3d, a.rank_7d, a.rank_21d,
       a.velocity_7d, a.velocity_21d, a.pool_size,
       -- Prefer R2-mirrored URLs (never expire). Fall through the fbcdn
       -- chain only for ads the mirror worker hasn't reached yet.
       COALESCE(
         a.thumbnail_url_r2,
         a.raw_snapshot->'videos'->0->>'video_preview_image_url',
         a.raw_snapshot->'images'->0->>'resized_image_url',
         a.raw_snapshot->'images'->0->>'original_image_url',
         a.raw_snapshot->'cards'->0->>'resized_image_url',
         a.raw_snapshot->'cards'->0->>'original_image_url',
         a.raw_snapshot->>'page_profile_picture_url'
       ) AS thumbnail_url,
       COALESCE(
         a.video_url_r2,
         a.raw_snapshot->'videos'->0->>'video_hd_url',
         a.raw_snapshot->'videos'->0->>'video_sd_url'
       ) AS video_url,
       a.first_seen_at, a.last_seen_at,
       a.transcript, a.transcript_segments, a.transcript_at
     FROM brand_spy.ads a
     LEFT JOIN brand_spy.brand_pages bp ON bp.id = a.brand_page_id
     WHERE a.id = $1`,
    [adId],
  );
  if (!rows[0]) return null;
  return {
    ...mapAdListItem(rows[0]),
    transcript: rows[0].transcript ?? null,
    transcriptSegments: rows[0].transcript_segments ?? null,
    transcriptAt: rows[0].transcript_at ? new Date(rows[0].transcript_at).toISOString() : null,
  };
}


// Runs a query under a hard server-side time limit.
//
// This is the guard that today's incident needed. Cloudflare cuts the client
// connection at ~100 s but Postgres keeps executing, so every reload of a slow
// page stacked ANOTHER multi-minute query onto a basic_256mb instance. They
// accumulated until unrelated queries starved too — a single-row brand lookup
// was measured at 284 s. Capping server-side means a runaway query dies
// instead of piling up, so one slow endpoint can no longer degrade the rest.
//
// SET LOCAL requires a transaction: the pool reuses connections, so a bare SET
// would leak the timeout onto every later query on that connection.
async function queryCapped(sql, params, ms = 10000) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${Number(ms)}`);
    const res = await client.query(sql, params);
    await client.query('COMMIT');
    return res;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

// Postgres raises 57014 (query_canceled) when statement_timeout fires.
const isTimeout = (err) => err?.code === '57014';

// ---------------------------------------------------------------------------
// Per-brand derived-stat cache.
//
// format-counts and aggregation-counts both have to read EVERY ad row in the
// brand: format-counts probes raw_snapshot->'videos' (detoasting that JSONB
// once per row) and the aggregation counters de-duplicate body_text. Measured
// on the live corpus that is ~16 s and ~225 s respectively on a 9k-ad brand,
// and it was being paid on every single page view — even though the answers
// only change when a scrape lands.
//
// Keyed on the brand's last_scraped_at, so a completed scrape invalidates the
// entry automatically and a stale count can never be served. Held in process
// rather than in a table because migrations are not run on deploy here, so a
// new column would break the page rather than speed it up. Cost is four
// integers per brand; the first load after each scrape still pays full price.
const derivedCache = new Map(); // `${name}:${brandId}` -> { key, value }

async function cachedByScrape(name, brandId, compute) {
  const cacheId = `${name}:${brandId}`;
  const { rows } = await query(
    `SELECT last_scraped_at FROM brand_spy.brands WHERE id = $1`,
    [brandId],
  );
  const ts = rows[0]?.last_scraped_at;
  const key = ts ? new Date(ts).toISOString() : 'never';

  const hit = derivedCache.get(cacheId);
  if (hit && hit.key === key) return hit.value;

  const value = await compute();
  derivedCache.set(cacheId, { key, value });
  return value;
}

export async function getAdFormatCounts(brandId) {
  return cachedByScrape('format', brandId, async () => {
    try {
      return await computeAdFormatCounts(brandId);
    } catch (err) {
      if (isTimeout(err)) return null;   // UI renders the card empty
      throw err;
    }
  });
}

async function computeAdFormatCounts(brandId) {
  // Group by "has-video" since that's the only thing the UI cares about:
  // ads collapse to VID (has any video) or IMG (everything else, including
  // DCO ads whose video variants live in raw_snapshot but no extracted
  // video_url is materialized). Returns both the new collapsed counts and
  // the legacy raw breakdown so older clients don't break.
  const { rows } = await queryCapped(
    `SELECT
       display_format,
       (raw_snapshot->'videos' IS NOT NULL
          AND jsonb_array_length(raw_snapshot->'videos') > 0) AS has_video,
       is_active,
       COUNT(*) AS count
       FROM brand_spy.ads
      WHERE brand_id = $1
      GROUP BY display_format, has_video, is_active`,
    [brandId],
  );
  const out = {
    VID: 0, IMG: 0,                            // canonical UI buckets
    VIDEO: 0, IMAGE: 0, CAROUSEL: 0, OTHER: 0, // legacy keys (kept for callers still reading them)
    TOTAL: 0, ACTIVE: 0,
  };
  for (const r of rows) {
    const n = parseInt(r.count, 10);
    out.TOTAL += n;
    if (r.is_active) out.ACTIVE += n;
    // Collapsed
    if (r.display_format === 'VIDEO' || r.has_video) out.VID += n;
    else                                              out.IMG += n;
    // Legacy raw
    if      (r.display_format === 'VIDEO')    out.VIDEO    += n;
    else if (r.display_format === 'IMAGE')    out.IMAGE    += n;
    else if (r.display_format === 'CAROUSEL') out.CAROUSEL += n;
    else                                      out.OTHER    += n;
  }
  return out;
}

export async function getAdTierCounts(brandId) {
  const { rows } = await query(
    `SELECT tier, is_active, COUNT(*) AS count
       FROM brand_spy.ads WHERE brand_id = $1 GROUP BY tier, is_active`,
    [brandId],
  );
  const out = { BANGER: 0, CHAMP: 0, A: 0, B: 0, C: 0, MID: 0, TEST: 0, TOTAL: 0, ACTIVE: 0 };
  for (const r of rows) {
    const n = parseInt(r.count, 10);
    out.TOTAL += n;
    if (r.is_active) out.ACTIVE += n;
    if (r.tier) out[r.tier] = (out[r.tier] ?? 0) + n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Aggregations — for Hooks / Ad Copy / Headlines / Landing Pages tabs
// ---------------------------------------------------------------------------

// Single-fetch combined counts — used by Overview's 4 mini-stat boxes.
// Replaces 4 parallel /aggregations?type=X&limit=1 calls (each of which pulled
// every ad and built the full grouping in memory) with one query + one in-memory
// pass that builds all four Set sizes at once. Cuts ~500-700 ms on big brands.
// ---------------------------------------------------------------------------
// Aggregation key expressions, evaluated in Postgres.
//
// These reproduce the JS key functions that used to run in Node. They live in
// SQL because the old implementation ran `SELECT ... FROM brand_spy.ads WHERE
// brand_id = $1` with no LIMIT and deduped every row in process memory. That
// was written when the comment below it still held ("most brands have <2k ads,
// fits easily in mem"); brands now reach 9k+ ads and 44k across the corpus, and
// each row drags a multi-KB raw_snapshot through the heap. On a 512 MB instance
// it OOM-killed the whole dashboard (every endpoint 502s while it restarts);
// on a larger one it still took ~31 s, past Render's 30 s gateway timeout.
// Grouping in Postgres keeps process memory flat regardless of corpus size.
//
// Each type is expressed as a cheap `pre` projection plus `key`/`keep` derived
// FROM that projection, so the expensive regexes run once per row instead of
// once for the predicate and again for the key. `a` is the alias of
// brand_spy.ads in the surrounding query; `key`/`keep` take the pre-computed
// column name.
//
// Landing: host+path, lowercased host, www./query/fragment/trailing slash
// stripped. Schemeless values fall back to the raw first 160 chars, since
// `new URL()` would have thrown for them.
function landingKeySql(u) {
  // Keep the URL as the advertiser wrote it — scheme included — so rows read
  // `https://track.tryrosabella.com/cdc16426-…` exactly like the reference.
  //
  // This used to strip the scheme, lowercase the host and drop `www.`, which
  // produced the mangled `track.tryrosabella.com/cdc16426…` labels. It also
  // must NOT collapse tracking subdomains: track. / get. / the bare domain are
  // genuinely different destinations and belong on separate rows.
  //
  // Query and fragment are still dropped: utm/fbclid parameters differ per ad,
  // so keeping them would shatter one landing page into hundreds of rows.
  return `regexp_replace(split_part(split_part(${u}, '#', 1), '?', 1), '/+$', '')`;
}

const AGG_KEY_SQL = {
  // First line of body_text (falling back to headline), whitespace-collapsed,
  // capped at 100 chars — mirrors src.split(/\r?\n/)[0].trim().replace().slice().
  hooks: {
    pre:  `left(regexp_replace(btrim(split_part(replace(COALESCE(NULLIF(a.body_text, ''), a.headline, ''), E'\\r\\n', E'\\n'), E'\\n', 1)), '\\s+', ' ', 'g'), 100)`,
    key:  (p) => p,
    keep: (p) => `length(${p}) >= 8`,
  },
  headlines: {
    pre:  `btrim(COALESCE(a.headline, ''))`,
    key:  (p) => p,
    keep: (p) => `length(${p}) >= 3`,
  },
  // Length is checked on the pre-collapse value, exactly as the JS did.
  adcopy: {
    pre:  `btrim(COALESCE(a.body_text, ''))`,
    key:  (p) => `regexp_replace(${p}, '\\s+', ' ', 'g')`,
    keep: (p) => `length(${p}) >= 30`,
  },
  landing: {
    pre:  `btrim(COALESCE(a.link_url, ''))`,
    key:  (p) => landingKeySql(p),
    keep: (p) => `${p} <> ''`,
  },
};

export async function getBrandAggregationCounts(brandId) {
  return cachedByScrape('aggcounts', brandId, async () => {
    try {
      return await computeBrandAggregationCounts(brandId);
    } catch (err) {
      if (isTimeout(err)) return { hooks: 0, adcopy: 0, headlines: 0, landing: 0 };
      throw err;
    }
  });
}

async function computeBrandAggregationCounts(brandId) {
  // Derive each key ONCE per row in the inner select, then count distinct over
  // md5() of it. Two deliberate choices, both measured:
  //   * the first version evaluated every regex twice per row (once for the
  //     qualifying predicate, once for the key) — 8 heavy expressions per row.
  //   * count(DISTINCT <long text>) sorts multi-KB ad bodies; hashing to a
  //     fixed 32-byte digest keeps the sort key small. Digest collisions are
  //     negligible at these cardinalities and this is a display counter.
  const { rows } = await queryCapped(
    `SELECT
       count(DISTINCT md5(CASE WHEN ${AGG_KEY_SQL.hooks.keep('hook_v')}
                               THEN ${AGG_KEY_SQL.hooks.key('hook_v')} END))::int AS hooks,
       count(DISTINCT md5(CASE WHEN ${AGG_KEY_SQL.adcopy.keep('bt')}
                               THEN ${AGG_KEY_SQL.adcopy.key('bt')} END))::int AS adcopy,
       count(DISTINCT md5(CASE WHEN ${AGG_KEY_SQL.headlines.keep('hd')}
                               THEN ${AGG_KEY_SQL.headlines.key('hd')} END))::int AS headlines,
       count(DISTINCT md5(CASE WHEN ${AGG_KEY_SQL.landing.keep('lu')}
                               THEN ${AGG_KEY_SQL.landing.key('lu')} END))::int AS landing
     FROM (
       SELECT ${AGG_KEY_SQL.hooks.pre}     AS hook_v,
              ${AGG_KEY_SQL.adcopy.pre}    AS bt,
              ${AGG_KEY_SQL.headlines.pre} AS hd,
              ${AGG_KEY_SQL.landing.pre}   AS lu
         FROM brand_spy.ads a
        WHERE a.brand_id = $1
     ) s`,
    [brandId],
  );

  const r = rows[0] ?? {};
  return {
    hooks:     r.hooks     ?? 0,
    adcopy:    r.adcopy    ?? 0,
    headlines: r.headlines ?? 0,
    landing:   r.landing   ?? 0,
  };
}

// Normalize a "hook" = first 100 chars of body_text up to first newline.
// For headlines, ad copy, landing — we group on the raw value.
// Returns { items: [{ key, sample, count, activeCount, tierCounts, days, topAdId, sampleAdIds }], total }
export async function getBrandAggregations(brandId, type, { limit = 50, activeOnly = false } = {}) {
  // Pull all ads' content fields once — most brands have <2k ads, fits easily in mem.
  const where = ['a.brand_id = $1'];
  const params = [brandId];
  if (activeOnly) where.push('a.is_active = TRUE');
  const whereSql = where.join(' AND ');

  const K = AGG_KEY_SQL[type];
  if (!K) throw new Error(`Unknown aggregation type: ${type}`);

  // Group in Postgres and return at most `limit` rows. Nothing proportional to
  // the brand's ad count is ever held in this process — see AGG_KEY_SQL above
  // for why that matters. `total` comes back as a window count over the full
  // group set, so it still reflects every group, not just the returned page.
  //
  // `base` deliberately carries only the columns needed to derive the key and
  // the per-group aggregates. The thumbnail lives in raw_snapshot, and
  // extracting it here would force Postgres to detoast that JSONB for every ad
  // in the brand; instead the sample columns are joined back at the very end,
  // against the <= `limit` representative ads that actually get returned.
  const { rows } = await query(
    `WITH base AS (
       SELECT a.id, a.tier, a.is_active, a.current_rank,
              GREATEST(COALESCE(a.active_days, 0),
                       floor(COALESCE(a.total_active_time, 0) / 86400.0))::int AS days,
              ${K.pre} AS pre
         FROM brand_spy.ads a
        WHERE ${whereSql}
     ),
     f AS (
       SELECT id, tier, is_active, current_rank, days, ${K.key('pre')} AS k
         FROM base
        WHERE ${K.keep('pre')}
     ),
     g AS (
       SELECT k,
              count(*)::int                                    AS count,
              count(*) FILTER (WHERE is_active)::int           AS active_count,
              max(days)::int                                   AS max_active_days,
              count(*) FILTER (WHERE tier = 'BANGER')::int     AS c_banger,
              count(*) FILTER (WHERE tier = 'CHAMP')::int      AS c_champ,
              count(*) FILTER (WHERE tier = 'A')::int          AS c_a,
              count(*) FILTER (WHERE tier = 'B')::int          AS c_b,
              count(*) FILTER (WHERE tier = 'C')::int          AS c_c,
              count(*) FILTER (WHERE tier = 'MID')::int        AS c_mid,
              count(*) FILTER (WHERE tier = 'TEST')::int       AS c_test,
              (array_agg(id ORDER BY (is_active AND current_rank IS NOT NULL) DESC,
                                     current_rank ASC NULLS LAST, id))[1:6] AS sample_ad_ids
         FROM f GROUP BY k
     ),
     t AS (
       SELECT DISTINCT ON (k) k, id AS top_ad_id, current_rank AS best_rank
         FROM f
        ORDER BY k, (is_active AND current_rank IS NOT NULL) DESC,
                 current_rank ASC NULLS LAST, id
     ),
     lim AS (
       SELECT g.*, t.top_ad_id, t.best_rank,
              (count(*) OVER ())::int AS total_groups
         FROM g JOIN t USING (k)
        ORDER BY g.active_count DESC, g.max_active_days DESC, g.count DESC
        LIMIT $${params.length + 1}
     )
     SELECT lim.*, s.headline, s.body_text, s.link_url, s.cta_text,
            COALESCE(
              s.raw_snapshot->'videos'->0->>'video_preview_image_url',
              s.raw_snapshot->'images'->0->>'resized_image_url',
              s.raw_snapshot->'images'->0->>'original_image_url',
              s.raw_snapshot->'cards'->0->>'resized_image_url',
              s.raw_snapshot->'cards'->0->>'original_image_url',
              s.raw_snapshot->>'page_profile_picture_url'
            ) AS thumbnail_url
       FROM lim JOIN brand_spy.ads s ON s.id = lim.top_ad_id
      ORDER BY lim.active_count DESC, lim.max_active_days DESC, lim.count DESC`,
    [...params, limit],
  );

  // Rows arrive pre-grouped, pre-sorted and already capped at `limit`. The
  // representative ad per group is chosen deterministically in SQL (active +
  // ranked first, then lowest rank, then id) rather than by row arrival order,
  // which the old in-process loop depended on.
  const items = rows.map((r) => ({
    key: r.k,
    sampleHeadline: r.headline ?? null,
    sampleBody: r.body_text ?? null,
    sampleLink: r.link_url ?? null,
    sampleCta: r.cta_text ?? null,
    count: r.count,
    activeCount: r.active_count,
    tierCounts: {
      BANGER: r.c_banger,
      CHAMP:  r.c_champ,
      A:      r.c_a,
      B:      r.c_b,
      C:      r.c_c,
      MID:    r.c_mid,
      TEST:   r.c_test,
    },
    bestRank: r.best_rank ?? null,
    maxActiveDays: r.max_active_days,
    topAdId: r.top_ad_id,
    sampleAdIds: r.sample_ad_ids ?? [],
    thumbnailUrl: r.thumbnail_url ?? null,
  }));

  return { items, total: rows[0]?.total_groups ?? 0 };
}
