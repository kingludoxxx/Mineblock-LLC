import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { pgQuery } from '../db/pg.js';

const router = Router();

// ── Config ──────────────────────────────────────────────────────────
const TW_API_KEY  = process.env.TRIPLEWHALE_API_KEY || '';
const TW_SHOP_ID  = process.env.TRIPLEWHALE_SHOP_ID || '17cca0-2.myshopify.com';
const TW_SQL_URL  = 'https://api.triplewhale.com/api/v2/orcabase/api/sql';
const CRON_SECRET = process.env.CRON_SECRET || '';

let tableReady = false; // cache ensureTable so it only runs once

// ── Naming Convention Parser ────────────────────────────────────────

/**
 * Parse ad names following the convention:
 * "MR - B0066 - H1 - IT - B017 - MoneySeeker - Lottery - ShortVid - Ludovico - NA - Ludovico - WK08_2026"
 *
 * Also supports underscore-delimited variant:
 * "MR Miner _ B041 _ HX _ IT _ B049 _ MoneySeeker _ Lottery _ ShortVid _ Ludovico _ NA _ Ludovico _ WK08_2026"
 *
 * Head is fixed:       [0]=Prefix  [1]=CreativeID  [2]=HookID (or IT marker)
 * Tail is stable (relative to week position):
 *   week_pos - 1 = Editor (second instance / sign-off)
 *   week_pos - 2 = Editor (first instance / NA)
 *   week_pos - 3 = Editor
 *   week_pos - 4 = Format
 *   week_pos - 5 = Angle
 *   week_pos - 6 = Avatar
 *
 * Uses RIGHT-TO-LEFT parsing anchored on the week (WKxx_YYYY) to handle
 * variable segment counts from inconsistent naming.
 */
