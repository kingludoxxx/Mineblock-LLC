import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { pgQuery } from '../db/pg.js';

const router = Router();

// ── Config ──────────────────────────────────────────────────────────
const TW_API_KEY  = process.env.TRIPLEWHALE_API_KEY || '';
const TW_SHOP_ID  = process.env.TRIPLEWHALE_SHOP_ID || '17cca0-2.myshopify.com';
const TW_SQL_URL  = 'https://api.triplewhale.com/api/v2/orcabase/api/sql';
const CRON_SECRET = process.env.CRON_SECRET || '';

// ── Naming Convention Parser ────────────────────────────────────────

/**
 * Parse ad names following the convention:
 * "MR - B0066 - H1 - IT - B017 - MoneySeeker - Lottery - ShortVid - Ludovico - NA - Ludovico - WK08_2026"
 *
 * Positions (split on " - "):
 *  [0]  Prefix (MR) — skip
 *  [1]  Creative ID (B0066 = Video, IM0066 = Image)
 *  [2]  Hook ID (H1, H2, HX)
 *  [3]  Market code — skip
 *  [4]  Brief code — skip
 *  [5]  Avatar
 *  [6]  Angle
 *  [7]  Format
 *  [8]  Editor
 *  [9]  skip
 *  [10] skip
 *  [11] Week (WK08_2026)
 */
function parseAdName(name) {
  if (!name) return null;

  const segments = name.split(' - ').map(s => s.trim()).filter(Boolean);
  if (segments.length < 3) return null;

  const creativeId = segments[1] || null;
  const hookId     = segments[2] || null;
  const avatar     = segments[5] || null;
  const angle      = segments[6] || null;
  const format     = segments[7] || null;
  const editor     = segments[8] || null;

  // Extract week — look for WKxx_YYYY pattern anywhere (prefer position 11)
  let week = null;
  if (segments[11] && /^WK\d+[_\s]\d{4}$/i.test(segments[11])) {
    week = segments[11].toUpperCase().replace(/\s/, '_');
  } else {
    // Fallback: scan from the end
    for (let i = segments.length - 1; i >= 0; i--) {
      if (/^WK\d+[_\s]\d{4}$/i.test(segments[i])) {
        week = segments[i].toUpperCase().replace(/\s/, '_');
        break;
      }
    }
  }

  // Determine type from creative ID prefix
  const type = creativeId && /^IM/i.test(creativeId) ? 'image' : 'video';

  return { ad_name: name, creative_id: creativeId, hook_id: hookId, type, avatar, angle, format, editor, week };
}

// ── Week / Date Helpers ─────────────────────────────────────────────

/**
 * Convert WKxx_YYYY to { startDate, endDate } in YYYY-MM-DD format (ISO week).
 */
function weekToDateRange(weekStr) {
  const match = weekStr.match(/WK(\d+)_(\d{4})/i);
  if (!match) return null;
  const weekNum = parseInt(match[1], 10);
  const year    = parseInt(match[2], 10);

  const jan4      = new Date(year, 0, 4);
  const dayOfWeek = jan4.getDay() || 7;
  const mondayW1  = new Date(jan4);
  mondayW1.setDate(jan4.getDate() - dayOfWeek + 1);

  const start = new Date(mondayW1);
  start.setDate(mondayW1.getDate() + (weekNum - 1) * 7);

  const end = new Date(start);
  end.setDate(start.getDate() + 6);

  const fmt = (d) => d.toISOString().slice(0, 10);
  return { startDate: fmt(start), endDate: fmt(end) };
}

/**
 * Get the current ISO week string, e.g. "WK12_2026".
 */
function getCurrentWeek() {
  const now = new Date();
  const jan4 = new Date(now.getFullYear(), 0, 4);
  const dayOfWeek = jan4.getDay() || 7;
  const mondayW1 = new Date(jan4);
  mondayW1.setDate(jan4.getDate() - dayOfWeek + 1);

  const diff = Math.floor((now - mondayW1) / (7 * 24 * 60 * 60 * 1000));
  const weekNum = diff + 1;
  return `WK${String(weekNum).padStart(2, '0')}_${now.getFullYear()}`;
}

// ── Derived Metrics ─────────────────────────────────────────────────

function computeMetrics(row) {
  const spend       = Number(row.spend) || 0;
  const revenue     = Number(row.revenue) || 0;
  const purchases   = Number(row.purchases) || 0;
  const impressions = Number(row.impressions) || 0;
  const clicks      = Number(row.clicks) || 0;

  return {
    roas: spend > 0 ? Math.round((revenue / spend) * 100) / 100 : 0,
    cpa:  purchases > 0 ? Math.round((spend / purchases) * 100) / 100 : 0,
    cpm:  impressions > 0 ? Math.round(((spend / impressions) * 1000) * 100) / 100 : 0,
    aov:  purchases > 0 ? Math.round((revenue / purchases) * 100) / 100 : 0,
    cpc:  clicks > 0 ? Math.round((spend / clicks) * 100) / 100 : 0,
    ctr:  impressions > 0 ? Math.round(((clicks / impressions) * 100) * 100) / 100 : 0,
  };
}

