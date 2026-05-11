import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { pgQuery } from '../db/pg.js';
import { randomUUID } from 'crypto';

const router = Router();

// ── Config ────────────────────────────────────────────────────────────────────
const TW_API_KEY           = process.env.TRIPLEWHALE_API_KEY || '';
const TW_SHOP_ID           = process.env.TRIPLEWHALE_SHOP_ID || '17cca0-2.myshopify.com';
const TW_SQL_URL           = 'https://api.triplewhale.com/api/v2/orcabase/api/sql';
const TW_ATTRIBUTION_MODEL = process.env.TW_ATTRIBUTION_MODEL || 'lastPlatformClick';
const TW_REVENUE_COL       = process.env.TW_REVENUE_COL || 'order_revenue';
const CRON_SECRET          = process.env.CRON_SECRET || '';
const META_ACCESS_TOKEN    = process.env.META_ACCESS_TOKEN || '';
const META_GRAPH_URL       = 'https://graph.facebook.com/v22.0';
const CLICKUP_TOKEN        = process.env.CLICKUP_API_TOKEN || '';
const CLICKUP_LIST_ID      = '901518716584';
const CLICKUP_TEAM_ID      = '90152075024';
const CLICKUP_BRIEF_FIELD  = '62b61cc4-2d35-4dfc-86f4-a3913e2bbca3';

const REV_COLS = [TW_REVENUE_COL, 'order_revenue', 'channel_reported_conversion_value'];
const PUR_COLS = ['website_purchases', 'channel_reported_conversions'];
const uniqueRevCols = [...new Set(REV_COLS)];
const uniquePurCols = [...new Set(PUR_COLS)];