function parseAdName(name) {
  if (!name) return null;

  // Normalize: strip file extensions from the full name first
  let cleanName = name.replace(/\.(mp4|mov|avi|mkv|png|jpg|jpeg|gif|webp|webm)$/i, '').trim();

  // Detect delimiter: ` - ` (standard) or ` _ ` (variant)
  // Important: must check ` _ ` carefully because WK10_2026 contains underscore too
  let segments;
  const dashSegments = cleanName.split(' - ').map(s => s.trim()).filter(Boolean);

  if (dashSegments.length >= 3) {
    segments = dashSegments;
  } else {
    // For underscore-delimited ads like "MR Miner _ B041 _ HX _ IT _ B049 _ MoneySeeker _ Lottery _ ShortVid _ Ludovico _ NA _ Ludovico _ WK08_2026"
    // We need to split on " _ " but preserve "WK08_2026" — reconstruct week if it got split
    const underscoreSegments = cleanName.split(' _ ').map(s => s.trim()).filter(Boolean);

    // Check if last two segments are a split week (e.g. ["WK08", "2026"])
    if (underscoreSegments.length >= 2) {
      const last = underscoreSegments[underscoreSegments.length - 1];
      const secondLast = underscoreSegments[underscoreSegments.length - 2];
      if (/^\d{4}$/.test(last) && /^WK\d+$/i.test(secondLast)) {
        // Rejoin split week
        underscoreSegments.splice(-2, 2, `${secondLast}_${last}`);
      }
    }

    if (underscoreSegments.length >= 3) {
      segments = underscoreSegments;
    } else {
      return null;
    }
  }

  // Clean file extensions from individual segments (in case they weren't at the end)
  segments = segments.map(s => s.replace(/\.(mp4|mov|avi|mkv|png|jpg|jpeg|gif|webp|webm)$/i, '').trim());

  const creativeId = segments[1] || null;

  // Detect if position [2] is the hook (H1, H2, HX, etc.) or an iteration marker (IT, NN, NA, etc.)
  let hookId = null;
  const seg2 = segments[2] || '';
  if (/^H\d+$/i.test(seg2) || /^HX$/i.test(seg2)) {
    hookId = seg2.toUpperCase();
  } else if (/^(IT|NN|NA)$/i.test(seg2)) {
    // IT/NN/NA in position 2 — look for hook in position [3]
    const seg3 = segments[3] || '';
    if (/^H\d+$/i.test(seg3) || /^HX$/i.test(seg3)) {
      hookId = seg3.toUpperCase();
    } else {
      // No hook found — this ad uses a non-standard format, assign HX
      hookId = 'HX';
    }
  } else {
    // Position 2 isn't a standard hook format, use it as-is but normalize
    hookId = seg2.toUpperCase() || 'HX';
  }

  // Find week position — scan from the end
  let weekPos = -1;
  let week = null;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (/^WK\d+[_\s]\d{4}$/i.test(segments[i])) {
      weekPos = i;
      week = segments[i].toUpperCase().replace(/\s/, '_');
      break;
    }
  }

  // Parse metadata relative to week position (right-to-left)
  // Two tail patterns exist:
  //   Long tail:  ... Avatar - Angle - Format - Editor - NA - Editor2 - Week  (editorOffset = 3)
  //   Short tail: ... Avatar - Angle - Format - Editor - NA - Week           (editorOffset = 2)
  // Detect by checking if segments[weekPos-2] is "NA" (short) or segments[weekPos-1] is editor2
  let avatar = null, angle = null, format = null, editor = null;
  if (weekPos >= 4) {
    let editorOffset;

    // Check which tail pattern matches
    const atWeekM1 = segments[weekPos - 1] || '';
    const atWeekM2 = segments[weekPos - 2] || '';

    if (/^NA\d*$/i.test(atWeekM1)) {
      // Short tail: ... Format - Editor - NA - Week
      editorOffset = 2;
    } else if (/^NA\d*$/i.test(atWeekM2)) {
      // Long tail: ... Format - Editor - NA - Editor2 - Week
      editorOffset = 3;
    } else {
      // No NA found — try assuming short tail
      editorOffset = 2;
    }

    editor = (weekPos - editorOffset >= 0) ? segments[weekPos - editorOffset] || null : null;
    format = (weekPos - editorOffset - 1 >= 0) ? segments[weekPos - editorOffset - 1] || null : null;
    angle  = (weekPos - editorOffset - 2 >= 0) ? segments[weekPos - editorOffset - 2] || null : null;
    avatar = (weekPos - editorOffset - 3 >= 0) ? segments[weekPos - editorOffset - 3] || null : null;

    // Clean up placeholder values
    const placeholders = ['-', 'NA', 'NN', 'na', 'nn'];
    if (editor && placeholders.includes(editor)) editor = null;
    if (format && placeholders.includes(format)) format = null;
    if (angle && placeholders.includes(angle))   angle = null;
    if (avatar && placeholders.includes(avatar)) avatar = null;

    // Validate metadata: reject values that look like creative IDs, hook IDs, weeks, or file artifacts
    const junkPattern = /^(B\d{3,}|H\d+|HX|IT|NN|MR|IM\d*|WK\d+.*)$/i;
    if (editor && junkPattern.test(editor)) editor = null;
    if (format && junkPattern.test(format)) format = null;
    if (angle && junkPattern.test(angle))   angle = null;
    if (avatar && junkPattern.test(avatar)) avatar = null;

    // Strip file extensions from values
    const filePattern = /\.(mp4|mov|png|jpg|jpeg|gif|webp|webm|avi|mkv)$/i;
    if (editor && filePattern.test(editor)) editor = editor.replace(filePattern, '').trim() || null;
    if (format && filePattern.test(format)) format = format.replace(filePattern, '').trim() || null;
    if (angle && filePattern.test(angle))   angle = angle.replace(filePattern, '').trim() || null;
    if (avatar && filePattern.test(avatar)) avatar = avatar.replace(filePattern, '').trim() || null;
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

  // Query TW — try with pixel_purchases, then conversions, then without
  const purchaseColumns = ['pixel_purchases', 'conversions', null];

  for (const purchaseCol of purchaseColumns) {
    const purchaseSelect = purchaseCol ? `, SUM(${purchaseCol}) as total_purchases` : '';
    const query = `
      SELECT
        ad_name,
        SUM(spend) as total_spend,
        SUM(order_revenue) as total_revenue${purchaseSelect},
        SUM(impressions) as total_impressions,
        SUM(clicks) as total_clicks
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

    if (res.ok) {
      const data = await res.json();
      if (purchaseCol) {
        console.log(`[Creative Analysis] TW purchases column "${purchaseCol}" works`);
      }
      return Array.isArray(data) ? data : [];
    }

    const text = await res.text();
    if (purchaseCol) {
      console.warn(`[Creative Analysis] TW column "${purchaseCol}" not available: ${text.slice(0, 100)}`);
    } else {
      console.error(`[Creative Analysis] TW query failed entirely: ${res.status} — ${text.slice(0, 200)}`);
    }
  }

  return [];
}

// ── Ensure Table Exists ─────────────────────────────────────────────

async function ensureTable() {
  if (tableReady) return;

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
      impressions BIGINT DEFAULT 0,
      clicks BIGINT DEFAULT 0,
      roas NUMERIC(8,2) DEFAULT 0,
      cpa NUMERIC(10,2) DEFAULT 0,
      cpm NUMERIC(10,2) DEFAULT 0,
      aov NUMERIC(10,2) DEFAULT 0,
      cpc NUMERIC(10,2) DEFAULT 0,
      ctr NUMERIC(8,2) DEFAULT 0,
      synced_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(creative_id, hook_id, week)
    )
  `);

  // Migrate existing table: if old unique constraint exists (without week), swap it
  try {
    await pgQuery(`
      DO $$
      BEGIN
        -- Drop old constraint if it exists (creative_id, hook_id) without week
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'creative_analysis_creative_id_hook_id_key'
          AND conrelid = 'creative_analysis'::regclass
        ) THEN
          ALTER TABLE creative_analysis DROP CONSTRAINT creative_analysis_creative_id_hook_id_key;
        END IF;

        -- Add new constraint with week if it doesn't exist
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'creative_analysis_creative_id_hook_id_week_key'
          AND conrelid = 'creative_analysis'::regclass
        ) THEN
          ALTER TABLE creative_analysis ADD CONSTRAINT creative_analysis_creative_id_hook_id_week_key
            UNIQUE (creative_id, hook_id, week);
        END IF;

        -- Upgrade columns to BIGINT if needed
        ALTER TABLE creative_analysis ALTER COLUMN impressions TYPE BIGINT;
        ALTER TABLE creative_analysis ALTER COLUMN clicks TYPE BIGINT;
      EXCEPTION WHEN OTHERS THEN
        -- Ignore migration errors (e.g. duplicate data blocking unique constraint)
        RAISE NOTICE 'Migration warning: %', SQLERRM;
      END $$;
    `);
  } catch (err) {
    console.warn('[Creative Analysis] Table migration warning:', err.message);
  }

  tableReady = true;
}