// ── Triple Whale API ────────────────────────────────────────────────

async function fetchTripleWhaleAds(startDate, endDate) {
  if (!TW_API_KEY) {
    console.error('[Creative Analysis] TRIPLEWHALE_API_KEY not set');
    return [];
  }

  const query = `
    SELECT
      ad_name,
      SUM(spend) as spend,
      SUM(order_revenue) as revenue,
      SUM(impressions) as impressions,
      SUM(clicks) as clicks
    FROM pixel_joined_tvf
    WHERE event_date BETWEEN @startDate AND @endDate
    GROUP BY ad_name
    HAVING SUM(spend) > 0
    ORDER BY SUM(spend) DESC
  `;

  const res = await fetch(TW_SQL_URL, {
    method: 'POST',
    headers: {
      'x-api-key': TW_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      shopId: TW_SHOP_ID,
      query: query.trim(),
      period: { startDate, endDate },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`[Creative Analysis] Triple Whale API error: ${res.status} — ${text}`);
    return [];
  }

  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// ── Ensure Table Exists ─────────────────────────────────────────────

async function ensureTable() {
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS creative_analysis (
      id SERIAL PRIMARY KEY,
      ad_name TEXT NOT NULL,
      creative_id TEXT NOT NULL,
      hook_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'video',
      avatar TEXT,
      angle TEXT,
      format TEXT,
      editor TEXT,
      week TEXT,
      spend NUMERIC(12,2) DEFAULT 0,
      revenue NUMERIC(12,2) DEFAULT 0,
      purchases INTEGER DEFAULT 0,
      impressions INTEGER DEFAULT 0,
      clicks INTEGER DEFAULT 0,
      roas NUMERIC(8,2) DEFAULT 0,
      cpa NUMERIC(10,2) DEFAULT 0,
      cpm NUMERIC(10,2) DEFAULT 0,
      aov NUMERIC(10,2) DEFAULT 0,
      cpc NUMERIC(10,2) DEFAULT 0,
      ctr NUMERIC(8,2) DEFAULT 0,
      synced_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(creative_id, hook_id)
    )
  `);
}

// ── Sync Logic ──────────────────────────────────────────────────────

async function syncData({ startDate, endDate }) {
  await ensureTable();

  const twAds = await fetchTripleWhaleAds(startDate, endDate);
  if (twAds.length === 0) {
    return { synced: 0, skipped: 0, errors: 0 };
  }

  let synced = 0;
  let skipped = 0;
  let errors = 0;

  for (const ad of twAds) {
    const parsed = parseAdName(ad.ad_name);
    if (!parsed || !parsed.creative_id || !parsed.hook_id) {
      skipped++;
      continue;
    }

    const metrics = computeMetrics({
      spend: ad.spend,
      revenue: ad.revenue,
      purchases: ad.purchases || 0,
      impressions: ad.impressions,
      clicks: ad.clicks,
    });

    try {
      await pgQuery(
        `INSERT INTO creative_analysis
           (ad_name, creative_id, hook_id, type, avatar, angle, format, editor, week,
            spend, revenue, purchases, impressions, clicks,
            roas, cpa, cpm, aov, cpc, ctr, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20, NOW())
         ON CONFLICT (creative_id, hook_id) DO UPDATE SET
           ad_name = EXCLUDED.ad_name,
           type = EXCLUDED.type,
           avatar = EXCLUDED.avatar,
           angle = EXCLUDED.angle,
           format = EXCLUDED.format,
           editor = EXCLUDED.editor,
           week = EXCLUDED.week,
           spend = EXCLUDED.spend,
           revenue = EXCLUDED.revenue,
           purchases = EXCLUDED.purchases,
           impressions = EXCLUDED.impressions,
           clicks = EXCLUDED.clicks,
           roas = EXCLUDED.roas,
           cpa = EXCLUDED.cpa,
           cpm = EXCLUDED.cpm,
           aov = EXCLUDED.aov,
           cpc = EXCLUDED.cpc,
           ctr = EXCLUDED.ctr,
           synced_at = NOW()`,
        [
          parsed.ad_name,
          parsed.creative_id,
          parsed.hook_id,
          parsed.type,
          parsed.avatar,
          parsed.angle,
          parsed.format,
          parsed.editor,
          parsed.week,
          ad.spend || 0,
          ad.revenue || 0,
          ad.purchases || 0,
          ad.impressions || 0,
          ad.clicks || 0,
          metrics.roas,
          metrics.cpa,
          metrics.cpm,
          metrics.aov,
          metrics.cpc,
          metrics.ctr,
        ]
      );
      synced++;
    } catch (err) {
      console.error(`[Creative Analysis] UPSERT error for ${parsed.creative_id}/${parsed.hook_id}:`, err.message);
      errors++;
    }
  }

  return { synced, skipped, errors };
}

// ── Routes ──────────────────────────────────────────────────────────

/**
 * GET /data?week=WK12_2026
 * Returns all creatives for a week, grouped by creative_id with hook-level detail.
 * Also returns available filter values.
 */
router.get('/data', authenticate, async (req, res) => {
  try {
    const { week } = req.query;
    if (!week) {
      return res.status(400).json({ success: false, error: { message: 'week parameter is required (e.g. WK12_2026)' } });
    }

    await ensureTable();

    // Fetch all rows for this week
    const rows = await pgQuery(
      'SELECT * FROM creative_analysis WHERE week = $1 ORDER BY spend DESC',
      [week.toUpperCase()]
    );

    // Group by creative_id
    const grouped = {};
    for (const row of rows) {
      const cid = row.creative_id;
      if (!grouped[cid]) {
        grouped[cid] = {
          creative_id: cid,
          type: row.type,
          avatar: row.avatar,
          angle: row.angle,
          format: row.format,
          editor: row.editor,
          week: row.week,
          // Aggregated totals
          total_spend: 0,
          total_revenue: 0,
          total_purchases: 0,
          total_impressions: 0,
          total_clicks: 0,
          hooks: [],
        };
      }

      const metrics = computeMetrics(row);
      grouped[cid].hooks.push({
        hook_id: row.hook_id,
        ad_name: row.ad_name,
        spend: Number(row.spend),
        revenue: Number(row.revenue),
        purchases: Number(row.purchases),
        impressions: Number(row.impressions),
        clicks: Number(row.clicks),
        ...metrics,
      });

      grouped[cid].total_spend      += Number(row.spend) || 0;
      grouped[cid].total_revenue    += Number(row.revenue) || 0;
      grouped[cid].total_purchases  += Number(row.purchases) || 0;
      grouped[cid].total_impressions += Number(row.impressions) || 0;
      grouped[cid].total_clicks     += Number(row.clicks) || 0;
    }

    // Compute aggregate metrics per creative
    const creatives = Object.values(grouped).map(c => ({
      ...c,
      total_spend:  Math.round(c.total_spend * 100) / 100,
      total_revenue: Math.round(c.total_revenue * 100) / 100,
      ...computeMetrics({
        spend: c.total_spend,
        revenue: c.total_revenue,
        purchases: c.total_purchases,
        impressions: c.total_impressions,
        clicks: c.total_clicks,
      }),
    }));

    // Sort by spend descending
    creatives.sort((a, b) => b.total_spend - a.total_spend);

    // Collect available filter values from all data (not just this week)
    const filterRows = await pgQuery(
      `SELECT DISTINCT week, avatar, angle, format, editor FROM creative_analysis ORDER BY week`
    );

    const filters = {
      weeks:   [...new Set(filterRows.map(r => r.week).filter(Boolean))].sort(),
      avatars: [...new Set(filterRows.map(r => r.avatar).filter(Boolean))].sort(),
      angles:  [...new Set(filterRows.map(r => r.angle).filter(Boolean))].sort(),
      formats: [...new Set(filterRows.map(r => r.format).filter(Boolean))].sort(),
      editors: [...new Set(filterRows.map(r => r.editor).filter(Boolean))].sort(),
    };

    res.json({ success: true, data: { creatives, filters } });
  } catch (err) {
    console.error('[Creative Analysis] /data error:', err);
    res.status(500).json({ success: false, error: { message: err.message || 'Internal server error' } });
  }
});

/**
 * GET /leaderboard?week=WK12_2026
 * Top 10 by ROAS, top 10 by Purchases, top 10 by Efficiency (lowest CPA).
 * Aggregated at creative_id level. Min $200 spend filter.
 */
router.get('/leaderboard', authenticate, async (req, res) => {
  try {
    const { week } = req.query;
    if (!week) {
      return res.status(400).json({ success: false, error: { message: 'week parameter is required' } });
    }

    await ensureTable();

    // Aggregate at creative_id level for the given week, min $200 spend
    const aggregated = await pgQuery(
      `SELECT
         creative_id,
         type,
         avatar,
         angle,
         format,
         editor,
         SUM(spend) as spend,
         SUM(revenue) as revenue,
         SUM(purchases) as purchases,
         SUM(impressions) as impressions,
         SUM(clicks) as clicks
       FROM creative_analysis
       WHERE week = $1
       GROUP BY creative_id, type, avatar, angle, format, editor
       HAVING SUM(spend) >= 200
       ORDER BY SUM(spend) DESC`,
      [week.toUpperCase()]
    );

    // Compute metrics for each
    const withMetrics = aggregated.map(row => ({
      creative_id: row.creative_id,
      type: row.type,
      avatar: row.avatar,
      angle: row.angle,
      format: row.format,
      editor: row.editor,
      spend: Math.round(Number(row.spend) * 100) / 100,
      revenue: Math.round(Number(row.revenue) * 100) / 100,
      purchases: Number(row.purchases),
      impressions: Number(row.impressions),
      clicks: Number(row.clicks),
      ...computeMetrics(row),
    }));

    // Top 10 by ROAS
    const topRoas = [...withMetrics]
      .sort((a, b) => b.roas - a.roas)
      .slice(0, 10);

    // Top 10 by Purchases
    const topPurchases = [...withMetrics]
      .sort((a, b) => b.purchases - a.purchases)
      .slice(0, 10);

    // Top 10 by Efficiency (lowest CPA, must have purchases > 0)
    const topEfficiency = [...withMetrics]
      .filter(c => c.purchases > 0 && c.cpa > 0)
      .sort((a, b) => a.cpa - b.cpa)
      .slice(0, 10);

    res.json({
      success: true,
      data: { topRoas, topPurchases, topEfficiency },
    });
  } catch (err) {
    console.error('[Creative Analysis] /leaderboard error:', err);
    res.status(500).json({ success: false, error: { message: err.message || 'Internal server error' } });
  }
});

/**
 * POST /sync
 * Manual sync trigger. Takes optional { startDate, endDate } or { week }.
 */
router.post('/sync', authenticate, async (req, res) => {
  try {
    let { startDate, endDate, week } = req.body || {};

    if (week) {
      const range = weekToDateRange(week);
      if (!range) {
        return res.status(400).json({ success: false, error: { message: 'Invalid week format. Use WKxx_YYYY.' } });
      }
      startDate = range.startDate;
      endDate   = range.endDate;
    }

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: { message: 'Provide { startDate, endDate } (YYYY-MM-DD) or { week } (WKxx_YYYY)' },
      });
    }

    const result = await syncData({ startDate, endDate });

    res.json({
      success: true,
      data: {
        ...result,
        period: { startDate, endDate },
      },
    });
  } catch (err) {
    console.error('[Creative Analysis] /sync error:', err);
    res.status(500).json({ success: false, error: { message: err.message || 'Sync failed' } });
  }
});

/**
 * POST /sync-weekly
 * Cron endpoint — no auth, checks X-Cron-Secret header.
 * Auto-determines current week and syncs.
 */
router.post('/sync-weekly', async (req, res) => {
  try {
    // Verify cron secret
    const secret = req.headers['x-cron-secret'];
    if (!CRON_SECRET || secret !== CRON_SECRET) {
      return res.status(401).json({ success: false, error: { message: 'Unauthorized' } });
    }

    const week = getCurrentWeek();
    const range = weekToDateRange(week);
    if (!range) {
      return res.status(500).json({ success: false, error: { message: 'Failed to determine current week range' } });
    }

    const result = await syncData({ startDate: range.startDate, endDate: range.endDate });

    res.json({
      success: true,
      data: {
        week,
        ...result,
        period: { startDate: range.startDate, endDate: range.endDate },
      },
    });
  } catch (err) {
    console.error('[Creative Analysis] /sync-weekly error:', err);
    res.status(500).json({ success: false, error: { message: err.message || 'Weekly sync failed' } });
  }
});

/**
 * GET /weeks
 * Returns list of available weeks in the database.
 */
router.get('/weeks', authenticate, async (req, res) => {
  try {
    await ensureTable();

    const rows = await pgQuery(
      `SELECT DISTINCT week, COUNT(*) as creative_count, SUM(spend) as total_spend
       FROM creative_analysis
       WHERE week IS NOT NULL
       GROUP BY week
       ORDER BY week DESC`
    );

    const weeks = rows.map(r => ({
      week: r.week,
      creative_count: Number(r.creative_count),
      total_spend: Math.round(Number(r.total_spend) * 100) / 100,
    }));

    res.json({ success: true, data: { weeks } });
  } catch (err) {
    console.error('[Creative Analysis] /weeks error:', err);
    res.status(500).json({ success: false, error: { message: err.message || 'Internal server error' } });
  }
});

export default router;
