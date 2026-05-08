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

  // Try the rich query (campaign_name + ad_id + purchases). TW is ClickHouse-flavored:
  // CAST uses `String` (not `STRING`); `new_visitor_rate` is not a column in pixel_joined_tvf.
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
          SUM(${purRef}) AS total_purchases
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
        return { rows: result.rows, revCol, purCol, hasCampaign: true, hasAdId: true };
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
  // - permalink_url is NOT a valid AdCreative field (#100)
  // - object_story_spec.instagram_actor_id is deprecated in v22+ (#12)
  // We also pull `created_time` so ads whose names don't contain WK##_YYYY
  // (e.g. "Urgency - 1") still get a Launch Date in the report.
  const FIELDS = 'created_time,creative{effective_object_story_id,object_story_id,instagram_permalink_url,effective_instagram_media_id}';
  let realPostCount = 0, libraryCount = 0, datedFromMeta = 0, sampleLogged = false;
  const createdMap = {}; // adName → 'YYYY-MM-DD'

  await Promise.all(
    Object.entries(adIdMap).map(async ([adName, adId]) => {
      try {
        const url = `${META_GRAPH_URL}/${adId}?fields=${encodeURIComponent(FIELDS)}&access_token=${META_ACCESS_TOKEN}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (res.ok) {
          const d = await res.json();
          if (!sampleLogged) {
            console.log(`[Ads Report] Meta sample for adId=${adId}:`, JSON.stringify(d).slice(0, 500));
            sampleLogged = true;
          }
          // Capture created_time as YYYY-MM-DD (Meta returns ISO 8601 like "2026-04-27T10:13:42+0000")
          if (d?.created_time && typeof d.created_time === 'string' && d.created_time.length >= 10) {
            createdMap[adName] = d.created_time.slice(0, 10);
            datedFromMeta++;
          }

          const c = d?.creative || {};
          const eosi   = c.effective_object_story_id || c.object_story_id;
          const igPerma = c.instagram_permalink_url;

          if (eosi && /^\d+_\d+$/.test(eosi)) {
            const [pageId, postId] = eosi.split('_');
            map[adName] = `https://www.facebook.com/${pageId}/posts/${postId}`;
            realPostCount++;
            return;
          }
          if (igPerma) {
            map[adName] = igPerma;
            realPostCount++;
            return;
          }
        } else {
          if (!sampleLogged) {
            const errText = await res.text();
            console.warn(`[Ads Report] Meta error ${res.status} for adId=${adId}: ${errText.slice(0, 300)}`);
            sampleLogged = true;
          }
        }
      } catch (err) {
        // fall through
      }
      // Fallback to Ads Library
      map[adName] = `https://www.facebook.com/ads/library/?id=${adId}`;
      libraryCount++;
    })
  );

  console.log(`[Ads Report] Meta links: realPosts=${realPostCount} libraryFallback=${libraryCount} datedFromMeta=${datedFromMeta} total=${Object.keys(adIdMap).length}`);
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
  if (!adName) return { avatar: null, angle: null, dateLaunched: null };
  const parts = adName.split(' - ');
  const weekIdx = parts.findIndex(p => /^WK\d+_\d{4}/i.test(p.trim()));

  let dateLaunched = null;
  if (weekIdx >= 0) {
    const m = parts[weekIdx].trim().match(/^WK(\d+)_(\d{4})/i);
    if (m) dateLaunched = weekToDate(parseInt(m[1], 10), parseInt(m[2], 10));
  }

  if (weekIdx >= 6) {
    return {
      avatar: parts[weekIdx - 6]?.trim() || null,
      angle:  parts[weekIdx - 5]?.trim() || null,
      dateLaunched,
    };
  }
  return {
    avatar: parts[4] || null,
    angle:  parts[5] || null,
    dateLaunched,
  };
}