// ── Sync Logic ──────────────────────────────────────────────────────

/**
 * Sync ad performance data for a specific period.
 * @param {string} periodWeek — The performance period week (e.g. WK10_2026)
 *                               ALL ads running in this period are stored under this week.
 * @param {string} startDate — YYYY-MM-DD
 * @param {string} endDate   — YYYY-MM-DD
 */
async function syncData({ periodWeek, startDate, endDate }) {
  await ensureTable();

  const twAds = await fetchTripleWhaleAds(startDate, endDate);
  if (twAds.length === 0) {
    return { synced: 0, skipped: 0, errors: 0 };
  }

  // Parse all ads and aggregate by (creative_id, hook_id) to avoid UNIQUE constraint violations.
  // Multiple TW rows can map to the same (creative_id, hook_id) — e.g. different iterations
  // of the same ad. We sum their metrics.
  const aggregated = new Map(); // key: "creative_id|hook_id"
  let skipped = 0;

  for (const ad of twAds) {
    const parsed = parseAdName(ad.ad_name);
    if (!parsed || !parsed.creative_id || !parsed.hook_id) {
      skipped++;
      continue;
    }

    const key = `${parsed.creative_id}|${parsed.hook_id}`;
    const spend = Number(ad.total_spend) || 0;
    const revenue = Number(ad.total_revenue) || 0;
    const purchases = Number(ad.total_purchases) || 0;
    const impressions = Number(ad.total_impressions) || 0;
    const clicks = Number(ad.total_clicks) || 0;

    if (aggregated.has(key)) {
      const existing = aggregated.get(key);
      existing.spend += spend;
      existing.revenue += revenue;
      existing.purchases += purchases;
      existing.impressions += impressions;
      existing.clicks += clicks;
      // Keep the ad_name with higher spend for display
      if (spend > (existing._topSpend || 0)) {
        existing.ad_name = parsed.ad_name;
        existing._topSpend = spend;
        // Also prefer metadata from the higher-spend variant
        if (parsed.avatar) existing.avatar = parsed.avatar;
        if (parsed.angle)  existing.angle = parsed.angle;
        if (parsed.format) existing.format = parsed.format;
        if (parsed.editor) existing.editor = parsed.editor;
      }
    } else {
      aggregated.set(key, {
        ad_name: parsed.ad_name,
        creative_id: parsed.creative_id,
        hook_id: parsed.hook_id,
        type: parsed.type,
        avatar: parsed.avatar,
        angle: parsed.angle,
        format: parsed.format,
        editor: parsed.editor,
        spend,
        revenue,
        purchases,
        impressions,
        clicks,
        _topSpend: spend,
      });
    }
  }

  // Delete old data for this period week, then insert fresh
  await pgQuery('DELETE FROM creative_analysis WHERE week = $1', [periodWeek]);

  let synced = 0;
  let errors = 0;

  for (const entry of aggregated.values()) {
    const metrics = computeMetrics(entry);

    try {
      await pgQuery(
        `INSERT INTO creative_analysis
           (ad_name, creative_id, hook_id, type, avatar, angle, format, editor, week,
            spend, revenue, purchases, impressions, clicks,
            roas, cpa, cpm, aov, cpc, ctr, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20, NOW())`,
        [
          entry.ad_name,
          entry.creative_id,
          entry.hook_id,
          entry.type,
          entry.avatar,
          entry.angle,
          entry.format,
          entry.editor,
          periodWeek,
          Math.round(entry.spend * 100) / 100,
          Math.round(entry.revenue * 100) / 100,
          entry.purchases,
          entry.impressions,
          entry.clicks,
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
      console.error(`[Creative Analysis] INSERT error for ${entry.creative_id}/${entry.hook_id}:`, err.message);
      errors++;
    }
  }

  return { synced, skipped, errors, aggregatedFrom: twAds.length - skipped };
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

    // Collect available filter values for THIS week only (not global)
    const filterRows = await pgQuery(
      `SELECT DISTINCT avatar, angle, format, editor FROM creative_analysis WHERE week = $1`,
      [week.toUpperCase()]
    );

    // Get available weeks separately
    const weekRows = await pgQuery(
      `SELECT DISTINCT week FROM creative_analysis WHERE week IS NOT NULL ORDER BY week`
    );

    const filters = {
      weeks:   weekRows.map(r => r.week).sort(),
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
         MIN(ad_name) as ad_name,
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
      ad_name: row.ad_name,
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

    if (!week) {
      return res.status(400).json({
        success: false,
        error: { message: 'Provide { week } (WKxx_YYYY)' },
      });
    }

    const range = weekToDateRange(week);
    if (!range) {
      return res.status(400).json({ success: false, error: { message: 'Invalid week format. Use WKxx_YYYY.' } });
    }
    startDate = range.startDate;
    endDate   = range.endDate;

    const result = await syncData({ periodWeek: week.toUpperCase(), startDate, endDate });

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

    const result = await syncData({ periodWeek: week, startDate: range.startDate, endDate: range.endDate });

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
 * POST /sync-all
 * Re-sync all existing weeks. Useful after parser changes to clean stale data.
 */
router.post('/sync-all', authenticate, async (req, res) => {
  try {
    await ensureTable();

    // Get all existing weeks
    const weekRows = await pgQuery(
      'SELECT DISTINCT week FROM creative_analysis WHERE week IS NOT NULL ORDER BY week'
    );

    const results = [];
    for (const row of weekRows) {
      const range = weekToDateRange(row.week);
      if (!range) continue;
      const result = await syncData({ periodWeek: row.week, startDate: range.startDate, endDate: range.endDate });
      results.push({ week: row.week, ...result });
    }

    res.json({ success: true, data: { results } });
  } catch (err) {
    console.error('[Creative Analysis] /sync-all error:', err);
    res.status(500).json({ success: false, error: { message: err.message || 'Sync-all failed' } });
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
      `SELECT week, COUNT(DISTINCT creative_id) as creative_count, SUM(spend) as total_spend
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
