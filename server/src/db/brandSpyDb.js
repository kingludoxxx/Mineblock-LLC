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
  if (raw.videos?.[0]?.video_preview_image_url) return raw.videos[0].video_preview_image_url;
  if (raw.images?.[0]?.resized_image_url) return raw.images[0].resized_image_url;
  if (raw.images?.[0]?.original_image_url) return raw.images[0].original_image_url;
  return raw.page_profile_picture_url ?? null;
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

  if (q.format) {
    where.push(`a.display_format = $${p++}`);
    params.push(q.format);
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