// ── ClickUp task URL lookup ───────────────────────────────────────────────────
async function enrichWithClickUpLinks(rows) {
  const adNames = [...new Set(rows.map(r => r.ad_name).filter(Boolean))];
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
  // We track which ads got a real task vs fell back to the list view, so the
  // log line at the end is meaningful.
  const resolvedFromDb = [];
  for (const adName of adNames) {
    const cid = creativeIdMap[adName];
    const num = briefNumMap[adName];
    const url = (cid && urlByCreativeId[cid]) || (num && urlByBriefNum[num]) || null;
    if (url) { map[adName] = url; resolvedFromDb.push(adName); }
  }

  // Fallback: ClickUp API (custom field, then name search)
  const missing = adNames.filter(n => !map[n] && briefNumMap[n] != null);
  if (missing.length && CLICKUP_TOKEN) {
    console.log(`[Ads Report] ClickUp DB miss ${missing.length} briefs — falling back to API`);
    const apiResults = await Promise.all(
      missing.map(async adName => {
        const num = briefNumMap[adName];
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
          if (!res.ok) return [adName, null];
          const data = await res.json();
          let task = (data.tasks || [])[0];

          if (!task) {
            // Team-wide search (no list filter) — older briefs may live in a
            // different list/space than the current one. Match by brief code
            // appearing anywhere in the task name.
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

          if (!task) return [adName, null];
          return [adName, task.url || `https://app.clickup.com/t/${task.id}`];
        } catch (err) {
          console.error(`[Ads Report] ClickUp API fallback failed for B${String(num).padStart(4,'0')}:`, err.message);
          return [adName, null];
        }
      })
    );
    for (const [adName, url] of apiResults) {
      if (url) map[adName] = url;
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
function buildReportRows(twResult, metaResult, clickupLinks) {
  const { rows } = twResult;
  const { links: metaLinks, created: metaCreated } = metaResult;

  const enriched = rows.map(r => {
    const spend     = parseFloat(r.total_spend     || 0);
    const revenue   = parseFloat(r.total_revenue   || 0);
    const purchases = parseFloat(r.total_purchases || 0);
    const roas      = spend > 0 ? +(revenue / spend).toFixed(2) : 0;
    const cpa       = purchases > 0 ? +(spend / purchases).toFixed(2) : null;
    const aov       = purchases > 0 ? +(revenue / purchases).toFixed(2) : null;
    const nvp       = r.avg_nvp != null ? +parseFloat(r.avg_nvp * 100).toFixed(1) : null;
    const { avatar, angle, dateLaunched } = parseAdName(r.ad_name);

    return {
      adName:       r.ad_name       || '',
      campaignName: r.campaign_name || '',
      fbLink:       metaLinks[r.ad_name] || null,
      clickupUrl:   clickupLinks[r.ad_name] || null,
      spend:        +spend.toFixed(2),
      roas,
      purchases:    purchases > 0 ? Math.round(purchases) : null,
      cpa,
      aov,
      nvp,
      avatar,
      angle,
      // Prefer the WK marker parsed out of the ad name; fall back to Meta's
      // created_time so non-brief-coded ads (e.g. "Urgency - 1") still get a
      // launch date.
      dateLaunched: dateLaunched || metaCreated[r.ad_name] || null,
    };
  });

  const totalAds       = enriched.length;
  const adsWithSpend   = enriched.filter(r => r.spend >= 1).length;
  const adsAbove100    = enriched.filter(r => r.spend >= 100).length;
  const winning        = enriched
    .filter(r => r.spend >= 100 && r.roas >= 1.6)
    .sort((a, b) => b.roas - a.roas);

  console.log(
    `[Ads Report] AUDIT total=${totalAds} spend≥$1=${adsWithSpend} spend≥$100=${adsAbove100} winning=${winning.length} (spend≥$100 & ROAS≥1.6)`
  );

  return winning;
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

// Public share endpoint — token-protected, no auth
router.get('/public', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Missing token' });
  try {
    await ensureTables();
    const [row] = await pgQuery(
      `SELECT * FROM ads_report_cache WHERE share_token = $1`, [token]
    );
    if (!row) return res.status(404).json({ error: 'Report not found or link expired' });
    return res.json({
      ok: true,
      range: { key: row.range_key, start: row.start_date, end: row.end_date, label: PRESET_LABELS[row.range_key] || row.range_key },
      generatedAt: row.generated_at,
      data: parseDbData(row.data),
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

    if (!cached || forceRefresh || isStale) {
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