// ── DB setup ──────────────────────────────────────────────────────────────────
async function ensureTables() {
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS ads_report_cache (
      range_key    TEXT        NOT NULL PRIMARY KEY,
      start_date   DATE        NOT NULL,
      end_date     DATE        NOT NULL,
      share_token  TEXT        NOT NULL UNIQUE,
      data         JSONB       NOT NULL DEFAULT '[]',
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Permanent cache of Meta Graph resolutions per ad_id. ad creatives don't
  // change after launch, so we can cache forever and dodge the Meta API
  // rate limit (which we were hammering every cache refresh).
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS meta_ad_resolutions (
      ad_id        TEXT PRIMARY KEY,
      fb_link      TEXT,
      created_time DATE,
      resolved_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Permanent cache of ClickUp task URLs per brief number. Avoids hitting the
  // ClickUp API on every page load for older briefs not in brief_pipeline_*.
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS clickup_brief_resolutions (
      brief_number INTEGER PRIMARY KEY,
      task_id      TEXT,
      task_url     TEXT NOT NULL,
      resolved_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

// ── Date range helpers ────────────────────────────────────────────────────────
const PRESET_KEYS = new Set([
  'today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month',
  'last_7_days', 'last_14_days', 'last_30_days', 'last_90_days', 'last_365_days', 'lifetime',
]);

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fmt = (d) => d.toISOString().slice(0, 10);
const labelDay = (d) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
const utcDay = (now) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

const PRESET_LABELS = {
  today: 'Today',
  yesterday: 'Yesterday',
  this_week: 'This week',
  last_week: 'Last week',
  this_month: 'This month',
  last_month: 'Last month',
  last_7_days: 'Last 7 days',
  last_14_days: 'Last 14 days',
  last_30_days: 'Last 30 days',
  last_90_days: 'Last 90 days',
  last_365_days: 'Last 365 days',
  lifetime: 'Lifetime',
};

function getDateRange(rangeKey, customFrom, customTo) {
  const now   = new Date();
  const today = utcDay(now);
  const dow   = today.getUTCDay();
  const daysFromMon = dow === 0 ? 6 : dow - 1;

  let start, end, label = PRESET_LABELS[rangeKey] || rangeKey;

  switch (rangeKey) {
    case 'today':
      start = end = new Date(today);
      label = `Today · ${labelDay(today)}`;
      break;
    case 'yesterday': {
      const y = new Date(today); y.setUTCDate(today.getUTCDate() - 1);
      start = end = y;
      label = `Yesterday · ${labelDay(y)}`;
      break;
    }
    case 'this_week': {
      const ws = new Date(today); ws.setUTCDate(today.getUTCDate() - daysFromMon);
      start = ws; end = today;
      label = `This week · ${labelDay(ws)} – ${labelDay(today)}`;
      break;
    }
    case 'last_week': {
      const we = new Date(today); we.setUTCDate(today.getUTCDate() - daysFromMon - 1);
      const ws = new Date(we); ws.setUTCDate(we.getUTCDate() - 6);
      start = ws; end = we;
      label = `Last week · ${labelDay(ws)} – ${labelDay(we)}`;
      break;
    }
    case 'this_month': {
      const ms = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
      start = ms; end = today;
      label = `${MONTHS[today.getUTCMonth()]} · ${labelDay(ms)} – ${labelDay(today)}`;
      break;
    }
    case 'last_month': {
      const ms = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
      const me = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
      start = ms; end = me;
      label = `${MONTHS[ms.getUTCMonth()]} · ${labelDay(ms)} – ${labelDay(me)}`;
      break;
    }
    case 'last_7_days': {
      const s = new Date(today); s.setUTCDate(today.getUTCDate() - 6);
      start = s; end = today;
      label = `Last 7 days · ${labelDay(s)} – ${labelDay(today)}`;
      break;
    }
    case 'last_14_days': {
      const s = new Date(today); s.setUTCDate(today.getUTCDate() - 13);
      start = s; end = today;
      label = `Last 14 days · ${labelDay(s)} – ${labelDay(today)}`;
      break;
    }
    case 'last_30_days': {
      const s = new Date(today); s.setUTCDate(today.getUTCDate() - 29);
      start = s; end = today;
      label = `Last 30 days · ${labelDay(s)} – ${labelDay(today)}`;
      break;
    }
    case 'last_90_days': {
      const s = new Date(today); s.setUTCDate(today.getUTCDate() - 89);
      start = s; end = today;
      label = `Last 90 days · ${labelDay(s)} – ${labelDay(today)}`;
      break;
    }
    case 'last_365_days': {
      const s = new Date(today); s.setUTCDate(today.getUTCDate() - 364);
      start = s; end = today;
      label = `Last 365 days`;
      break;
    }
    case 'lifetime': {
      start = new Date(Date.UTC(2020, 0, 1));
      end = today;
      label = `Lifetime · since ${labelDay(start)} ${start.getUTCFullYear()}`;
      break;
    }
    case 'custom': {
      if (!customFrom || !customTo) throw new Error('custom range requires from/to');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(customFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(customTo))
        throw new Error('custom from/to must be YYYY-MM-DD');
      start = new Date(customFrom + 'T00:00:00Z');
      end   = new Date(customTo   + 'T00:00:00Z');
      if (isNaN(start) || isNaN(end)) throw new Error('invalid custom dates');
      if (start > end) throw new Error('from must be ≤ to');
      label = `${labelDay(start)} – ${labelDay(end)}`;
      break;
    }
    default:
      throw new Error(`Unknown range: ${rangeKey}`);
  }

  return {
    key:   rangeKey === 'custom' ? `custom:${fmt(start)}:${fmt(end)}` : rangeKey,
    start: fmt(start),
    end:   fmt(end),
    label,
  };
}

// ── Triple Whale query ────────────────────────────────────────────────────────
async function fetchTwData(startDate, endDate) {
  if (!TW_API_KEY) throw new Error('TRIPLEWHALE_API_KEY not set');

  async function twQuery(sql) {
    const res = await fetch(TW_SQL_URL, {
      method:  'POST',
      headers: { 'x-api-key': TW_API_KEY, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        shopId:           TW_SHOP_ID,
        query:            sql.trim(),
        period:           { startDate, endDate },
        attributionModel: TW_ATTRIBUTION_MODEL,
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (res.status === 401 || res.status === 403) {
      const text = await res.text();
      console.error(`[Ads Report] TW auth error ${res.status}: ${text.slice(0, 200)}`);
      return { ok: false, fatal: true };
    }
    if (!res.ok) {
      const text = await res.text();
      console.error(`[Ads Report] TW query error ${res.status}: ${text.slice(0, 200)}`);
      return { ok: false, fatal: false };
    }
    const data = await res.json();
    const rows = Array.isArray(data) ? data : (data?.data || data?.rows || []);
    return { ok: true, rows };
  }

  // Try the rich query (campaign_name + ad_id + purchases + new-customer orders).
  // TW is ClickHouse-flavored: CAST uses `String` (not `STRING`).
  // NVP is computed from `new_customer_orders` (the actual TW column for
  // first-time-buyer orders); the legacy `new_visitor_rate` does not exist.
  for (const revCol of uniqueRevCols) {
    const revRef = revCol.includes(' ') ? `\`${revCol}\`` : revCol;
    for (const purCol of uniquePurCols) {
      const purRef = purCol.includes(' ') ? `\`${purCol}\`` : purCol;
      const result = await twQuery(`
        SELECT
          ad_name,
          MAX(campaign_name) AS campaign_name,
          MAX(toString(ad_id)) AS ad_id,
          SUM(spend) AS total_spend,
          SUM(${revRef}) AS total_revenue,
          SUM(${purRef}) AS total_purchases,
          SUM(new_customer_orders) AS total_new_customer_orders
        FROM pixel_joined_tvf
        WHERE event_date BETWEEN @startDate AND @endDate
          AND channel = 'facebook-ads'
        GROUP BY ad_name
        HAVING SUM(spend) > 0.01
        ORDER BY SUM(spend) DESC
        LIMIT 5000
      `);
      if (result.fatal) throw new Error('TW API auth/server error — check TRIPLEWHALE_API_KEY');
      if (result.ok) {
        console.log(`[Ads Report] TW success rev="${revCol}" pur="${purCol}" rows=${result.rows.length}`);
        return { rows: result.rows, revCol, purCol, hasCampaign: true, hasAdId: true, hasNvp: true };
      }
    }
  }

  // Fallback: drop ad_id (in case toString or ad_id column unavailable)
  for (const revCol of uniqueRevCols) {
    const revRef = revCol.includes(' ') ? `\`${revCol}\`` : revCol;
    for (const purCol of uniquePurCols) {
      const purRef = purCol.includes(' ') ? `\`${purCol}\`` : purCol;
      const result = await twQuery(`
        SELECT
          ad_name,
          MAX(campaign_name) AS campaign_name,
          SUM(spend) AS total_spend,
          SUM(${revRef}) AS total_revenue,
          SUM(${purRef}) AS total_purchases
        FROM pixel_joined_tvf
        WHERE event_date BETWEEN @startDate AND @endDate
          AND channel = 'facebook-ads'
        GROUP BY ad_name
        HAVING SUM(spend) > 0.01
        ORDER BY SUM(spend) DESC
        LIMIT 5000
      `);
      if (result.ok) {
        console.warn(`[Ads Report] TW fallback no ad_id rev="${revCol}" pur="${purCol}"`);
        return { rows: result.rows, revCol, purCol, hasCampaign: true, hasAdId: false };
      }
    }
  }

  // Fallback: drop campaign_name too
  for (const revCol of uniqueRevCols) {
    const revRef = revCol.includes(' ') ? `\`${revCol}\`` : revCol;
    for (const purCol of uniquePurCols) {
      const purRef = purCol.includes(' ') ? `\`${purCol}\`` : purCol;
      const result = await twQuery(`
        SELECT
          ad_name,
          SUM(spend) AS total_spend,
          SUM(${revRef}) AS total_revenue,
          SUM(${purRef}) AS total_purchases
        FROM pixel_joined_tvf
        WHERE event_date BETWEEN @startDate AND @endDate
          AND channel = 'facebook-ads'
        GROUP BY ad_name
        HAVING SUM(spend) > 0.01
        ORDER BY SUM(spend) DESC
        LIMIT 5000
      `);
      if (result.ok) {
        console.warn(`[Ads Report] TW fallback no campaign rev="${revCol}" pur="${purCol}"`);
        return { rows: result.rows, revCol, purCol, hasCampaign: false, hasAdId: false };
      }
    }
  }

  // Last-resort: revenue only
  for (const revCol of uniqueRevCols) {
    const revRef = revCol.includes(' ') ? `\`${revCol}\`` : revCol;
    const result = await twQuery(`
      SELECT ad_name, SUM(spend) AS total_spend, SUM(${revRef}) AS total_revenue
      FROM pixel_joined_tvf
      WHERE event_date BETWEEN @startDate AND @endDate
        AND channel = 'facebook-ads'
      GROUP BY ad_name
      HAVING SUM(spend) > 0.01
      ORDER BY SUM(spend) DESC
      LIMIT 500
    `);
    if (result.ok) {
      console.warn(`[Ads Report] TW minimal fallback rev="${revCol}"`);
      return { rows: result.rows, revCol, purCol: null, hasCampaign: false, hasAdId: false };
    }
  }

  throw new Error('TW query failed — all column combinations rejected');
}

// ── Meta ad-id → real Facebook post link ──────────────────────────────────────
// Uses ad_id from Triple Whale first, then falls back to creative_analysis DB lookup.
// Resolves to actual FB post URL via effective_object_story_id when available.
async function enrichWithMetaLinks(rows) {
  const map = {};

  // 1. Build ad_name → ad_id map: prefer TW ad_id, fall back to creative_analysis
  const adIdMap = {};
  for (const r of rows) {
    if (r.ad_name && r.ad_id) adIdMap[r.ad_name] = String(r.ad_id);
  }

  const missingAdNames = rows
    .filter(r => r.ad_name && !adIdMap[r.ad_name])
    .map(r => r.ad_name);

  if (missingAdNames.length) {
    try {
      const result = await pgQuery(
        `SELECT ad_name, meta_ad_id FROM creative_analysis
         WHERE ad_name = ANY($1) AND meta_ad_id IS NOT NULL`,
        [missingAdNames]
      );
      for (const r of (result || [])) {
        if (r.ad_name && r.meta_ad_id) adIdMap[r.ad_name] = String(r.meta_ad_id);
      }
    } catch (err) {
      console.error('[Ads Report] creative_analysis lookup failed:', err.message);
    }
  }

  if (!Object.keys(adIdMap).length) return { links: map, created: {} };
  if (!META_ACCESS_TOKEN) {
    // No token — best we can do is link to Ads Library
    for (const [adName, adId] of Object.entries(adIdMap)) {
      map[adName] = `https://www.facebook.com/ads/library/?id=${adId}`;
    }
    return { links: map, created: {} };
  }

  // 2. Resolve each ad_id to actual FB post + created_time via Graph API.
  // Permanently cache resolutions in `meta_ad_resolutions` so each ad_id is
  // fetched ONCE ever. Ad creatives don't change after launch, so this is
  // safe to cache forever and saves us from Meta's strict rate limit
  // (which we were hammering every cache refresh).
  const FIELDS = 'created_time,creative{effective_object_story_id,object_story_id,instagram_permalink_url,effective_instagram_media_id}';
  const createdMap = {};
  const allAdIds = [...new Set(Object.values(adIdMap))];

  // Pull whatever we already resolved
  const cached = {};
  try {
    const rows = await pgQuery(
      `SELECT ad_id, fb_link, created_time FROM meta_ad_resolutions WHERE ad_id = ANY($1)`,
      [allAdIds]
    );
    for (const r of (rows || [])) {
      cached[r.ad_id] = { fb_link: r.fb_link, created_time: r.created_time };
    }
  } catch (err) {
    console.error('[Ads Report] meta_ad_resolutions read failed:', err.message);
  }

  let cacheHit = 0, fetched = 0, realPostCount = 0, libraryCount = 0, rateLimited = 0, sampleLogged = false;
  const newRows = []; // pending writes to meta_ad_resolutions

  // Apply cached resolutions first
  for (const [adName, adId] of Object.entries(adIdMap)) {
    if (cached[adId]) {
      cacheHit++;
      map[adName] = cached[adId].fb_link || `https://www.facebook.com/ads/library/?id=${adId}`;
      if (cached[adId].fb_link && !cached[adId].fb_link.includes('/ads/library/')) realPostCount++;
      else libraryCount++;
      if (cached[adId].created_time) {
        const c = cached[adId].created_time;
        createdMap[adName] = (c instanceof Date) ? c.toISOString().slice(0, 10) : String(c).slice(0, 10);
      }
    }
  }

  // Fetch the rest. Throttle to 5 concurrent so we don't trigger rate limits.
  const toFetch = Object.entries(adIdMap).filter(([_, id]) => !cached[id]);
  const CONCURRENCY = 5;
  for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
    const batch = toFetch.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async ([adName, adId]) => {
      let resolvedFbLink = null;
      let resolvedCreatedTime = null;
      try {
        const url = `${META_GRAPH_URL}/${adId}?fields=${encodeURIComponent(FIELDS)}&access_token=${META_ACCESS_TOKEN}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (res.ok) {
          const d = await res.json();
          if (!sampleLogged) {
            console.log(`[Ads Report] Meta sample adId=${adId}:`, JSON.stringify(d).slice(0, 500));
            sampleLogged = true;
          }
          if (d?.created_time && typeof d.created_time === 'string' && d.created_time.length >= 10) {
            resolvedCreatedTime = d.created_time.slice(0, 10);
            createdMap[adName] = resolvedCreatedTime;
          }
          const c = d?.creative || {};
          const eosi    = c.effective_object_story_id || c.object_story_id;
          const igPerma = c.instagram_permalink_url;
          if (eosi && /^\d+_\d+$/.test(eosi)) {
            const [pageId, postId] = eosi.split('_');
            resolvedFbLink = `https://www.facebook.com/${pageId}/posts/${postId}`;
          } else if (igPerma) {
            resolvedFbLink = igPerma;
          }
        } else {
          const errText = await res.text();
          if (errText.includes('rate') || errText.includes('80004') || res.status === 429) {
            rateLimited++;
          }
          if (!sampleLogged) {
            console.warn(`[Ads Report] Meta error ${res.status} adId=${adId}: ${errText.slice(0, 300)}`);
            sampleLogged = true;
          }
        }
      } catch (err) {
        // fall through to library fallback
      }
      fetched++;
      if (resolvedFbLink) { map[adName] = resolvedFbLink; realPostCount++; }
      else { map[adName] = `https://www.facebook.com/ads/library/?id=${adId}`; libraryCount++; }
      // Save the resolution — but ONLY if we got something real OR a non-rate-limit
      // error. We don't want to permanently cache "library fallback" results that
      // came from a rate-limit response (they'll resolve properly next time).
      if (resolvedFbLink) {
        newRows.push({ ad_id: adId, fb_link: resolvedFbLink, created_time: resolvedCreatedTime });
      }
    }));
  }

  // Bulk-insert new resolutions
  if (newRows.length) {
    try {
      const values = newRows.map((_, i) => `($${i*3+1}, $${i*3+2}, $${i*3+3})`).join(',');
      const params = [];
      for (const r of newRows) {
        params.push(r.ad_id, r.fb_link, r.created_time);
      }
      await pgQuery(
        `INSERT INTO meta_ad_resolutions (ad_id, fb_link, created_time) VALUES ${values}
         ON CONFLICT (ad_id) DO UPDATE SET
           fb_link = COALESCE(EXCLUDED.fb_link, meta_ad_resolutions.fb_link),
           created_time = COALESCE(EXCLUDED.created_time, meta_ad_resolutions.created_time),
           resolved_at = NOW()`,
        params
      );
    } catch (err) {
      console.error('[Ads Report] meta_ad_resolutions write failed:', err.message);
    }
  }

  console.log(`[Ads Report] Meta links: cacheHit=${cacheHit} fetched=${fetched} realPosts=${realPostCount} libraryFallback=${libraryCount} rateLimited=${rateLimited} total=${Object.keys(adIdMap).length}`);
  return { links: map, created: createdMap };
}

// ── Avatar / Angle / Date Launched parser ────────────────────────────────────
function weekToDate(weekNum, year) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dow  = jan4.getUTCDay();
  const mon  = new Date(jan4);
  mon.setUTCDate(jan4.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  mon.setUTCDate(mon.getUTCDate() + (weekNum - 1) * 7);
  return mon.toISOString().slice(0, 10);
}

function parseAdName(adName) {
  if (!adName) return { avatar: null, angle: null, format: null, editor: null, dateLaunched: null };
  const parts = adName.split(' - ').map(p => p?.trim() || '');
  const weekIdx = parts.findIndex(p => /^WK\d+_\d{4}/i.test(p));

  let dateLaunched = null;
  if (weekIdx >= 0) {
    const m = parts[weekIdx].match(/^WK(\d+)_(\d{4})/i);
    if (m) dateLaunched = weekToDate(parseInt(m[1], 10), parseInt(m[2], 10));
  }

  // Naming convention (anchored on WK marker, right-to-left):
  //   weekIdx - 6 = Avatar     (e.g. MoneySeeker)
  //   weekIdx - 5 = Angle      (e.g. Lottery)
  //   weekIdx - 4 = Format     (e.g. ShortVid, Mashup, UGC)
  //   weekIdx - 1 = Editor     (e.g. Elizaveta, Muhammad, Antoni)
  // Reject placeholders (NA / "-" / empty) AND pure-number tails ("4", "6")
  // so sequence-number suffixes from short non-WK names ("Urgency - 4")
  // don't get parsed as editors.
  const cleanEditor = (s) => {
    if (!s) return null;
    let v = s.trim();
    // Strip trailing dashes/whitespace ("Mashup -" → "Mashup", "Antoni-" → "Antoni")
    v = v.replace(/[\s-]+$/, '').trim();
    if (!v || v === '-' || /^N\/?A$/i.test(v)) return null;
    if (/^\d+$/.test(v)) return null;                       // pure number
    if (/^WK\d+_\d{4}/i.test(v)) return null;               // stray WK marker
    if (/^Copy\b/i.test(v) || /^v\d+$/i.test(v)) return null; // version tails
    return v;
  };

  if (weekIdx >= 6) {
    return {
      avatar: parts[weekIdx - 6] || null,
      angle:  parts[weekIdx - 5] || null,
      format: parts[weekIdx - 4] || null,
      editor: cleanEditor(parts[weekIdx - 1]),
      dateLaunched,
    };
  }
  // Names without a WK marker: only attempt to extract editor when the name
  // is long enough to plausibly follow the brief convention
  // (MR - B#### - H# - <geo> - <NA> - <Avatar> - <Angle> - <Format> - … - <Editor>).
  // Short names like "Urgency - 4" return null for editor — that "4" is a
  // sequence number, not a person.
  const editor = parts.length >= 8 ? cleanEditor(parts[parts.length - 1]) : null;
  return {
    avatar: parts[5] || null,
    angle:  parts[6] || null,
    format: parts[7] || null,
    editor,
    dateLaunched,
  };
}

// ── ClickUp task URL lookup ───────────────────────────────────────────────────
async function enrichWithClickUpLinks(rows) {
  // Normalise away Meta-generated " – Copy" suffixes so we don't make
  // duplicate ClickUp lookups for the same underlying ad.
  const adNames = [...new Set(rows.map(r => normalizeAdName(r.ad_name)).filter(Boolean))];
  if (!adNames.length) return {};

  const creativeIdMap = {};
  const briefNumMap   = {};
  for (const adName of adNames) {
    const seg = adName.split(' - ')[1]?.trim();
    const m = seg?.match(/^B(\d+)$/);
    if (m) {
      creativeIdMap[adName] = seg;
      briefNumMap[adName]   = parseInt(m[1], 10);
    }
  }

  const creativeIds = [...new Set(Object.values(creativeIdMap))];
  const briefNums   = [...new Set(Object.values(briefNumMap))];
  if (!creativeIds.length) return {};

  const urlByCreativeId = {};
  const urlByBriefNum   = {};

  try {
    const winners = await pgQuery(
      `SELECT creative_id, clickup_task_id FROM brief_pipeline_winners
       WHERE creative_id = ANY($1) AND clickup_task_id IS NOT NULL`,
      [creativeIds]
    );
    for (const r of (winners || [])) {
      if (r.creative_id && r.clickup_task_id)
        urlByCreativeId[r.creative_id] = `https://app.clickup.com/t/${r.clickup_task_id}`;
    }
  } catch (err) {
    console.error('[Ads Report] ClickUp winners lookup failed:', err.message);
  }

  try {
    if (briefNums.length) {
      const generated = await pgQuery(
        `SELECT DISTINCT ON (brief_number) brief_number, clickup_task_url
         FROM brief_pipeline_generated
         WHERE brief_number = ANY($1) AND clickup_task_url IS NOT NULL
         ORDER BY brief_number, pushed_at DESC`,
        [briefNums]
      );
      for (const r of (generated || [])) {
        if (r.brief_number && r.clickup_task_url)
          urlByBriefNum[r.brief_number] = r.clickup_task_url;
      }
    }
  } catch (err) {
    console.error('[Ads Report] ClickUp generated lookup failed:', err.message);
  }

  const map = {};
  for (const adName of adNames) {
    const cid = creativeIdMap[adName];
    const num = briefNumMap[adName];
    const url = (cid && urlByCreativeId[cid]) || (num && urlByBriefNum[num]) || null;
    if (url) map[adName] = url;
  }

  // Check the permanent resolution cache for any still-missing briefs
  const stillMissingNums = [...new Set(
    adNames.filter(n => !map[n] && briefNumMap[n] != null).map(n => briefNumMap[n])
  )];
  if (stillMissingNums.length) {
    try {
      const cached = await pgQuery(
        `SELECT brief_number, task_url FROM clickup_brief_resolutions WHERE brief_number = ANY($1)`,
        [stillMissingNums]
      );
      const urlByNumCache = {};
      for (const r of (cached || [])) urlByNumCache[r.brief_number] = r.task_url;
      for (const adName of adNames) {
        if (!map[adName] && briefNumMap[adName] != null)
          if (urlByNumCache[briefNumMap[adName]]) map[adName] = urlByNumCache[briefNumMap[adName]];
      }
    } catch (err) {
      console.error('[Ads Report] ClickUp resolution cache lookup failed:', err.message);
    }
  }

  // Fallback: ClickUp API (custom field, then name search)
  const missing = adNames.filter(n => !map[n] && briefNumMap[n] != null);
  if (missing.length && CLICKUP_TOKEN) {
    console.log(`[Ads Report] ClickUp DB miss ${missing.length} briefs — falling back to API`);
    // Dedupe by brief number so we don't make N parallel calls for the same brief
    const missingByNum = new Map();
    for (const adName of missing) {
      const num = briefNumMap[adName];
      if (!missingByNum.has(num)) missingByNum.set(num, []);
      missingByNum.get(num).push(adName);
    }
    const apiResults = await Promise.all(
      [...missingByNum.entries()].map(async ([num, adNamesForNum]) => {
        try {
          const filter = encodeURIComponent(JSON.stringify([{
            field_id: CLICKUP_BRIEF_FIELD,
            operator: '=',
            value: String(num),
          }]));
          const res = await fetch(
            `https://api.clickup.com/api/v2/list/${CLICKUP_LIST_ID}/task?custom_fields=${filter}&include_closed=true`,
            { headers: { Authorization: CLICKUP_TOKEN }, signal: AbortSignal.timeout(12000) }
          );
          let task = null;
          if (res.ok) {
            const data = await res.json();
            task = (data.tasks || [])[0] || null;
          }

          if (!task) {
            // Team-wide search — older briefs may live in a different list.
            const briefCode = `B${String(num).padStart(4, '0')}`;
            const searchRes = await fetch(
              `https://api.clickup.com/api/v2/team/${CLICKUP_TEAM_ID}/task?query=${encodeURIComponent(briefCode)}&include_closed=true`,
              { headers: { Authorization: CLICKUP_TOKEN }, signal: AbortSignal.timeout(12000) }
            );
            if (searchRes.ok) {
              const sd = await searchRes.json();
              const tasks = sd.tasks || [];
              task = tasks.find(t => t.name?.includes(briefCode))
                  || tasks.find(t => t.name?.match(new RegExp(`\\bB?0*${num}\\b`)))
                  || null;
            }
          }

          if (!task) return [num, adNamesForNum, null];
          const url = task.url || `https://app.clickup.com/t/${task.id}`;
          return [num, adNamesForNum, url];
        } catch (err) {
          console.error(`[Ads Report] ClickUp API fallback failed for B${String(num).padStart(4,'0')}:`, err.message);
          return [num, adNamesForNum, null];
        }
      })
    );

    // Apply results and write successes to the permanent cache
    const toCache = [];
    for (const [num, adNamesForNum, url] of apiResults) {
      if (url) {
        for (const adName of adNamesForNum) map[adName] = url;
        toCache.push([num, url]);
      }
    }
    if (toCache.length) {
      pgQuery(
        `INSERT INTO clickup_brief_resolutions (brief_number, task_url)
         SELECT n, u FROM unnest($1::int[], $2::text[]) AS t(n, u)
         ON CONFLICT (brief_number) DO UPDATE SET task_url = EXCLUDED.task_url, resolved_at = NOW()`,
        [toCache.map(([n]) => n), toCache.map(([, u]) => u)]
      ).catch(err => console.error('[Ads Report] ClickUp cache write failed:', err.message));
    }
  }

  // Final fallback — every ad that has a brief code still gets a clickable
  // ClickUp icon, but it points at the list view (search-pre-filtered by
  // brief code) so the user can find or create the task themselves.
  // Non-brief-coded ads (e.g. "Urgency - 1", "Lottery - 6") get nothing.
  let resolved = 0, listFallback = 0;
  for (const adName of adNames) {
    if (map[adName]) { resolved++; continue; }
    const num = briefNumMap[adName];
    if (num != null) {
      const briefCode = `B${String(num).padStart(4, '0')}`;
      map[adName] = `https://app.clickup.com/${CLICKUP_TEAM_ID}/v/li/${CLICKUP_LIST_ID}?query=${encodeURIComponent(briefCode)}`;
      listFallback++;
    }
  }

  console.log(`[Ads Report] ClickUp links: resolved=${resolved} listFallback=${listFallback} total=${adNames.length}`);
  return map;
}

// ── Build report rows ─────────────────────────────────────────────────────────
// When an ad is duplicated inside Meta Ads Manager the platform appends
// " – Copy" (or " - Copy", " – Copy 2", etc.) to the ad name.  Triple Whale
// tracks each ad separately, so the same creative shows up as two rows.
// Strip the suffix and merge those rows so reporting reflects one ad.
const COPY_SUFFIX_RE = /\s*[–—-]\s*Copy(\s+\d+)?\s*$/i;
function normalizeAdName(name) {
  return (name || '').replace(COPY_SUFFIX_RE, '').trimEnd();
}

function buildReportRows(twResult, metaResult, clickupLinks) {
  const { rows } = twResult;
  const { links: metaLinks, created: metaCreated } = metaResult;

  // First pass: build raw rows keyed by normalised ad name.
  // When two raw names normalise to the same string (original + copy) we
  // sum the numeric metrics and prefer the canonical (non-copy) name for
  // the FB/ClickUp links so we keep the best-resolved URL.
  const mergedMap = new Map(); // normalisedName → merged raw row

  for (const r of rows) {
    const norm = normalizeAdName(r.ad_name);
    const isCopy = COPY_SUFFIX_RE.test(r.ad_name || '');
    if (!mergedMap.has(norm)) {
      mergedMap.set(norm, { ...r, _canonical: isCopy ? null : r.ad_name });
    } else {
      const m = mergedMap.get(norm);
      m.total_spend    = (parseFloat(m.total_spend    || 0) + parseFloat(r.total_spend    || 0));
      m.total_revenue  = (parseFloat(m.total_revenue  || 0) + parseFloat(r.total_revenue  || 0));
      m.total_purchases= (parseFloat(m.total_purchases|| 0) + parseFloat(r.total_purchases|| 0));
      if (r.total_new_customer_orders != null)
        m.total_new_customer_orders = (parseFloat(m.total_new_customer_orders || 0) + parseFloat(r.total_new_customer_orders));
      // Prefer the non-copy ad name for link lookups
      if (!isCopy) m._canonical = r.ad_name;
      // campaign_name: keep whichever is non-empty
      if (!m.campaign_name && r.campaign_name) m.campaign_name = r.campaign_name;
    }
  }

  const mergedRows = [...mergedMap.values()];
  const mergedCount = rows.length - mergedRows.length;
  if (mergedCount > 0)
    console.log(`[Ads Report] Merged ${mergedCount} Meta-copy duplicate ad name(s) into their originals`);

  const enriched = mergedRows.map(r => {
    const spend     = parseFloat(r.total_spend     || 0);
    const revenue   = parseFloat(r.total_revenue   || 0);
    const purchases = parseFloat(r.total_purchases || 0);
    const roas      = spend > 0 ? +(revenue / spend).toFixed(2) : 0;
    const cpa       = purchases > 0 ? +(spend / purchases).toFixed(2) : null;
    const aov       = purchases > 0 ? +(revenue / purchases).toFixed(2) : null;
    // NVP = new-visitor-purchase rate = new_customer_orders / total_purchases × 100.
    // Only computed when the rich query ran AND there was at least 1 purchase.
    const nvp       = (r.total_new_customer_orders != null && purchases > 0)
      ? +(100 * parseFloat(r.total_new_customer_orders) / purchases).toFixed(1)
      : null;

    // Use canonical (non-copy) name for display and link lookups
    const displayName = r._canonical || normalizeAdName(r.ad_name);
    const { avatar, angle, format, editor, dateLaunched } = parseAdName(displayName);

    return {
      adName:       displayName,
      campaignName: r.campaign_name || '',
      fbLink:       metaLinks[r._canonical || r.ad_name] || metaLinks[r.ad_name] || null,
      clickupUrl:   clickupLinks[r._canonical || r.ad_name] || clickupLinks[r.ad_name] || null,
      spend:        +spend.toFixed(2),
      roas,
      purchases:    purchases > 0 ? Math.round(purchases) : null,
      cpa,
      aov,
      nvp,
      avatar,
      angle,
      format,
      editor,
      // Prefer the WK marker parsed out of the ad name; fall back to Meta's
      // created_time so non-brief-coded ads (e.g. "Urgency - 1") still get a
      // launch date.
      dateLaunched: dateLaunched || metaCreated[r._canonical || r.ad_name] || metaCreated[r.ad_name] || null,
    };
  });

  const totalAds       = enriched.length;
  const adsWithSpend   = enriched.filter(r => r.spend >= 1).length;
  const adsAbove100    = enriched.filter(r => r.spend >= 100).length;
  const winning        = enriched
    .filter(r => r.spend >= 100 && r.roas >= 1.6)
    .length;

  // Return ALL ads with non-trivial spend, sorted by spend desc. The frontend
  // applies user-configurable spend/ROAS thresholds — the server should never
  // hide an ad just because it doesn't currently meet the "winning" bar.
  const out = enriched
    .filter(r => r.spend >= 1)
    .sort((a, b) => b.spend - a.spend);

  console.log(
    `[Ads Report] AUDIT total=${totalAds} spend≥$1=${adsWithSpend} spend≥$100=${adsAbove100} winning(≥$100 & ROAS≥1.6)=${winning} returned=${out.length}`
  );

  return out;
}

// ── Main refresh function ─────────────────────────────────────────────────────
async function refreshReport(rangeKey, customFrom, customTo) {
  await ensureTables();
  const range = getDateRange(rangeKey, customFrom, customTo);

  const twResult     = await fetchTwData(range.start, range.end);
  const [metaResult, clickupLinks] = await Promise.all([
    enrichWithMetaLinks(twResult.rows),
    enrichWithClickUpLinks(twResult.rows),
  ]);
  const report = buildReportRows(twResult, metaResult, clickupLinks);

  await pgQuery(`
    INSERT INTO ads_report_cache (range_key, start_date, end_date, share_token, data, generated_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (range_key) DO UPDATE SET
      start_date   = EXCLUDED.start_date,
      end_date     = EXCLUDED.end_date,
      data         = EXCLUDED.data,
      generated_at = NOW()
  `, [range.key, range.start, range.end, randomUUID(), JSON.stringify(report)]);

  const [row] = await pgQuery(
    `SELECT * FROM ads_report_cache WHERE range_key = $1`, [range.key]
  );

  console.log(`[Ads Report] Refreshed ${range.label}: ${report.length} qualifying ads`);
  return { range, report, shareToken: row.share_token, generatedAt: row.generated_at };
}

// pg returns JSONB columns as strings in some driver configurations
const parseDbData = (d) => (typeof d === 'string' ? JSON.parse(d) : d) || [];

// Detect cache rows produced by an older code version. Triggers a refresh if:
//   • format or editor fields are missing entirely (legacy schema)
//   • any editor value is a pure number ("4", "5") — sequence-suffix bug
//   • any editor value still has a trailing " -" (dash-tail bug)
function hasLegacyCacheShape(rawData) {
  const arr = parseDbData(rawData);
  if (!arr.length) return false;
  const sample = arr[0];
  if (sample.format === undefined || sample.editor === undefined) return true;
  for (const r of arr) {
    if (!r.editor) continue;
    if (/^\d+$/.test(r.editor)) return true;
    if (/\s-\s*$/.test(r.editor) || /-$/.test(r.editor)) return true;
  }
  return false;
}

// Determine cache TTL by range. "today"/"yesterday" need to be fresh; long ranges can be cached longer.
function staleThresholdMs(rangeKey) {
  if (rangeKey === 'today')        return  30 * 60 * 1000;   // 30 min
  if (rangeKey === 'yesterday')    return   6 * 60 * 60 * 1000; // 6h
  if (rangeKey === 'this_week')    return   2 * 60 * 60 * 1000; // 2h
  if (rangeKey === 'this_month')   return   2 * 60 * 60 * 1000; // 2h
  if (rangeKey?.startsWith('last_')) return 6 * 60 * 60 * 1000; // 6h
  if (rangeKey === 'lifetime')     return  24 * 60 * 60 * 1000; // 24h
  return 6 * 60 * 60 * 1000;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Public share endpoint — token-protected, no auth.
// Without `range`: returns the snapshot the share token was originally minted
// for. With `range` (or range=custom + from/to): the token grants access to
// any range, and we look up / refresh the corresponding cache row.
router.get('/public', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Missing token' });
  try {
    await ensureTables();

    // Validate the token first by finding ANY row that owns it
    const [tokenOwner] = await pgQuery(
      `SELECT range_key FROM ads_report_cache WHERE share_token = $1 LIMIT 1`, [token]
    );
    if (!tokenOwner) return res.status(404).json({ error: 'Report not found or link expired' });

    const requestedRange = req.query.range?.toString();
    const from = req.query.from?.toString();
    const to   = req.query.to?.toString();

    // No range param → return the original snapshot, refreshing first if
    // the row was produced by an older shape (missing format/editor).
    if (!requestedRange) {
      let [row] = await pgQuery(
        `SELECT * FROM ads_report_cache WHERE share_token = $1`, [token]
      );
      if (row && hasLegacyCacheShape(row.data)) {
        console.log(`[Ads Report] Legacy cache shape for share_token snapshot range_key="${row.range_key}" — refreshing`);
        await refreshReport(row.range_key);
        const refreshed = await pgQuery(
          `SELECT * FROM ads_report_cache WHERE share_token = $1`, [token]
        );
        if (refreshed[0]) row = refreshed[0];
      }
      return res.json({
        ok: true,
        range: { key: row.range_key, start: row.start_date, end: row.end_date, label: PRESET_LABELS[row.range_key] || row.range_key },
        generatedAt: row.generated_at,
        data: parseDbData(row.data),
      });
    }

    // Range param → validate, then return / refresh the corresponding cache row
    if (requestedRange !== 'custom' && !PRESET_KEYS.has(requestedRange)) {
      return res.status(400).json({ ok: false, error: `Unknown range: ${requestedRange}` });
    }
    let range;
    try { range = getDateRange(requestedRange, from, to); }
    catch (err) { return res.status(400).json({ ok: false, error: err.message }); }

    const [cached] = await pgQuery(
      `SELECT * FROM ads_report_cache WHERE range_key = $1`, [range.key]
    );

    const ttl = staleThresholdMs(requestedRange);
    const isStale = !cached || (Date.now() - new Date(cached.generated_at).getTime() > ttl);
    const isLegacy = cached && hasLegacyCacheShape(cached.data);

    if (!cached || isStale || isLegacy) {
      const result = await refreshReport(requestedRange, from, to);
      return res.json({
        ok: true,
        range: { key: range.key, start: range.start, end: range.end, label: range.label },
        generatedAt: result.generatedAt,
        data: result.report,
      });
    }
    return res.json({
      ok: true,
      range: { key: range.key, start: cached.start_date, end: cached.end_date, label: range.label },
      generatedAt: cached.generated_at,
      data: parseDbData(cached.data),
    });
  } catch (err) {
    console.error('[Ads Report] /public error:', err.message);
    return res.status(500).json({ error: 'Failed to load report' });
  }
});

// Cron: refresh all common ranges so the UI feels instant for the user.
// Runs ranges in parallel to keep total runtime bounded; cron only completes
// when ALL requested ranges finish or fail.
router.get('/cron/refresh', async (req, res) => {
  if (!CRON_SECRET || req.query.secret !== CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const targets = ['today', 'yesterday', 'this_week', 'last_week', 'last_7_days', 'last_14_days', 'last_30_days', 'last_90_days', 'this_month', 'last_month'];
  const settled = await Promise.allSettled(targets.map(k => refreshReport(k)));
  const results = settled.map((s, i) => {
    if (s.status === 'fulfilled') return { range: targets[i], rows: s.value.report.length, ok: true };
    console.error(`[Ads Report] cron refresh failed for ${targets[i]}:`, s.reason?.message);
    return { range: targets[i], ok: false, error: s.reason?.message };
  });
  return res.json({ ok: true, results });
});

// Cron data preview
router.get('/cron/data', async (req, res) => {
  if (!CRON_SECRET || req.query.secret !== CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    await ensureTables();
    const rangeKey = req.query.range || 'this_week';
    const [row] = await pgQuery(
      `SELECT * FROM ads_report_cache WHERE range_key = $1`, [rangeKey]
    );
    if (!row) return res.json({ ok: true, range: rangeKey, data: [], note: 'no cache yet' });
    return res.json({
      ok: true,
      range: { key: row.range_key, start: row.start_date, end: row.end_date },
      generatedAt: row.generated_at,
      shareToken: row.share_token,
      data: parseDbData(row.data),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Authenticated routes
router.use(authenticate, requirePermission('ads-reporting', 'access'));

async function handleReportRequest(req, res, defaultRangeKey = 'this_week') {
  try {
    await ensureTables();
    const rangeKey = (req.query.range || defaultRangeKey).toString();
    const from = req.query.from?.toString();
    const to   = req.query.to?.toString();

    if (rangeKey !== 'custom' && !PRESET_KEYS.has(rangeKey)) {
      return res.status(400).json({ ok: false, error: `Unknown range: ${rangeKey}` });
    }

    let range;
    try { range = getDateRange(rangeKey, from, to); }
    catch (err) { return res.status(400).json({ ok: false, error: err.message }); }

    const [cached] = await pgQuery(
      `SELECT * FROM ads_report_cache WHERE range_key = $1`, [range.key]
    );

    const forceRefresh = req.query.refresh === '1';
    const ttl = staleThresholdMs(rangeKey);
    const isStale = !cached || (Date.now() - new Date(cached.generated_at).getTime() > ttl);
    const isLegacy = cached && hasLegacyCacheShape(cached.data);
    if (isLegacy) console.log(`[Ads Report] Legacy cache shape for range_key="${range.key}" — forcing refresh`);

    if (!cached || forceRefresh || isStale || isLegacy) {
      const result = await refreshReport(rangeKey, from, to);
      return res.json({
        ok: true,
        range: { key: range.key, start: range.start, end: range.end, label: range.label },
        shareToken: result.shareToken,
        generatedAt: result.generatedAt,
        data: result.report,
      });
    }

    return res.json({
      ok: true,
      range: { key: range.key, start: cached.start_date, end: cached.end_date, label: range.label },
      shareToken: cached.share_token,
      generatedAt: cached.generated_at,
      data: parseDbData(cached.data),
    });
  } catch (err) {
    console.error('[Ads Report] /report error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// GET /report?range=this_week|last_week|...|custom&from=YYYY-MM-DD&to=YYYY-MM-DD&refresh=1
router.get('/report', (req, res) => handleReportRequest(req, res));

// GET /tw-probe — diagnostic: tries several candidate NVP column expressions
// against pixel_joined_tvf and reports which ones TW accepts. Use this to
// discover the right column without guessing in the main query path.
router.get('/tw-probe', async (req, res) => {
  if (!TW_API_KEY) return res.status(500).json({ error: 'TRIPLEWHALE_API_KEY not set' });
  const range = getDateRange('this_week');

  async function tryQuery(label, sql) {
    try {
      const r = await fetch(TW_SQL_URL, {
        method: 'POST',
        headers: { 'x-api-key': TW_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shopId: TW_SHOP_ID,
          query: sql.trim(),
          period: { startDate: range.start, endDate: range.end },
          attributionModel: TW_ATTRIBUTION_MODEL,
        }),
        signal: AbortSignal.timeout(20000),
      });
      const text = await r.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
      return { label, ok: r.ok, status: r.status, sample: Array.isArray(body) ? body[0] : body };
    } catch (err) {
      return { label, ok: false, error: err.message };
    }
  }

  const probes = [
    { label: 'star',                    sql: `SELECT * FROM pixel_joined_tvf WHERE event_date BETWEEN @startDate AND @endDate AND channel = 'facebook-ads' LIMIT 1` },
    { label: 'is_new_visitor',          sql: `SELECT AVG(is_new_visitor) AS x FROM pixel_joined_tvf WHERE event_date BETWEEN @startDate AND @endDate AND channel = 'facebook-ads' LIMIT 1` },
    { label: 'new_visitor_purchases',   sql: `SELECT SUM(new_visitor_purchases) AS x FROM pixel_joined_tvf WHERE event_date BETWEEN @startDate AND @endDate AND channel = 'facebook-ads' LIMIT 1` },
    { label: 'first_time_buyers',       sql: `SELECT SUM(first_time_buyers) AS x FROM pixel_joined_tvf WHERE event_date BETWEEN @startDate AND @endDate AND channel = 'facebook-ads' LIMIT 1` },
    { label: 'new_buyer',               sql: `SELECT SUM(new_buyer) AS x FROM pixel_joined_tvf WHERE event_date BETWEEN @startDate AND @endDate AND channel = 'facebook-ads' LIMIT 1` },
    { label: 'is_new_buyer',            sql: `SELECT AVG(is_new_buyer) AS x FROM pixel_joined_tvf WHERE event_date BETWEEN @startDate AND @endDate AND channel = 'facebook-ads' LIMIT 1` },
    { label: 'new_visitors',            sql: `SELECT SUM(new_visitors) AS x FROM pixel_joined_tvf WHERE event_date BETWEEN @startDate AND @endDate AND channel = 'facebook-ads' LIMIT 1` },
    { label: 'new_visitor_revenue',     sql: `SELECT SUM(new_visitor_revenue) AS x FROM pixel_joined_tvf WHERE event_date BETWEEN @startDate AND @endDate AND channel = 'facebook-ads' LIMIT 1` },
  ];

  const results = await Promise.all(probes.map(p => tryQuery(p.label, p.sql)));
  return res.json({ ok: true, range, results });
});

// GET /audit?range=... — returns ALL ads from TW (no spend/ROAS filter) so
// you can verify the winning-ads list is complete vs. what TW actually has.
// Includes a summary counting how many ads pass each threshold.
router.get('/audit', async (req, res) => {
  try {
    const rangeKey = (req.query.range || 'this_week').toString();
    const from = req.query.from?.toString();
    const to   = req.query.to?.toString();

    if (rangeKey !== 'custom' && !PRESET_KEYS.has(rangeKey)) {
      return res.status(400).json({ ok: false, error: `Unknown range: ${rangeKey}` });
    }

    let range;
    try { range = getDateRange(rangeKey, from, to); }
    catch (err) { return res.status(400).json({ ok: false, error: err.message }); }

    const twResult = await fetchTwData(range.start, range.end);
    const all = twResult.rows.map(r => {
      const spend     = parseFloat(r.total_spend     || 0);
      const revenue   = parseFloat(r.total_revenue   || 0);
      const purchases = parseFloat(r.total_purchases || 0);
      const roas      = spend > 0 ? +(revenue / spend).toFixed(2) : 0;
      return {
        adName:       r.ad_name || '',
        campaignName: r.campaign_name || '',
        adId:         r.ad_id || null,
        spend:        +spend.toFixed(2),
        revenue:      +revenue.toFixed(2),
        purchases:    purchases > 0 ? Math.round(purchases) : 0,
        roas,
      };
    }).sort((a, b) => b.spend - a.spend);

    return res.json({
      ok: true,
      range: { key: range.key, start: range.start, end: range.end, label: range.label },
      summary: {
        totalAds:        all.length,
        adsWithAnySpend: all.filter(r => r.spend >= 1).length,
        adsAbove100:     all.filter(r => r.spend >= 100).length,
        winning:         all.filter(r => r.spend >= 100 && r.roas >= 1.6).length,
        totalSpend:      +all.reduce((s, r) => s + r.spend, 0).toFixed(2),
        totalRevenue:    +all.reduce((s, r) => s + r.revenue, 0).toFixed(2),
        totalPurchases:  all.reduce((s, r) => s + r.purchases, 0),
        truncated:       all.length >= 5000,
      },
      data: all,
    });
  } catch (err) {
    console.error('[Ads Report] /audit error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Legacy alias — kept so old clients keep working during deploy rollover
router.get('/weekly', (req, res) => handleReportRequest(req, res, 'this_week'));

export default router;
