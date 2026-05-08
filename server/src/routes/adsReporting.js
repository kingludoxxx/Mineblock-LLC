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

// Revenue + purchase column candidates (in preference order)
const REV_COLS = [TW_REVENUE_COL, 'order_revenue', 'channel_reported_conversion_value'];
const PUR_COLS = ['purchases', 'order_count'];

// Dedup lists while preserving order
const uniqueRevCols = [...new Set(REV_COLS)];
const uniquePurCols = [...new Set(PUR_COLS)];

// ── DB setup ──────────────────────────────────────────────────────────────────
async function ensureTables() {
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS ads_weekly_report_cache (
      week_start   DATE        NOT NULL PRIMARY KEY,
      week_end     DATE        NOT NULL,
      share_token  TEXT        NOT NULL UNIQUE,
      data         JSONB       NOT NULL DEFAULT '[]',
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

// ── Week helpers ──────────────────────────────────────────────────────────────
function getWeekDates() {
  const now   = new Date();
  const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dow   = today.getUTCDay(); // 0=Sun…6=Sat
  const daysFromMon = dow === 0 ? 6 : dow - 1;
  const weekStart   = new Date(today);
  weekStart.setUTCDate(today.getUTCDate() - daysFromMon);

  const fmt = (d) => d.toISOString().slice(0, 10);
  const label = (d) => {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
  };

  return {
    start: fmt(weekStart),
    end:   fmt(today),
    label: `${label(weekStart)} – ${label(today)}`,
  };
}

// ── Triple Whale query ────────────────────────────────────────────────────────
async function fetchWeeklyTwData(startDate, endDate) {
  if (!TW_API_KEY) throw new Error('TRIPLEWHALE_API_KEY not set');

  function twPost(query) {
    return fetch(TW_SQL_URL, {
      method:  'POST',
      headers: { 'x-api-key': TW_API_KEY, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        shopId:           TW_SHOP_ID,
        query,
        period:           { startDate, endDate },
        attributionModel: TW_ATTRIBUTION_MODEL,
      }),
      signal: AbortSignal.timeout(30000),
    });
  }

  async function tryQuery(sql) {
    const res = await twPost(sql).catch(() => null);
    if (!res?.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data || data.error) return null;
    const rows = Array.isArray(data) ? data : (data?.data || data?.rows || []);
    return rows;
  }

  // Try progressively simpler queries until one works.
  // Outer loop: revenue + purchase column combinations.
  // Inner: optional extra columns (campaign_name, ad_id, nvp).
  for (const revCol of uniqueRevCols) {
    for (const purCol of uniquePurCols) {
      const rev = revCol.includes(' ') ? `\`${revCol}\`` : revCol;
      const pur = purCol.includes(' ') ? `\`${purCol}\`` : purCol;

      // Attempt 1: all columns including campaign_name, ad_id, NVP
      let rows = await tryQuery(`
        SELECT campaign_name, ad_name, ad_id,
               SUM(spend) AS total_spend,
               SUM(${rev}) AS total_revenue,
               SUM(${pur}) AS total_purchases,
               AVG(new_visitor_rate) AS avg_nvp
        FROM pixel_joined_tvf
        WHERE event_date BETWEEN @startDate AND @endDate
        GROUP BY campaign_name, ad_name, ad_id
        HAVING SUM(spend) > 0
        ORDER BY SUM(${rev}) / NULLIF(SUM(spend), 0) DESC
        LIMIT 500
      `);
      if (rows) return { rows, revCol, purCol, hasCampaign: true, hasAdId: true, hasNvp: true };

      // Attempt 2: drop NVP
      rows = await tryQuery(`
        SELECT campaign_name, ad_name, ad_id,
               SUM(spend) AS total_spend,
               SUM(${rev}) AS total_revenue,
               SUM(${pur}) AS total_purchases
        FROM pixel_joined_tvf
        WHERE event_date BETWEEN @startDate AND @endDate
        GROUP BY campaign_name, ad_name, ad_id
        HAVING SUM(spend) > 0
        ORDER BY SUM(${rev}) / NULLIF(SUM(spend), 0) DESC
        LIMIT 500
      `);
      if (rows) return { rows, revCol, purCol, hasCampaign: true, hasAdId: true, hasNvp: false };

      // Attempt 3: drop ad_id + NVP
      rows = await tryQuery(`
        SELECT campaign_name, ad_name,
               SUM(spend) AS total_spend,
               SUM(${rev}) AS total_revenue,
               SUM(${pur}) AS total_purchases
        FROM pixel_joined_tvf
        WHERE event_date BETWEEN @startDate AND @endDate
        GROUP BY campaign_name, ad_name
        HAVING SUM(spend) > 0
        ORDER BY SUM(${rev}) / NULLIF(SUM(spend), 0) DESC
        LIMIT 500
      `);
      if (rows) return { rows, revCol, purCol, hasCampaign: true, hasAdId: false, hasNvp: false };

      // Attempt 4: ad_name only (most compatible)
      rows = await tryQuery(`
        SELECT ad_name,
               SUM(spend) AS total_spend,
               SUM(${rev}) AS total_revenue,
               SUM(${pur}) AS total_purchases
        FROM pixel_joined_tvf
        WHERE event_date BETWEEN @startDate AND @endDate
        GROUP BY ad_name
        HAVING SUM(spend) > 0
        ORDER BY SUM(${rev}) / NULLIF(SUM(spend), 0) DESC
        LIMIT 500
      `);
      if (rows) return { rows, revCol, purCol, hasCampaign: false, hasAdId: false, hasNvp: false };
    }
  }

  throw new Error('TW query failed for all column/model combinations');
}

// ── Meta ad-id → FB link lookup via creative_analysis table ──────────────────
async function enrichWithMetaLinks(rows) {
  const adNames = [...new Set(rows.map(r => r.ad_name).filter(Boolean))];
  if (!adNames.length) return {};

  try {
    const result = await pgQuery(
      `SELECT ad_name, meta_ad_id FROM creative_analysis
       WHERE ad_name = ANY($1) AND meta_ad_id IS NOT NULL`,
      [adNames]
    );
    const map = {};
    for (const r of (result || [])) {
      if (r.ad_name && r.meta_ad_id) {
        map[r.ad_name] = `https://www.facebook.com/ads/library/?id=${r.meta_ad_id}`;
      }
    }
    return map;
  } catch {
    return {};
  }
}

// ── Avatar / Angle parser ─────────────────────────────────────────────────────
// Convention: "MR - B0309 - NN - NA - Cryptoaddict - Apology - ..."
//  index:          0    1     2    3         4              5
function parseAdName(adName) {
  const parts = (adName || '').split(' - ');
  return {
    avatar: parts[4] || null,
    angle:  parts[5] || null,
  };
}

// ── Build report rows ─────────────────────────────────────────────────────────
function buildReportRows(twResult, metaLinks) {
  const { rows, revCol, purCol } = twResult; // eslint-disable-line no-unused-vars

  return rows
    .map(r => {
      const spend    = parseFloat(r.total_spend    || 0);
      const revenue  = parseFloat(r.total_revenue  || 0);
      const purchases = parseFloat(r.total_purchases || 0);
      const roas     = spend > 0 ? +(revenue / spend).toFixed(2) : 0;
      const cpa      = purchases > 0 ? +(spend / purchases).toFixed(2) : null;
      const aov      = purchases > 0 ? +(revenue / purchases).toFixed(2) : null;
      const nvp      = r.avg_nvp != null ? +(parseFloat(r.avg_nvp) * 100).toFixed(1) : null;
      const { avatar, angle } = parseAdName(r.ad_name);

      return {
        adName:       r.ad_name       || '',
        campaignName: r.campaign_name || '',
        adId:         r.ad_id         || null,
        fbLink:       metaLinks[r.ad_name] || null,
        spend:        +spend.toFixed(2),
        roas,
        purchases:    Math.round(purchases),
        cpa,
        aov,
        nvp,
        avatar,
        angle,
      };
    })
    // Filter: spend >= 100 AND ROAS >= 1.6
    .filter(r => r.spend >= 100 && r.roas >= 1.6)
    // Sort by ROAS descending
    .sort((a, b) => b.roas - a.roas);
}

// ── Main refresh function ─────────────────────────────────────────────────────
async function refreshWeeklyReport() {
  await ensureTables();
  const week = getWeekDates();

  const twResult  = await fetchWeeklyTwData(week.start, week.end);
  const metaLinks = await enrichWithMetaLinks(twResult.rows);
  const report    = buildReportRows(twResult, metaLinks);

  // Upsert cache row — keep the same share_token if row already exists
  await pgQuery(`
    INSERT INTO ads_weekly_report_cache (week_start, week_end, share_token, data, generated_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (week_start) DO UPDATE SET
      week_end     = EXCLUDED.week_end,
      data         = EXCLUDED.data,
      generated_at = NOW()
  `, [week.start, week.end, randomUUID(), JSON.stringify(report)]);

  // Return the stored row (including the token that survived a conflict)
  const [row] = await pgQuery(
    `SELECT * FROM ads_weekly_report_cache WHERE week_start = $1`, [week.start]
  );

  console.log(`[Ads Report] Refreshed ${week.label}: ${report.length} qualifying ads`);
  return { week, report, shareToken: row.share_token };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Public share endpoint — no JWT required, token-protected
router.get('/public', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Missing token' });
  try {
    await ensureTables();
    const [row] = await pgQuery(
      `SELECT * FROM ads_weekly_report_cache WHERE share_token = $1`, [token]
    );
    if (!row) return res.status(404).json({ error: 'Report not found or link expired' });
    return res.json({
      ok: true,
      week: { start: row.week_start, end: row.week_end },
      generatedAt: row.generated_at,
      data: row.data,
    });
  } catch (err) {
    console.error('[Ads Report] /public error:', err.message);
    return res.status(500).json({ error: 'Failed to load report' });
  }
});

// Cron endpoint — 12:00 AM CET daily (22:00 UTC in CEST / 23:00 UTC in CET)
router.get('/cron/refresh', async (req, res) => {
  if (!CRON_SECRET || req.query.secret !== CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const result = await refreshWeeklyReport();
    return res.json({ ok: true, week: result.week.label, rows: result.report.length });
  } catch (err) {
    console.error('[Ads Report] cron refresh error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// Protected routes (require JWT + permission)
router.use(authenticate, requirePermission('ads-reporting', 'access'));

// GET /weekly — fetch or refresh current week report
router.get('/weekly', async (req, res) => {
  try {
    await ensureTables();
    const week   = getWeekDates();
    const [cached] = await pgQuery(
      `SELECT * FROM ads_weekly_report_cache WHERE week_start = $1`, [week.start]
    );

    // Auto-refresh if: no cache, or data is stale (> 6 hours old), or user forced refresh
    const forceRefresh  = req.query.refresh === '1';
    const staleThreshold = 6 * 60 * 60 * 1000; // 6 hours
    const isStale = !cached || (Date.now() - new Date(cached.generated_at).getTime() > staleThreshold);

    if (!cached || forceRefresh || isStale) {
      const result = await refreshWeeklyReport();
      const [fresh] = await pgQuery(
        `SELECT * FROM ads_weekly_report_cache WHERE week_start = $1`, [week.start]
      );
      return res.json({
        ok: true,
        week: { start: fresh.week_start, end: fresh.week_end, label: week.label },
        shareToken: fresh.share_token,
        generatedAt: fresh.generated_at,
        data: result.report,
      });
    }

    return res.json({
      ok: true,
      week: { start: cached.week_start, end: cached.week_end, label: week.label },
      shareToken: cached.share_token,
      generatedAt: cached.generated_at,
      data: cached.data,
    });
  } catch (err) {
    console.error('[Ads Report] /weekly error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
