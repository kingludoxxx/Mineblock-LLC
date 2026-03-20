import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { pgQuery, pgDb } from '../db/pg.js';

const router = Router();

// ── Config ──────────────────────────────────────────────────────────
const TW_API_KEY  = process.env.TRIPLEWHALE_API_KEY || '';
const TW_SHOP_ID  = process.env.TRIPLEWHALE_SHOP_ID || '17cca0-2.myshopify.com';
const TW_SQL_URL  = 'https://api.triplewhale.com/api/v2/orcabase/api/sql';
const CRON_SECRET = process.env.CRON_SECRET || '';

let tableReady = false; // cache ensureTable so it only runs once

// ── Known Values (for cross-validation) ─────────────────────────────
// These sets prevent fields from leaking into the wrong slot when segment counts vary.
// All stored lowercase for case-insensitive matching via knownHas() helper.
const KNOWN_FORMATS = new Set([
  'shortvid', 'mashup', 'mashups', 'mini vsl', 'minivsl', 'long form', 'long vsl',
  'longvsl', 'vsl', 'img', 'ugc', 'gif',
]);

const KNOWN_EDITORS = new Set([
  'faiz', 'muhammad', 'antoni', 'ludovico', 'ludo', 'atif', 'ali', 'hamza',
  'usama', 'carl', 'alhamjatonni', 'abdul', 'robi', 'abdullah', 'farhan',
]);

const KNOWN_ANGLES = new Set([
  'lottery', 'cryptoaddict', 'moneyseeker', 'againstcompetition',
  'againstcompetition rebranding', 'sharktank', 'btc made easy',
  'btcmadeeasy', 'btc farm', 'btcfarm', 'btc crash', 'scarcity',
  'hiddenopportunity', 'missedopportunity', 'comparison', 'offer',
  'reaction', 'gtrs', 'livestream', 'rebranding', 'sale', 'breakingnews',
  'lambo', 'mclaren', 'retargeting', 'founder story', 'founderstory',
  'money opportunity', 'moneyopportunity', 'opportunity', 'tof',
]);

