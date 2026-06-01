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
            (SELECT bp.page_name
               FROM brand_spy.brand_pages bp
              WHERE bp.brand_id = b.id
              ORDER BY (
                SELECT COUNT(*) FROM brand_spy.ads a
                 WHERE a.brand_page_id = bp.id
              ) DESC NULLS LAST
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
              ORDER BY (SELECT COUNT(*) FROM brand_spy.ads a WHERE a.brand_page_id = bp.id) DESC NULLS LAST
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
      `SELECT bp.id, bp.meta_page_id, bp.page_name, bp.page_profile_pic,
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
      pageProfilePic: r.page_profile_pic,
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
      orderBy = 'a.is_active DESC, a.velocity_7d DESC NULLS LAST, a.current_rank ASC NULLS LAST';
      break;
    case 'active_days_desc':
      orderBy = 'a.is_active DESC, a.active_days DESC NULLS LAST';
      break;
    case 'first_seen_desc':
      orderBy = 'a.is_active DESC, a.first_seen_at DESC';
      break;
    default:
      orderBy = 'a.is_active DESC, a.current_rank ASC NULLS LAST, a.first_seen_at DESC';
  }

  const whereClause = where.join(' AND ');
  const countRes = await query(
    `SELECT COUNT(*) AS count FROM brand_spy.ads a WHERE ${whereClause}`,
    params,
  );
  const total = parseInt(countRes.rows[0]?.count ?? '0', 10);

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
       COALESCE(
         a.raw_snapshot->'videos'->0->>'video_preview_image_url',
         a.raw_snapshot->'images'->0->>'resized_image_url',
         a.raw_snapshot->'images'->0->>'original_image_url',
         a.raw_snapshot->'cards'->0->>'resized_image_url',
         a.raw_snapshot->'cards'->0->>'original_image_url',
         -- Last-resort DCO fallback: the page's profile picture. ScrapeCreators
         -- doesn't return a canonical creative for DCO ads (multiple variants),
         -- so the table cell would otherwise be empty. Page logo is at least a
         -- brand-recognizable placeholder. Frontend uses object-contain for
         -- DCO ads so the logo doesn't stretch awkwardly in the 4/5 AdCard box.
         a.raw_snapshot->>'page_profile_picture_url'
       ) AS thumbnail_url,
       COALESCE(
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
       -- Same SQL-side JSON extraction as listAds — keeps the response small.
       -- The frontend uses thumbnailUrl + videoUrl, never raw_snapshot.
       COALESCE(
         a.raw_snapshot->'videos'->0->>'video_preview_image_url',
         a.raw_snapshot->'images'->0->>'resized_image_url',
         a.raw_snapshot->'images'->0->>'original_image_url',
         a.raw_snapshot->'cards'->0->>'resized_image_url',
         a.raw_snapshot->'cards'->0->>'original_image_url',
         a.raw_snapshot->>'page_profile_picture_url'
       ) AS thumbnail_url,
       COALESCE(
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

export async function getAdFormatCounts(brandId) {
  // Group by "has-video" since that's the only thing the UI cares about:
  // ads collapse to VID (has any video) or IMG (everything else, including
  // DCO ads whose video variants live in raw_snapshot but no extracted
  // video_url is materialized). Returns both the new collapsed counts and
  // the legacy raw breakdown so older clients don't break.
  const { rows } = await query(
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
export async function getBrandAggregationCounts(brandId) {
  const { rows } = await query(
    `SELECT headline, body_text, link_url
       FROM brand_spy.ads WHERE brand_id = $1`,
    [brandId],
  );

  const hooks     = new Set();
  const headlines = new Set();
  const adcopy    = new Set();
  const landing   = new Set();

  for (const r of rows) {
    // Hook = first line of body_text (or headline if no body), <=100 chars
    const src = r.body_text || r.headline || '';
    if (src) {
      const firstLine = src.split(/\r?\n/)[0].trim().replace(/\s+/g, ' ').slice(0, 100);
      if (firstLine.length >= 8) hooks.add(firstLine);
    }
    // Headline = raw trimmed headline, >=3 chars
    const h = (r.headline ?? '').trim();
    if (h.length >= 3) headlines.add(h);
    // Ad copy = full body_text, >=30 chars, collapsed whitespace
    const b = (r.body_text ?? '').trim();
    if (b.length >= 30) adcopy.add(b.replace(/\s+/g, ' '));
    // Landing = normalized host+path (strip protocol/www/query/trailing slash)
    const u = (r.link_url ?? '').trim();
    if (u) {
      try {
        const url = new URL(u.startsWith('http') ? u : `https://${u}`);
        const host = url.host.toLowerCase().replace(/^www\./, '');
        const path = url.pathname.replace(/\/+$/, '');
        landing.add(`${host}${path}` || host);
      } catch {
        landing.add(u.slice(0, 160));
      }
    }
  }

  return {
    hooks:     hooks.size,
    adcopy:    adcopy.size,
    headlines: headlines.size,
    landing:   landing.size,
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

  // Same SQL-side JSON extraction listAds / getAdDetail use. Dropping
  // raw_snapshot from the SELECT cuts the wire payload from ~12 MB to ~2 MB
  // on big brands like Norse Organics (2,400 ads × ~5 KB JSON each) and
  // moves the thumbnail computation from JS to Postgres where it's free.
  const { rows } = await query(
    `SELECT a.id, a.ad_archive_id, a.headline, a.body_text, a.link_url, a.cta_text,
            a.tier, a.is_active, a.active_days, a.total_active_time,
            a.display_format, a.current_rank,
            COALESCE(
              a.raw_snapshot->'videos'->0->>'video_preview_image_url',
              a.raw_snapshot->'images'->0->>'resized_image_url',
              a.raw_snapshot->'images'->0->>'original_image_url',
              a.raw_snapshot->'cards'->0->>'resized_image_url',
              a.raw_snapshot->'cards'->0->>'original_image_url',
              a.raw_snapshot->>'page_profile_picture_url'
            ) AS thumbnail_url
       FROM brand_spy.ads a
      WHERE ${whereSql}`,
    params,
  );

  // Pick the key function for the requested type
  function hookOf(ad) {
    const src = ad.body_text || ad.headline || '';
    if (!src) return null;
    // First line only, then first ~100 chars, trimmed and collapsed-whitespace
    const firstLine = src.split(/\r?\n/)[0].trim();
    const collapsed = firstLine.replace(/\s+/g, ' ');
    const out = collapsed.slice(0, 100);
    return out.length >= 8 ? out : null;
  }
  function headlineOf(ad) {
    const h = (ad.headline ?? '').trim();
    return h.length >= 3 ? h : null;
  }
  function adCopyOf(ad) {
    const b = (ad.body_text ?? '').trim();
    if (b.length < 30) return null;
    // Group on full text (collapsed whitespace)
    return b.replace(/\s+/g, ' ');
  }
  function landingOf(ad) {
    const u = (ad.link_url ?? '').trim();
    if (!u) return null;
    // Normalize: strip protocol, lowercase host, drop fbclid/utm/etc query params for grouping
    try {
      const url = new URL(u);
      const host = url.host.toLowerCase().replace(/^www\./, '');
      const path = url.pathname.replace(/\/+$/, '');
      return `${host}${path}` || host;
    } catch {
      return u.slice(0, 160);
    }
  }

  const keyFn = {
    hooks:     hookOf,
    headlines: headlineOf,
    adcopy:    adCopyOf,
    landing:   landingOf,
  }[type];
  if (!keyFn) throw new Error(`Unknown aggregation type: ${type}`);

  // Group
  const groups = new Map();
  for (const r of rows) {
    const key = keyFn(r);
    if (!key) continue;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        sampleHeadline: null,
        sampleBody: null,
        sampleLink: null,
        sampleCta: null,
        count: 0,
        activeCount: 0,
        tierCounts: { BANGER: 0, CHAMP: 0, A: 0, B: 0, C: 0, MID: 0, TEST: 0 },
        bestRank: null,
        maxActiveDays: 0,
        topAdId: null,
        sampleAdIds: [],
        thumbnailUrl: null,
      };
      groups.set(key, g);
    }
    g.count++;
    if (r.is_active) g.activeCount++;
    if (r.tier && g.tierCounts[r.tier] != null) g.tierCounts[r.tier]++;
    const tatDays = r.total_active_time != null ? Math.floor(r.total_active_time / 86400) : 0;
    const days = Math.max(r.active_days ?? 0, tatDays);
    if (days > g.maxActiveDays) g.maxActiveDays = days;
    // Track the "best" ad (lowest current_rank if present, else first active, else first)
    const isBetter = (() => {
      if (g.topAdId == null) return true;
      // Prefer active + has rank
      if (r.is_active && r.current_rank != null) {
        if (g.bestRank == null) return true;
        return r.current_rank < g.bestRank;
      }
      return false;
    })();
    if (isBetter) {
      g.topAdId = r.id;
      g.bestRank = r.current_rank;
      g.sampleHeadline = r.headline ?? g.sampleHeadline;
      g.sampleBody = r.body_text ?? g.sampleBody;
      g.sampleLink = r.link_url ?? g.sampleLink;
      g.sampleCta = r.cta_text ?? g.sampleCta;
      // thumbnail_url is now computed in SQL above — same fallback chain as
      // extractThumbnail used to walk in JS, just done in Postgres for free.
      g.thumbnailUrl = r.thumbnail_url ?? null;
    }
    if (g.sampleAdIds.length < 6) g.sampleAdIds.push(r.id);
  }

  // Sort by activeCount DESC, then maxActiveDays DESC, then count DESC
  const items = Array.from(groups.values()).sort((a, b) => {
    if (b.activeCount !== a.activeCount) return b.activeCount - a.activeCount;
    if (b.maxActiveDays !== a.maxActiveDays) return b.maxActiveDays - a.maxActiveDays;
    return b.count - a.count;
  }).slice(0, limit);

  return { items, total: groups.size };
}
