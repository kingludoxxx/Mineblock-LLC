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
  return {
    id: row.id,
    domain: row.domain,
    displayName: row.display_name,
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
      low: row.tier_low_count,
      test: row.tier_test_count,
    },
    lastScrapedAt: row.last_scraped_at ? new Date(row.last_scraped_at).toISOString() : null,
    lastScrapeStatus: row.last_scrape_status ?? null,
    lastScrapeError: row.last_scrape_error,
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
  // NOTE: do NOT fall back to page_profile_picture_url — that is the page
  // owner's avatar, not the ad creative. Return null so callers show a
  // proper "no preview" placeholder instead of a blurry portrait.
  return null;
}

function extractVideo(raw) {
  if (!raw) return null;
  return raw.videos?.[0]?.video_hd_url ?? raw.videos?.[0]?.video_sd_url ?? null;
}

function mapAdListItem(row) {
  return {
    id: row.id,
    adArchiveId: row.ad_archive_id,
    brandPageId: row.brand_page_id,
    pageName: row.page_name,
    metaPageId: row.meta_page_id,
    isActive: row.is_active,
    startDate: row.start_date ? new Date(row.start_date).toISOString() : null,
    endDate: row.end_date ? new Date(row.end_date).toISOString() : null,
    activeDays: row.active_days,
    totalActiveTime: row.total_active_time ?? null,
    displayFormat: row.display_format,
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
    thumbnailUrl: extractThumbnail(row.raw_snapshot),
    videoUrl: extractVideo(row.raw_snapshot),
    firstSeenAt: new Date(row.first_seen_at).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Brand queries
// ---------------------------------------------------------------------------

export async function listBrands(workspaceId) {
  const { rows } = await query(
    `SELECT * FROM brand_spy.brands
     WHERE ($1::uuid IS NULL AND workspace_id IS NULL)
        OR workspace_id = $1::uuid
     ORDER BY active_ads_count DESC, created_at DESC`,
    [workspaceId],
  );
  return rows.map(mapBrand);
}

export async function getBrand(id) {
  const { rows } = await query(`SELECT * FROM brand_spy.brands WHERE id = $1`, [id]);
  return rows[0] ? mapBrand(rows[0]) : null;
}

export async function getBrandExpanded(id) {
  const brand = await getBrand(id);
  if (!brand) return null;

  const [pagesRes, domainsRes] = await Promise.all([
    query(
      `SELECT id, meta_page_id, page_name, page_profile_pic,
              active_ads_count, total_ads_count, match_confidence, first_seen_at
         FROM brand_spy.brand_pages WHERE brand_id = $1
         ORDER BY active_ads_count DESC`,
      [id],
    ),
    query(
      `SELECT id, domain, is_primary, active_ads_count, total_ads_count
         FROM brand_spy.brand_domains WHERE brand_id = $1
         ORDER BY is_primary DESC, active_ads_count DESC`,
      [id],
    ),
  ]);

  const pages = pagesRes.rows.map((r) => ({
    id: r.id,
    metaPageId: r.meta_page_id,
    pageName: r.page_name,
    pageProfilePic: r.page_profile_pic,
    activeAdsCount: Number(r.active_ads_count),
    totalAdsCount: Number(r.total_ads_count),
    matchConfidence: r.match_confidence !== null ? Number(r.match_confidence) : null,
    firstSeenAt: new Date(r.first_seen_at).toISOString(),
  }));

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

  // status filter — "Active"/"Inactive" Status dropdown in the UI.
  // Uses a freshness heuristic (last_seen_at within 5 days AND no end_date) so
  // it stays useful even when the worker's is_active flag is stale (separate
  // worker bug). Strict is_active is fine when the worker is healthy.
  if (q.status === 'ACTIVE') {
    where.push(`(a.is_active = TRUE OR (a.last_seen_at >= NOW() - INTERVAL '5 days' AND a.end_date IS NULL))`);
  } else if (q.status === 'INACTIVE') {
    where.push(`(a.is_active = FALSE AND (a.last_seen_at < NOW() - INTERVAL '5 days' OR a.end_date IS NOT NULL))`);
  }

  if (q.format) {
    where.push(`a.display_format = $${p++}`);
    params.push(q.format);
  }

  if (q.brandPageId) {
    where.push(`a.brand_page_id = $${p++}`);
    params.push(q.brandPageId);
  }

  if (q.minStartDate) {
    where.push(`a.start_date >= $${p++}`);
    params.push(q.minStartDate);
  }

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

  const dataRes = await query(
    `SELECT
       a.id, a.ad_archive_id, a.brand_page_id,
       bp.page_name,
       a.meta_page_id, a.is_active, a.start_date, a.end_date, a.active_days,
       a.total_active_time,
       a.display_format, a.cta_text, a.cta_type, a.headline, a.body_text,
       a.link_url, a.caption, a.publisher_platforms,
       a.collation_id, a.collation_count,
       a.tier, a.current_rank, a.rank_3d, a.rank_7d, a.rank_21d,
       a.velocity_7d, a.velocity_21d, a.pool_size,
       a.raw_snapshot, a.first_seen_at, a.last_seen_at
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
       a.id, a.ad_archive_id, a.brand_page_id,
       bp.page_name,
       a.meta_page_id, a.is_active, a.start_date, a.end_date, a.active_days,
       a.total_active_time,
       a.display_format, a.cta_text, a.cta_type, a.headline, a.body_text,
       a.link_url, a.caption, a.publisher_platforms,
       a.collation_id, a.collation_count,
       a.tier, a.current_rank, a.rank_3d, a.rank_7d, a.rank_21d,
       a.velocity_7d, a.velocity_21d, a.pool_size,
       a.raw_snapshot, a.first_seen_at, a.last_seen_at
     FROM brand_spy.ads a
     LEFT JOIN brand_spy.brand_pages bp ON bp.id = a.brand_page_id
     WHERE a.id = $1`,
    [adId],
  );
  if (!rows[0]) return null;
  return { ...mapAdListItem(rows[0]), rawSnapshot: rows[0].raw_snapshot };
}

export async function getAdFormatCounts(brandId) {
  const { rows } = await query(
    `SELECT display_format, is_active, COUNT(*) AS count
       FROM brand_spy.ads
      WHERE brand_id = $1
      GROUP BY display_format, is_active`,
    [brandId],
  );
  const out = { VIDEO: 0, IMAGE: 0, CAROUSEL: 0, OTHER: 0, TOTAL: 0, ACTIVE: 0 };
  for (const r of rows) {
    const n = parseInt(r.count, 10);
    out.TOTAL += n;
    if (r.is_active) out.ACTIVE += n;
    if (r.display_format === 'VIDEO')         out.VIDEO    += n;
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

// Normalize a "hook" = first 100 chars of body_text up to first newline.
// For headlines, ad copy, landing — we group on the raw value.
// Returns { items: [{ key, sample, count, activeCount, tierCounts, days, topAdId, sampleAdIds }], total }
export async function getBrandAggregations(brandId, type, { limit = 50, activeOnly = false } = {}) {
  // Pull all ads' content fields once — most brands have <2k ads, fits easily in mem.
  const where = ['a.brand_id = $1'];
  const params = [brandId];
  if (activeOnly) where.push('a.is_active = TRUE');
  const whereSql = where.join(' AND ');

  const { rows } = await query(
    `SELECT a.id, a.ad_archive_id, a.headline, a.body_text, a.link_url, a.cta_text,
            a.tier, a.is_active, a.active_days, a.total_active_time,
            a.display_format, a.current_rank, a.raw_snapshot
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
      g.thumbnailUrl = extractThumbnail(r.raw_snapshot);
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