/** Case-insensitive Set.has() */
const knownHas = (set, val) => val && set.has(val.toLowerCase());

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

  // Filter out known junk/unattributed ad names
  const junkNames = ['(not set)', 'not set', '(unknown)', 'unknown'];
  if (junkNames.includes(name.trim().toLowerCase())) return null;

  // Helper: title case normalization for consistent aggregation
  // Title case: capitalize first letter of each word, lowercase the rest
  // But preserve short uppercase words (UGC, IMG, VSL) as-is
  const titleCase = (s) => {
    if (!s) return null;
    return s.split(/\s+/).map(w => {
      if (w.length <= 3 && w === w.toUpperCase()) return w; // preserve acronyms like UGC, IMG, VSL
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    }).join(' ');
  };

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
      return {
        ad_name: name,
        creative_id: name.slice(0, 50).replace(/[^a-zA-Z0-9]/g, '_'),
        hook_id: 'HX',
        type: 'video',
        avatar: null, angle: null, format: null, editor: null,
        week: null,
      };
    }
  }

  // Clean file extensions and trailing dashes/underscores from individual segments
  segments = segments.map(s => s.replace(/\.(mp4|mov|avi|mkv|png|jpg|jpeg|gif|webp|webm)$/i, '').replace(/[-_]+$/, '').trim());

  // Detect IM ads where segments[0] IS the creative ID (e.g. "IM110 - V5 - ...")
  // In that case there is no prefix — segments[0] is creativeId, segments[1] is hook
  const imLeadAd = /^IM\d/i.test(segments[0] || '');
  const creativeId = imLeadAd ? segments[0] : (segments[1] || null);

  // Detect if the hook position contains a hook (H1, H2, HX), version (V1, V2), or iteration marker (IT, NN, NA)
  let hookId = null;
  const hookIdx = imLeadAd ? 1 : 2;
  const seg2 = segments[hookIdx] || '';
  if (/^H\d+$/i.test(seg2) || /^HX$/i.test(seg2)) {
    hookId = seg2.toUpperCase();
  } else if (/^V\d+$/i.test(seg2)) {
    // Image ads use Vx (V1, V2, V3) as versions — treat as hook variant
    hookId = seg2.toUpperCase();
  } else if (/^(IT|NN|NA)$/i.test(seg2)) {
    // IT/NN/NA — look for hook in the next position
    const seg3 = segments[hookIdx + 1] || '';
    if (/^H\d+$/i.test(seg3) || /^HX$/i.test(seg3) || /^V\d+$/i.test(seg3)) {
      hookId = seg3.toUpperCase();
    } else {
      hookId = 'HX';
    }
  } else {
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
  if (weekPos >= 2) {
    let editorOffset;

    // Check which tail pattern matches
    const atWeekM1 = segments[weekPos - 1] || '';
    const atWeekM2 = segments[weekPos - 2] || '';
    const resPattern = /^\d+[xX]\d+$/i;

    if (/^NA\d*$/i.test(atWeekM1)) {
      // Short tail: ... Format - Editor - NA - Week
      editorOffset = 2;
    } else if (/^NA\d*$/i.test(atWeekM2) || resPattern.test(atWeekM2)) {
      // Long tail: ... Format - Editor1 - NA/Resolution - Editor2 - Week
      // Editor2 (sign-off) is at weekPos-1
      editorOffset = 1;
    } else {
      // No NA found — try assuming short tail
      editorOffset = 2;
    }

    editor = (weekPos - editorOffset >= 0) ? segments[weekPos - editorOffset] || null : null;
    // For long tail (editorOffset=1): skip Editor1 + NA/Res slots (3 positions from editor)
    // For short tail (editorOffset=2): skip NA slot (1 position from editor)
    const formatOffset = editorOffset === 1 ? 4 : (editorOffset + 1);
    format = (weekPos - formatOffset >= 0) ? segments[weekPos - formatOffset] || null : null;
    angle  = (weekPos - formatOffset - 1 >= 0) ? segments[weekPos - formatOffset - 1] || null : null;
    avatar = (weekPos - formatOffset - 2 >= 0) ? segments[weekPos - formatOffset - 2] || null : null;

    // Clean up placeholder values
    const placeholders = ['-', 'NA', 'NN', 'na', 'nn'];
    if (editor && placeholders.includes(editor)) editor = null;
    if (format && placeholders.includes(format)) format = null;
    if (angle && placeholders.includes(angle))   angle = null;
    if (avatar && placeholders.includes(avatar)) avatar = null;

    // Validate metadata: reject values that look like creative IDs, hook IDs, weeks, resolutions, or file artifacts
    const junkPattern = /^(B\d{3,}|H\d+|HX|IT|NN|MR|IM\d*|V\d+|WK\d+.*|\d+[xX]\d+)$/i;
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

    // Cross-validate: known editors should not appear as format/angle/avatar
    if (knownHas(KNOWN_EDITORS, format)) format = null;
    if (knownHas(KNOWN_EDITORS, angle)) angle = null;
    if (knownHas(KNOWN_EDITORS, avatar)) avatar = null;

    // Cross-validate: known formats should not appear as angle/avatar/editor
    if (knownHas(KNOWN_FORMATS, angle)) angle = null;
    if (knownHas(KNOWN_FORMATS, avatar)) avatar = null;
    if (knownHas(KNOWN_FORMATS, editor)) editor = null;

    // Cross-validate: if avatar slot has a known angle, look one step further back for the real avatar
    if (knownHas(KNOWN_ANGLES, avatar)) {
      // Two angles exist (e.g. MoneySeeker + Lottery) — the "avatar" is actually the primary angle
      // Look one position further back for the real avatar/creative description
      const realAvatarPos = weekPos - formatOffset - 3;
      if (realAvatarPos >= 0) {
        const candidate = segments[realAvatarPos] || null;
        // Only use if it's not junk
        const junk = /^(B\d{3,}|H\d+|HX|IT|NN|NA|MR|IM\d*|V\d+|WK\d+.*|\d+[xX]\d+)$/i;
        avatar = (candidate && !junk.test(candidate) && !['-', 'NA', 'NN', 'na', 'nn'].includes(candidate))
          ? candidate : null;
      } else {
        avatar = null;
      }
    }

    // Only accept recognized editors — reject brand owner names, unknowns, etc.
    if (editor && !knownHas(KNOWN_EDITORS, editor)) editor = null;
  } else {
    // No week marker found — scan remaining segments (after head) for known values
    // Head size depends on whether segments[0] is the creative ID (imLeadAd) or a prefix
    const headSize = imLeadAd ? (hookId ? 2 : 1) : (hookId ? 3 : 2);
    const startIdx = headSize;
    const pool = segments.slice(startIdx);

    // Strip placeholders / junk from pool
    const junkPattern = /^(B\d{3,}|H\d+|HX|IT|NN|NA|MR|IM\d*|V\d+|WK\d+.*|\d+[xX]\d+|-|)$/i;
    const clean = pool.filter(s => s && !junkPattern.test(s) && !['-', 'NA', 'NN', 'na', 'nn'].includes(s));

    // Scan for known values
    for (const seg of clean) {
      if (!editor && knownHas(KNOWN_EDITORS, seg)) { editor = seg; continue; }
      if (!format && knownHas(KNOWN_FORMATS, seg)) { format = seg; continue; }
      if (!angle && knownHas(KNOWN_ANGLES, seg)) { angle = seg; continue; }
    }

    // Second pass: if angle still missing, check for two-word angles (adjacent segments)
    if (!angle) {
      for (let i = 0; i < pool.length - 1; i++) {
        const twoWord = `${pool[i]} ${pool[i + 1]}`;
        if (knownHas(KNOWN_ANGLES, twoWord)) { angle = twoWord; break; }
      }
    }
  }

  // Determine type from creative ID prefix
  const type = creativeId && /^IM\d/i.test(creativeId) ? 'image' : 'video';

  return { ad_name: name, creative_id: creativeId, hook_id: hookId, type, avatar: titleCase(avatar), angle: titleCase(angle), format: titleCase(format), editor: titleCase(editor), week };
}

// ── Week / Date Helpers ─────────────────────────────────────────────

/**
 * Convert WKxx_YYYY to { startDate, endDate } in YYYY-MM-DD format (ISO week).
 */
function weekToDateRange(weekStr) {
  const match = weekStr.match(/WK(\d+)_(\d{4})/i);
  if (!match) return null;
  let weekNum = parseInt(match[1], 10);
  const year  = parseInt(match[2], 10);

  // Validate week bounds
  if (weekNum < 1) weekNum = 1;
  if (weekNum > 53) weekNum = 53;

  // Use UTC to avoid timezone drift
  const jan4      = new Date(Date.UTC(year, 0, 4));
  const dayOfWeek = jan4.getUTCDay() || 7;
  const mondayW1  = new Date(jan4);
  mondayW1.setUTCDate(jan4.getUTCDate() - dayOfWeek + 1);

  const start = new Date(mondayW1);
  start.setUTCDate(mondayW1.getUTCDate() + (weekNum - 1) * 7);

  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);

  const fmt = (d) => d.toISOString().slice(0, 10);
  return { startDate: fmt(start), endDate: fmt(end) };
}

/**
 * Get the current ISO week string, e.g. "WK12_2026".
 */
function getCurrentWeek() {
  const now = new Date();
  // Use UTC to avoid timezone/DST drift
  const year = now.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dayOfWeek = jan4.getUTCDay() || 7;
  const mondayW1 = new Date(jan4);
  mondayW1.setUTCDate(jan4.getUTCDate() - dayOfWeek + 1);

  const diff = Math.floor((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - mondayW1.getTime()) / (7 * 24 * 60 * 60 * 1000));
  let weekNum = diff + 1;

  // Handle dates before ISO week 1 Monday (roll back to last year's last week)
  if (weekNum < 1) {
    const prevJan4 = new Date(Date.UTC(year - 1, 0, 4));
    const prevDow = prevJan4.getUTCDay() || 7;
    const prevMondayW1 = new Date(prevJan4);
    prevMondayW1.setUTCDate(prevJan4.getUTCDate() - prevDow + 1);
    const prevDiff = Math.floor((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - prevMondayW1.getTime()) / (7 * 24 * 60 * 60 * 1000));
    weekNum = prevDiff + 1;
    return `WK${String(weekNum).padStart(2, '0')}_${year - 1}`;
  }

  return `WK${String(weekNum).padStart(2, '0')}_${year}`;
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

  // Revenue columns to try (order_revenue may not exist in all TW setups)
  const revenueColumns = ['order_revenue', 'pixel_revenue', 'revenue'];
  // Purchase columns to try
  const purchaseColumns = [
    'website_purchases', 'orders_quantity', 'pixel purchases', 'pixel_purchases',
    'purchases', 'pixel_capi_purchases', 'total_purchases', 'conversions',
  ];

  // Helper to run a TW SQL query; returns { ok, rows, status, errorText }
  async function twQuery(sql) {
    const res = await fetch(TW_SQL_URL, {
      method: 'POST',
      headers: {
        'x-api-key': TW_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        shopId: TW_SHOP_ID,
        query: sql.trim(),
        period: { startDate, endDate },
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (res.status === 401 || res.status === 403) {
      const text = await res.text();
      console.error(`[Creative Analysis] TW auth error ${res.status}: ${text.slice(0, 200)}`);
      return { ok: false, fatal: true };
    }
    if (res.status >= 500) {
      const text = await res.text();
      console.error(`[Creative Analysis] TW server error ${res.status}: ${text.slice(0, 200)}`);
      return { ok: false, fatal: true };
    }
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, fatal: false, errorText: text.slice(0, 100) };
    }
    const data = await res.json();
    const rows = Array.isArray(data) ? data : (data?.data || data?.rows || []);
    return { ok: true, rows };
  }

  // Step 1: Find the working revenue column (no purchase column, isolates the variable)
  let workingRevenueCol = null;
  for (const revenueCol of revenueColumns) {
    const revRef = revenueCol.includes(' ') ? `\`${revenueCol}\`` : revenueCol;
    const sql = `
      SELECT ad_name, SUM(spend) as total_spend, SUM(${revRef}) as total_revenue,
             SUM(impressions) as total_impressions, SUM(clicks) as total_clicks
      FROM pixel_joined_tvf
      WHERE event_date BETWEEN @startDate AND @endDate
      GROUP BY ad_name
      HAVING SUM(spend) > 0.01
      ORDER BY SUM(spend) DESC
      LIMIT 2000
    `;
    const result = await twQuery(sql);
    if (result.fatal) return [];
    if (result.ok) {
      const revenueOnlyRows = result.rows;
      workingRevenueCol = revenueCol;
      console.log(`[Creative Analysis] TW revenue column found: "${revenueCol}"`);
      // Step 2: Try adding purchase columns to the working query
      for (const purchaseCol of purchaseColumns) {
        const colRef = purchaseCol.includes(' ') ? `\`${purchaseCol}\`` : purchaseCol;
        const sqlWithPurchases = `
          SELECT ad_name, SUM(spend) as total_spend, SUM(${revenueCol}) as total_revenue,
                 SUM(${colRef}) as total_purchases,
                 SUM(impressions) as total_impressions, SUM(clicks) as total_clicks
          FROM pixel_joined_tvf
          WHERE event_date BETWEEN @startDate AND @endDate
          GROUP BY ad_name
          HAVING SUM(spend) > 0.01
          ORDER BY SUM(spend) DESC
          LIMIT 2000
        `;
        const pResult = await twQuery(sqlWithPurchases);
        if (pResult.fatal) return [];
        if (pResult.ok) {
          console.log(`[Creative Analysis] TW query OK — revenue="${revenueCol}", purchases="${purchaseCol}", rows=${pResult.rows.length}`);
          if (pResult.rows.length >= 2000) {
            console.warn('[Creative Analysis] WARNING: TW query hit 2000 row limit — some ads may be missing');
          }
          return pResult.rows;
        }
        console.warn(`[Creative Analysis] TW purchase column "${purchaseCol}" failed: ${pResult.errorText}`);
      }
      // No purchase column worked — return the revenue-only result
      console.warn('[Creative Analysis] WARNING: No purchase column available. Purchases will be 0.');
      console.log(`[Creative Analysis] TW query OK (no purchases) — revenue="${revenueCol}", rows=${revenueOnlyRows.length}`);
      if (revenueOnlyRows.length >= 2000) {
        console.warn('[Creative Analysis] WARNING: TW query hit 2000 row limit — some ads may be missing');
      }
      return revenueOnlyRows;
    }
    console.warn(`[Creative Analysis] TW revenue column "${revenueCol}" failed: ${result.errorText}`);
  }

  console.error('[Creative Analysis] All TW revenue column variants failed. No data returned.');
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

        -- Add indexes for common query patterns
        CREATE INDEX IF NOT EXISTS idx_ca_week_spend ON creative_analysis (week, spend DESC);
        CREATE INDEX IF NOT EXISTS idx_ca_creative_id ON creative_analysis (creative_id);
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

  // Guard: if all ads were skipped during parsing, don't wipe existing data
  if (aggregated.size === 0) {
    return { synced: 0, skipped, errors: 0, aggregatedFrom: 0 };
  }

  // Upsert data for this period week (no delete — ON CONFLICT handles updates)
  // Use pgDb.begin() to pin a single connection for the entire transaction
  let synced = 0;
  let errors = 0;

  await pgDb.begin(async (sql) => {
    for (const entry of aggregated.values()) {
      const metrics = computeMetrics(entry);

      await sql.unsafe(
        `INSERT INTO creative_analysis
           (ad_name, creative_id, hook_id, type, avatar, angle, format, editor, week,
            spend, revenue, purchases, impressions, clicks,
            roas, cpa, cpm, aov, cpc, ctr, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20, NOW())
         ON CONFLICT (creative_id, hook_id, week)
         DO UPDATE SET
           ad_name = EXCLUDED.ad_name,
           type = EXCLUDED.type,
           avatar = EXCLUDED.avatar,
           angle = EXCLUDED.angle,
           format = EXCLUDED.format,
           editor = EXCLUDED.editor,
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
    }
  });

  return { synced, skipped, errors, aggregatedFrom: twAds.length - skipped };
}

// ── Helpers: Lifetime metrics lookup ─────────────────────────────────

/**
 * Fetch lifetime aggregated metrics for a set of creative_ids.
 * Returns a Map keyed by creative_id.
 */
async function getLifetimeMetrics(creativeIds) {
  if (!creativeIds || creativeIds.length === 0) return new Map();

  try {
    const placeholders = creativeIds.map((_, i) => `$${i + 1}`).join(',');
    const rows = await pgQuery(
      `SELECT
         creative_id,
         SUM(spend) as lifetime_spend,
         SUM(revenue) as lifetime_revenue,
         SUM(purchases) as lifetime_purchases,
         COUNT(DISTINCT CASE WHEN spend > 0 THEN week END) as weeks_active,
         (ARRAY_AGG(week ORDER BY SPLIT_PART(week,'_',2)::int, REPLACE(SPLIT_PART(week,'_',1),'WK','')::int))[1] as first_seen,
         (ARRAY_AGG(week ORDER BY SPLIT_PART(week,'_',2)::int DESC, REPLACE(SPLIT_PART(week,'_',1),'WK','')::int DESC))[1] as last_seen
       FROM creative_analysis
       WHERE creative_id IN (${placeholders})
       GROUP BY creative_id`,
      creativeIds
    );

    const map = new Map();
    for (const r of rows) {
      const ls = Math.round(Number(r.lifetime_spend) * 100) / 100;
      const lr = Math.round(Number(r.lifetime_revenue) * 100) / 100;
      const lRoas = ls > 0 ? Math.round((lr / ls) * 100) / 100 : 0;
      map.set(r.creative_id, {
        lifetime_spend: ls,
        lifetime_revenue: lr,
        lifetime_roas: lRoas,
        lifetime_purchases: Number(r.lifetime_purchases),
        first_seen: r.first_seen,
        last_seen: r.last_seen,
        weeks_active: Number(r.weeks_active),
        is_winner: ls >= 500 && lRoas >= 1.80,
      });
    }
    return map;
  } catch (err) {
    console.error('[Creative Analysis] getLifetimeMetrics error:', err.message);
    return new Map();
  }
}

// ── Routes ──────────────────────────────────────────────────────────

/**
 * GET /data?week=WK12_2026
 * Returns all creatives for a week, grouped by creative_id with hook-level detail.
 * Also returns available filter values and lifetime metrics per creative.
 */
router.get('/data', authenticate, async (req, res) => {
  try {
    const { week } = req.query;
    if (!week) {
      return res.status(400).json({ success: false, error: { message: 'week parameter is required (e.g. WK12_2026)' } });
    }

    await ensureTable();

    // Fetch only active rows (spend > 0) for this week
    const rows = await pgQuery(
      'SELECT * FROM creative_analysis WHERE week = $1 AND spend > 0 ORDER BY spend DESC',
      [week.toUpperCase()]
    );

    // Group by creative_id — use highest-spend hook's metadata
    const grouped = {};
    for (const row of rows) {
      const cid = row.creative_id;
      const spend = Number(row.spend) || 0;

      if (!grouped[cid]) {
        grouped[cid] = {
          creative_id: cid,
          type: row.type,
          avatar: row.avatar,
          angle: row.angle,
          format: row.format,
          editor: row.editor,
          week: row.week,
          total_spend: 0,
          total_revenue: 0,
          total_purchases: 0,
          total_impressions: 0,
          total_clicks: 0,
          hooks: [],
          _topSpend: 0,
        };
      }

      const metrics = computeMetrics(row);
      grouped[cid].hooks.push({
        hook_id: row.hook_id,
        ad_name: row.ad_name,
        spend,
        revenue: Number(row.revenue),
        purchases: Number(row.purchases),
        impressions: Number(row.impressions),
        clicks: Number(row.clicks),
        ...metrics,
      });

      grouped[cid].total_spend      += spend;
      grouped[cid].total_revenue    += Number(row.revenue) || 0;
      grouped[cid].total_purchases  += Number(row.purchases) || 0;
      grouped[cid].total_impressions += Number(row.impressions) || 0;
      grouped[cid].total_clicks     += Number(row.clicks) || 0;

      // Prefer metadata from highest-spend hook
      if (spend > grouped[cid]._topSpend) {
        grouped[cid]._topSpend = spend;
        grouped[cid].type = row.type;
        if (row.avatar) grouped[cid].avatar = row.avatar;
        if (row.angle)  grouped[cid].angle = row.angle;
        if (row.format) grouped[cid].format = row.format;
        if (row.editor) grouped[cid].editor = row.editor;
      }
    }

    // Fetch lifetime metrics for all creative_ids in this week
    const creativeIds = Object.keys(grouped);
    const lifetimeMap = await getLifetimeMetrics(creativeIds);

    // Compute aggregate metrics per creative, include lifetime data
    const creatives = Object.values(grouped).map(c => {
      const lt = lifetimeMap.get(c.creative_id) || {
        lifetime_spend: 0, lifetime_revenue: 0, lifetime_roas: 0,
        lifetime_purchases: 0, first_seen: null, last_seen: null,
        weeks_active: 0, is_winner: false,
      };
      const { _topSpend, ...rest } = c;
      return {
        ...rest,
        total_spend:  Math.round(c.total_spend * 100) / 100,
        total_revenue: Math.round(c.total_revenue * 100) / 100,
        ...computeMetrics({
          spend: c.total_spend,
          revenue: c.total_revenue,
          purchases: c.total_purchases,
          impressions: c.total_impressions,
          clicks: c.total_clicks,
        }),
        ...lt,
      };
    });

    // Sort by spend descending
    creatives.sort((a, b) => b.total_spend - a.total_spend);

    // Collect available filter values for THIS week only (not global)
    const filterRows = await pgQuery(
      `SELECT DISTINCT avatar, angle, format, editor FROM creative_analysis WHERE week = $1`,
      [week.toUpperCase()]
    );

    // Get available weeks separately (year-aware ordering)
    const weekRows = await pgQuery(
      `SELECT week FROM (SELECT DISTINCT week FROM creative_analysis WHERE week IS NOT NULL) t
       ORDER BY SPLIT_PART(week,'_',2)::int DESC, REPLACE(SPLIT_PART(week,'_',1),'WK','')::int DESC`
    );

    const filters = {
      weeks:   weekRows.map(r => r.week),
      avatars: [...new Set(filterRows.map(r => r.avatar).filter(Boolean))].sort(),
      angles:  [...new Set(filterRows.map(r => r.angle).filter(Boolean))].sort(),
      formats: [...new Set(filterRows.map(r => r.format).filter(Boolean))].sort(),
      editors: [...new Set(filterRows.map(r => r.editor).filter(Boolean))].sort(),
    };

    res.json({ success: true, data: { creatives, filters } });
  } catch (err) {
    console.error('[Creative Analysis] /data error:', err);
    res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
});

/**
 * GET /data-by-date?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 * Queries Triple Whale directly for a custom date range and returns the same
 * grouped format as /data, without touching the week-based storage.
 */
router.get('/data-by-date', authenticate, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: { message: 'startDate and endDate query params are required (YYYY-MM-DD)' },
      });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      return res.status(400).json({
        success: false,
        error: { message: 'Dates must be in YYYY-MM-DD format' },
      });
    }

    if (startDate > endDate) {
      return res.status(400).json({
        success: false,
        error: { message: 'startDate must be on or before endDate' },
      });
    }

    const twAds = await fetchTripleWhaleAds(startDate, endDate);

    // Parse and aggregate by (creative_id, hook_id) — same pattern as syncData
    const hookAgg = new Map(); // key: "creative_id|hook_id"
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

      if (hookAgg.has(key)) {
        const existing = hookAgg.get(key);
        existing.spend += spend;
        existing.revenue += revenue;
        existing.purchases += purchases;
        existing.impressions += impressions;
        existing.clicks += clicks;
        if (spend > (existing._topSpend || 0)) {
          existing.ad_name = parsed.ad_name;
          existing._topSpend = spend;
          if (parsed.avatar) existing.avatar = parsed.avatar;
          if (parsed.angle)  existing.angle = parsed.angle;
          if (parsed.format) existing.format = parsed.format;
          if (parsed.editor) existing.editor = parsed.editor;
        }
      } else {
        hookAgg.set(key, {
          creative_id: parsed.creative_id,
          hook_id: parsed.hook_id,
          ad_name: parsed.ad_name,
          type: parsed.type,
          avatar: parsed.avatar,
          angle: parsed.angle,
          format: parsed.format,
          editor: parsed.editor,
          spend, revenue, purchases, impressions, clicks,
          _topSpend: spend,
        });
      }
    }

    // Group aggregated hooks by creative_id
    const grouped = {};
    for (const entry of hookAgg.values()) {
      const cid = entry.creative_id;
      const hookMetrics = computeMetrics(entry);

      if (!grouped[cid]) {
        grouped[cid] = {
          creative_id: cid,
          type: entry.type,
          avatar: entry.avatar,
          angle: entry.angle,
          format: entry.format,
          editor: entry.editor,
          total_spend: 0,
          total_revenue: 0,
          total_purchases: 0,
          total_impressions: 0,
          total_clicks: 0,
          hooks: [],
          _topSpend: 0,
        };
      }

      grouped[cid].hooks.push({
        hook_id: entry.hook_id,
        ad_name: entry.ad_name,
        spend: Math.round(entry.spend * 100) / 100,
        revenue: Math.round(entry.revenue * 100) / 100,
        purchases: entry.purchases,
        impressions: entry.impressions,
        clicks: entry.clicks,
        ...hookMetrics,
      });

      grouped[cid].total_spend      += entry.spend;
      grouped[cid].total_revenue    += entry.revenue;
      grouped[cid].total_purchases  += entry.purchases;
      grouped[cid].total_impressions += entry.impressions;
      grouped[cid].total_clicks     += entry.clicks;

      // Prefer metadata from the highest-spend hook (consistent with /data and /active)
      if (entry.spend > grouped[cid]._topSpend) {
        grouped[cid]._topSpend = entry.spend;
        if (entry.avatar) grouped[cid].avatar = entry.avatar;
        if (entry.angle)  grouped[cid].angle = entry.angle;
        if (entry.format) grouped[cid].format = entry.format;
        if (entry.editor) grouped[cid].editor = entry.editor;
      }
    }

    // Fetch lifetime metrics for all creative_ids
    const creativeIds = Object.keys(grouped);
    const lifetimeMap = await getLifetimeMetrics(creativeIds);

    const creatives = Object.values(grouped).map(c => {
      const { _topSpend, ...rest } = c;
      const lt = lifetimeMap.get(c.creative_id) || {
        lifetime_spend: 0, lifetime_revenue: 0, lifetime_roas: 0,
        lifetime_purchases: 0, first_seen: null, last_seen: null,
        weeks_active: 0, is_winner: false,
      };
      return {
        ...rest,
        total_spend:  Math.round(c.total_spend * 100) / 100,
        total_revenue: Math.round(c.total_revenue * 100) / 100,
        ...computeMetrics({
          spend: c.total_spend,
          revenue: c.total_revenue,
          purchases: c.total_purchases,
          impressions: c.total_impressions,
          clicks: c.total_clicks,
        }),
        ...lt,
      };
    });

    creatives.sort((a, b) => b.total_spend - a.total_spend);

    res.json({
      success: true,
      data: {
        creatives,
        dateRange: { startDate, endDate },
        meta: { total_ads: twAds.length, parsed: twAds.length - skipped, skipped },
      },
    });
  } catch (err) {
    console.error('[Creative Analysis] /data-by-date error:', err);
    res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
});

/**
 * GET /lifetime?creative_id=B0066
 * Returns lifetime aggregated metrics across ALL weeks for a given creative_id,
 * plus a weekly breakdown array.
 */
router.get('/lifetime', authenticate, async (req, res) => {
  try {
    const { creative_id } = req.query;
    if (!creative_id) {
      return res.status(400).json({
        success: false,
        error: { message: 'creative_id query param is required (e.g. B0066)' },
      });
    }

    await ensureTable();

    // Fetch all rows for this creative across all weeks
    const rows = await pgQuery(
      'SELECT * FROM creative_analysis WHERE creative_id = $1 ORDER BY week ASC, spend DESC',
      [creative_id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: { message: `No data found for creative_id "${creative_id}"` },
      });
    }

    // Aggregate lifetime totals
    let totalSpend = 0, totalRevenue = 0, totalPurchases = 0, totalImpressions = 0, totalClicks = 0;
    const weeklyMap = {};

    for (const row of rows) {
      const spend = Number(row.spend) || 0;
      const revenue = Number(row.revenue) || 0;
      const purchases = Number(row.purchases) || 0;
      const impressions = Number(row.impressions) || 0;
      const clicks = Number(row.clicks) || 0;

      totalSpend += spend;
      totalRevenue += revenue;
      totalPurchases += purchases;
      totalImpressions += impressions;
      totalClicks += clicks;

      if (!weeklyMap[row.week]) {
        weeklyMap[row.week] = {
          week: row.week,
          spend: 0, revenue: 0, purchases: 0, impressions: 0, clicks: 0,
          hooks: [],
        };
      }

      weeklyMap[row.week].spend += spend;
      weeklyMap[row.week].revenue += revenue;
      weeklyMap[row.week].purchases += purchases;
      weeklyMap[row.week].impressions += impressions;
      weeklyMap[row.week].clicks += clicks;
      weeklyMap[row.week].hooks.push({
        hook_id: row.hook_id,
        ad_name: row.ad_name,
        spend: Math.round(spend * 100) / 100,
        revenue: Math.round(revenue * 100) / 100,
        purchases,
        impressions,
        clicks,
        ...computeMetrics(row),
      });
    }

    // Build weekly breakdown with computed metrics, sorted chronologically
    const weeklyBreakdown = Object.values(weeklyMap)
      .sort((a, b) => {
        const [wA, yA] = a.week.replace('WK', '').split('_').map(Number);
        const [wB, yB] = b.week.replace('WK', '').split('_').map(Number);
        return yA - yB || wA - wB;
      })
      .map(w => ({
        ...w,
        spend: Math.round(w.spend * 100) / 100,
        revenue: Math.round(w.revenue * 100) / 100,
        ...computeMetrics(w),
      }));

    const weeks = weeklyBreakdown.map(w => w.week);
    const weeksWithSpend = weeklyBreakdown.filter(w => w.spend > 0).length;

    const lifetimeSpend = Math.round(totalSpend * 100) / 100;
    const lifetimeRevenue = Math.round(totalRevenue * 100) / 100;
    const lifetimeRoas = lifetimeSpend > 0 ? Math.round((lifetimeRevenue / lifetimeSpend) * 100) / 100 : 0;
    // Get metadata from the row with highest spend
    const topRow = rows.reduce((a, b) => (Number(b.spend) > Number(a.spend) ? b : a), rows[0]);

    res.json({
      success: true,
      data: {
        creative_id: creative_id.toUpperCase(),
        type: topRow.type,
        avatar: topRow.avatar,
        angle: topRow.angle,
        format: topRow.format,
        editor: topRow.editor,
        lifetime_spend: lifetimeSpend,
        lifetime_revenue: lifetimeRevenue,
        lifetime_roas: lifetimeRoas,
        lifetime_purchases: totalPurchases,
        first_seen: weeks[0] || null,
        last_seen: weeks[weeks.length - 1] || null,
        weeks_active: weeksWithSpend,
        is_winner: lifetimeSpend >= 500 && lifetimeRoas >= 1.80,
        weekly_breakdown: weeklyBreakdown,
      },
    });
  } catch (err) {
    console.error('[Creative Analysis] /lifetime error:', err);
    res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
});

/**
 * GET /active
 * Returns creatives that had spend > 0 in the latest week, sorted by spend DESC.
 * Includes lifetime metrics and is_winner flag.
 */
router.get('/active', authenticate, async (req, res) => {
  try {
    await ensureTable();

    // Find the latest week (sort by year then week number for correct cross-year ordering)
    const latestRows = await pgQuery(
      `SELECT week FROM (SELECT DISTINCT week FROM creative_analysis WHERE week IS NOT NULL) t
       ORDER BY SPLIT_PART(week, '_', 2)::int DESC, REPLACE(SPLIT_PART(week, '_', 1), 'WK', '')::int DESC LIMIT 1`
    );
    if (latestRows.length === 0) {
      return res.json({ success: true, data: { creatives: [], latest_week: null } });
    }
    const latestWeek = latestRows[0].week;

    // Get active creatives (spend > 0 in latest week) with hook-level detail
    const activeRows = await pgQuery(
      `SELECT * FROM creative_analysis WHERE week = $1 AND spend > 0 ORDER BY spend DESC`,
      [latestWeek]
    );

    // Group by creative_id — use highest-spend hook's metadata (same as /data)
    const grouped = {};
    for (const row of activeRows) {
      const cid = row.creative_id;
      const spend = Number(row.spend) || 0;

      if (!grouped[cid]) {
        grouped[cid] = {
          creative_id: cid,
          type: row.type,
          avatar: row.avatar,
          angle: row.angle,
          format: row.format,
          editor: row.editor,
          total_spend: 0,
          total_revenue: 0,
          total_purchases: 0,
          total_impressions: 0,
          total_clicks: 0,
          hooks: [],
          _topSpend: 0,
        };
      }

      const metrics = computeMetrics(row);
      grouped[cid].hooks.push({
        hook_id: row.hook_id,
        ad_name: row.ad_name,
        spend,
        revenue: Number(row.revenue),
        purchases: Number(row.purchases),
        impressions: Number(row.impressions),
        clicks: Number(row.clicks),
        ...metrics,
      });

      grouped[cid].total_spend      += spend;
      grouped[cid].total_revenue    += Number(row.revenue) || 0;
      grouped[cid].total_purchases  += Number(row.purchases) || 0;
      grouped[cid].total_impressions += Number(row.impressions) || 0;
      grouped[cid].total_clicks     += Number(row.clicks) || 0;

      if (spend > grouped[cid]._topSpend) {
        grouped[cid]._topSpend = spend;
        grouped[cid].type = row.type;
        if (row.avatar) grouped[cid].avatar = row.avatar;
        if (row.angle)  grouped[cid].angle = row.angle;
        if (row.format) grouped[cid].format = row.format;
        if (row.editor) grouped[cid].editor = row.editor;
      }
    }

    // Get lifetime metrics for all active creative_ids
    const creativeIds = Object.keys(grouped);
    const lifetimeMap = await getLifetimeMetrics(creativeIds);

    const creatives = Object.values(grouped).map(c => {
      const lt = lifetimeMap.get(c.creative_id) || {
        lifetime_spend: 0, lifetime_revenue: 0, lifetime_roas: 0,
        lifetime_purchases: 0, first_seen: null, last_seen: null,
        weeks_active: 0, is_winner: false,
      };
      const { _topSpend, ...rest } = c;
      return {
        ...rest,
        total_spend:  Math.round(c.total_spend * 100) / 100,
        total_revenue: Math.round(c.total_revenue * 100) / 100,
        ...computeMetrics({
          spend: c.total_spend,
          revenue: c.total_revenue,
          purchases: c.total_purchases,
          impressions: c.total_impressions,
          clicks: c.total_clicks,
        }),
        ...lt,
      };
    });

    creatives.sort((a, b) => b.total_spend - a.total_spend);

    res.json({ success: true, data: { creatives, latest_week: latestWeek } });
  } catch (err) {
    console.error('[Creative Analysis] /active error:', err);
    res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
});

/**
 * GET /leaderboard?week=WK12_2026
 * Top 10 by ROAS, top 10 by Purchases, top 10 by Efficiency (lowest CPA).
 * Aggregated at creative_id level. Min $200 spend filter.
 * Includes lifetime metrics and is_winner flag.
 */
router.get('/leaderboard', authenticate, async (req, res) => {
  try {
    const { week } = req.query;
    if (!week) {
      return res.status(400).json({ success: false, error: { message: 'week parameter is required' } });
    }

    await ensureTable();

    // Aggregate at creative_id level for the given week, min $200 spend
    // Use DISTINCT ON to pick metadata from the highest-spend hook per creative
    const aggregated = await pgQuery(
      `SELECT
         agg.creative_id,
         top.type,
         top.avatar,
         top.angle,
         top.format,
         top.editor,
         top.ad_name,
         agg.spend,
         agg.revenue,
         agg.purchases,
         agg.impressions,
         agg.clicks
       FROM (
         SELECT creative_id,
           SUM(spend) as spend, SUM(revenue) as revenue,
           SUM(purchases) as purchases, SUM(impressions) as impressions,
           SUM(clicks) as clicks
         FROM creative_analysis WHERE week = $1
         GROUP BY creative_id HAVING SUM(spend) >= 200
       ) agg
       JOIN LATERAL (
         SELECT type, avatar, angle, format, editor, ad_name
         FROM creative_analysis
         WHERE creative_id = agg.creative_id AND week = $1
         ORDER BY spend DESC LIMIT 1
       ) top ON true
       ORDER BY agg.spend DESC`,
      [week.toUpperCase()]
    );

    // Get lifetime metrics for all leaderboard creative_ids
    const creativeIds = aggregated.map(r => r.creative_id);
    const lifetimeMap = await getLifetimeMetrics(creativeIds);

    // Compute metrics for each, include lifetime data
    const withMetrics = aggregated.map(row => {
      const lt = lifetimeMap.get(row.creative_id) || {
        lifetime_spend: 0, lifetime_revenue: 0, lifetime_roas: 0,
        lifetime_purchases: 0, first_seen: null, last_seen: null,
        weeks_active: 0, is_winner: false,
      };
      return {
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
        ...lt,
      };
    });

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
    res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
});

/**
 * POST /sync
 * Manual sync trigger. Accepts { week } OR { week, startDate, endDate }.
 * If startDate/endDate are provided alongside week, they override the derived range.
 */
router.post('/sync', authenticate, async (req, res) => {
  try {
    let { startDate, endDate, week } = req.body || {};

    if (!week || !/^WK\d{1,2}_\d{4}$/i.test(week)) {
      return res.status(400).json({
        success: false,
        error: { message: 'Provide { week } in WKxx_YYYY format' },
      });
    }
    week = week.toUpperCase().replace(/\s/, '_');

    // Validate user-provided dates if given
    if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) startDate = null;
    if (endDate && !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) endDate = null;

    // Use user-provided dates if both are given; otherwise derive from week
    if (!startDate || !endDate) {
      const range = weekToDateRange(week);
      if (!range) {
        return res.status(400).json({ success: false, error: { message: 'Invalid week format. Use WKxx_YYYY.' } });
      }
      startDate = range.startDate;
      endDate   = range.endDate;
    }

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
    res.status(500).json({ success: false, error: { message: 'Sync failed' } });
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
    res.status(500).json({ success: false, error: { message: 'Weekly sync failed' } });
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
      `SELECT week FROM (SELECT DISTINCT week FROM creative_analysis WHERE week IS NOT NULL) t
       ORDER BY SPLIT_PART(week,'_',2)::int, REPLACE(SPLIT_PART(week,'_',1),'WK','')::int`
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
    res.status(500).json({ success: false, error: { message: 'Sync-all failed' } });
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
       ORDER BY SPLIT_PART(week,'_',2)::int DESC, REPLACE(SPLIT_PART(week,'_',1),'WK','')::int DESC`
    );

    const weeks = rows.map(r => ({
      week: r.week,
      creative_count: Number(r.creative_count),
      total_spend: Math.round(Number(r.total_spend) * 100) / 100,
    }));

    res.json({ success: true, data: { weeks } });
  } catch (err) {
    console.error('[Creative Analysis] /weeks error:', err);
    res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
});

// ── Auto-Sync (every 5 minutes) ─────────────────────────────────────
let autoSyncRunning = false;

async function autoSync() {
  if (autoSyncRunning || !TW_API_KEY) return;
  autoSyncRunning = true;
  try {
    const week = getCurrentWeek();
    const range = weekToDateRange(week);
    if (range) {
      const result = await syncData({ periodWeek: week, startDate: range.startDate, endDate: range.endDate });
      console.log(`[Creative Analysis] Auto-sync ${week}: synced=${result.synced}, skipped=${result.skipped}`);
    }
  } catch (err) {
    console.error('[Creative Analysis] Auto-sync error:', err.message);
  } finally {
    autoSyncRunning = false;
  }
}

// One-time historical backfill: sync past 12 weeks if not already in DB
let historyBackfilled = false;
async function backfillHistory() {
  if (historyBackfilled || !TW_API_KEY) return;
  historyBackfilled = true;
  try {
    await ensureTable();
    // Check which weeks already exist
    const existing = await pgQuery('SELECT DISTINCT week FROM creative_analysis WHERE week IS NOT NULL');
    const existingSet = new Set(existing.map(r => r.week));

    // Generate past 12 weeks
    const weeks = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i * 7);
      const oneJan = new Date(d.getFullYear(), 0, 1);
      const weekNum = Math.ceil(((d - oneJan) / 86400000 + oneJan.getDay() + 1) / 7);
      const wk = `WK${String(weekNum).padStart(2, '0')}_${d.getFullYear()}`;
      if (!existingSet.has(wk)) weeks.push(wk);
    }

    if (weeks.length === 0) {
      console.log('[Creative Analysis] History backfill: all weeks already synced');
      return;
    }

    console.log(`[Creative Analysis] History backfill: syncing ${weeks.length} missing weeks: ${weeks.join(', ')}`);
    for (const week of weeks) {
      try {
        const range = weekToDateRange(week);
        if (!range) continue;
        const result = await syncData({ periodWeek: week, startDate: range.startDate, endDate: range.endDate });
        console.log(`[Creative Analysis] Backfill ${week}: synced=${result.synced}, skipped=${result.skipped}`);
      } catch (err) {
        console.error(`[Creative Analysis] Backfill ${week} failed:`, err.message);
      }
    }
    console.log('[Creative Analysis] History backfill complete');
  } catch (err) {
    console.error('[Creative Analysis] History backfill error:', err.message);
  }
}

// Start auto-sync after 30s delay, then every 5 minutes
// Also trigger one-time history backfill
setTimeout(() => {
  autoSync();
  backfillHistory();
  setInterval(autoSync, 5 * 60 * 1000);
}, 30_000);

export default router;
