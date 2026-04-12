import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { pgQuery, pgDb } from '../db/pg.js';

const router = Router();
router.use(authenticate, requirePermission('creative-analysis', 'access'));

// ── Config ──────────────────────────────────────────────────────────
const TW_API_KEY  = process.env.TRIPLEWHALE_API_KEY || '';
const TW_SHOP_ID  = process.env.TRIPLEWHALE_SHOP_ID || '17cca0-2.myshopify.com';
const TW_SQL_URL  = 'https://api.triplewhale.com/api/v2/orcabase/api/sql';
const CRON_SECRET = process.env.CRON_SECRET || '';
// Triple Whale attribution model — must match what TW dashboard shows
// Options: 'lastPlatformClick', 'firstClick', 'lastClick', 'linear', 'fullImpact'
const TW_ATTRIBUTION_MODEL = process.env.TW_ATTRIBUTION_MODEL || 'lastPlatformClick';
// Triple Whale revenue/purchase columns — configurable to match TW dashboard view
// Revenue: 'order_revenue' (Triple Attribution) or 'channel_reported_conversion_value' (Platform/Meta reported)
// Purchases: 'website_purchases' (Triple Attribution) or 'channel_reported_conversions' (Platform/Meta reported)
const TW_REVENUE_COL = process.env.TW_REVENUE_COL || 'order_revenue';
const TW_PURCHASE_COL = process.env.TW_PURCHASE_COL || 'website_purchases';

// Meta Marketing API config
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const META_AD_ACCOUNT_IDS = (process.env.META_AD_ACCOUNT_IDS || '').split(',').filter(Boolean);
const META_GRAPH_URL = 'https://graph.facebook.com/v21.0';

let tableReady = false; // cache ensureTable so it only runs once
let twKnownRevCol = null; // cache discovered TW column names across requests — cleared on deploy
let twKnownPurCol = null;

// Server-side cache for /data-by-date results (avoids repeated TW API calls)
const dataByDateCache = new Map(); // key: "startDate|endDate" → { data, timestamp }
const DATA_CACHE_TTL = 10 * 60 * 1000; // 10 minutes (TW API calls are slow, cache longer)

// Server-side cache for /creative-daily results
const creativeDailyCache = new Map(); // key: "creative_id|startDate|endDate" → { data, timestamp }
const CREATIVE_DAILY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Cache for latest week (avoids running the expensive SPLIT_PART query on every page load)
let latestWeekCache = { week: null, timestamp: 0 };
const LATEST_WEEK_CACHE_TTL = 60 * 1000; // 1 minute

// Response caches for /active and /leaderboard (avoid re-querying DB on every page load)
const activeCache = { data: null, timestamp: 0 };
const leaderboardCache = new Map(); // key: week → { data, timestamp }
const RESPONSE_CACHE_TTL = 60 * 1000; // 1 minute

// ── Known Values (for cross-validation) ─────────────────────────────
// These sets prevent fields from leaking into the wrong slot when segment counts vary.
// All stored lowercase for case-insensitive matching via knownHas() helper.
const KNOWN_FORMATS = new Set([
  'shortvid', 'mashup', 'mashups', 'mini vsl', 'minivsl', 'long form', 'long vsl',
  'longvsl', 'vsl', 'img', 'ugc', 'gif',
]);

const KNOWN_EDITORS = new Set([
  'ludovico', 'ludo', 'uly', 'dimaranan', 'fazlul',
  'muhammad', 'atif', 'ali', 'hamza', 'usama', 'carl',
  'alhamjatonni', 'abdul', 'robi', 'abdullah', 'farhan',
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
      if (w === w.toUpperCase()) return w; // preserve all-caps: UGC, IMG, GTRS, VSL
      if (w !== w.toLowerCase()) return w; // preserve camelCase: ShortVid, MoneySeeker
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
      // Final fallback: space-delimited ads like "MR B0143 H3 IT B0011 NA Againstcompetition Mashup Ludovico NA Uly WK14 2026"
      // Only try if name contains a creative ID pattern (B\d{3,}) and week pattern (WK\d+)
      if (/B\d{3,}/i.test(cleanName) && /WK\d+/i.test(cleanName)) {
        const spaceSegments = cleanName.split(/\s+/).filter(Boolean);
        // Rejoin split week (e.g. ["WK14", "2026"] → "WK14_2026")
        for (let i = spaceSegments.length - 1; i >= 1; i--) {
          if (/^\d{4}$/.test(spaceSegments[i]) && /^WK\d+$/i.test(spaceSegments[i - 1])) {
            spaceSegments.splice(i - 1, 2, `${spaceSegments[i - 1]}_${spaceSegments[i]}`);
            break;
          }
        }
        if (spaceSegments.length >= 3) {
          segments = spaceSegments;
        } else {
          return null;
        }
      } else {
        return null; // Not a parseable ad name — skip
      }
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
    } else if (weekPos >= 3 && knownHas(KNOWN_EDITORS, atWeekM1) && knownHas(KNOWN_EDITORS, atWeekM2)) {
      // Triple-editor tail: ... Format - Editor1 - Editor2 - Editor3 - Week (no NA)
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
    // Track all angle matches — if two known angles appear, first is avatar, second is angle
    const angleMatches = [];
    for (const seg of clean) {
      if (!editor && knownHas(KNOWN_EDITORS, seg)) { editor = seg; continue; }
      if (!format && knownHas(KNOWN_FORMATS, seg)) { format = seg; continue; }
      if (knownHas(KNOWN_ANGLES, seg)) { angleMatches.push(seg); continue; }
    }
    if (angleMatches.length >= 2) {
      // Convention: Avatar - Angle - Format → first match is avatar, second is angle
      avatar = angleMatches[0];
      angle = angleMatches[1];
    } else if (angleMatches.length === 1) {
      angle = angleMatches[0];
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

  // Revenue/purchase columns — use configured columns first, then fallbacks (deduplicated)
  const uniqueRevCols = [...new Set([TW_REVENUE_COL, 'order_revenue', 'channel_reported_conversion_value'])];
  const uniquePurCols = [...new Set([TW_PURCHASE_COL, 'website_purchases', 'channel_reported_conversions'])];

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
        attributionModel: TW_ATTRIBUTION_MODEL,
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

  // Try cached column combo first (skip discovery on repeat calls)
  if (twKnownRevCol) {
    const revRef = twKnownRevCol.includes(' ') ? `\`${twKnownRevCol}\`` : twKnownRevCol;
    const purPart = twKnownPurCol
      ? `, SUM(${twKnownPurCol.includes(' ') ? `\`${twKnownPurCol}\`` : twKnownPurCol}) as total_purchases`
      : '';
    const cachedSql = `
      SELECT ad_name, SUM(spend) as total_spend, SUM(${revRef}) as total_revenue${purPart},
             SUM(impressions) as total_impressions, SUM(clicks) as total_clicks
      FROM pixel_joined_tvf
      WHERE event_date BETWEEN @startDate AND @endDate
      GROUP BY ad_name
      HAVING SUM(spend) > 0.01
      ORDER BY SUM(spend) DESC
      LIMIT 2000
    `;
    const cachedResult = await twQuery(cachedSql);
    if (cachedResult.ok) {
      console.log(`[Creative Analysis] TW query OK (cached cols) — revenue="${twKnownRevCol}", purchases="${twKnownPurCol || 'none'}", attribution="${TW_ATTRIBUTION_MODEL}", rows=${cachedResult.rows.length}`);
      return cachedResult.rows;
    }
    // Cached combo failed — clear cache and fall through to discovery
    twKnownRevCol = null;
    twKnownPurCol = null;
  }

  // Column discovery: try configured column first, then fallbacks
  let workingRevenueCol = null;
  for (const revenueCol of uniqueRevCols) {
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
      // Try adding purchase columns to the working query
      for (const purchaseCol of uniquePurCols) {
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
          console.log(`[Creative Analysis] TW query OK — revenue="${revenueCol}", purchases="${purchaseCol}", attribution="${TW_ATTRIBUTION_MODEL}", rows=${pResult.rows.length}`);
          twKnownRevCol = revenueCol;
          twKnownPurCol = purchaseCol;
          if (pResult.rows.length >= 2000) {
            console.warn('[Creative Analysis] WARNING: TW query hit 2000 row limit — some ads may be missing');
          }
          return pResult.rows;
        }
        console.warn(`[Creative Analysis] TW purchase column "${purchaseCol}" failed: ${pResult.errorText}`);
      }
      // No purchase column worked — return the revenue-only result
      console.warn('[Creative Analysis] WARNING: No purchase column available. Purchases will be 0.');
      twKnownRevCol = revenueCol;
      twKnownPurCol = null;
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

        -- Meta thumbnail/video columns
        ALTER TABLE creative_analysis ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;
        ALTER TABLE creative_analysis ADD COLUMN IF NOT EXISTS video_url TEXT;
        ALTER TABLE creative_analysis ADD COLUMN IF NOT EXISTS meta_ad_id TEXT;

        -- Add indexes for common query patterns
        CREATE INDEX IF NOT EXISTS idx_ca_week_spend ON creative_analysis (week, spend DESC);
        CREATE INDEX IF NOT EXISTS idx_ca_creative_id ON creative_analysis (creative_id);
        CREATE INDEX IF NOT EXISTS idx_ca_ad_name ON creative_analysis (ad_name);
        -- Composite index for lifetime metrics (creative_id + week)
        CREATE INDEX IF NOT EXISTS idx_ca_creative_week ON creative_analysis (creative_id, week);
        -- Index for thumbnail lookup
        CREATE INDEX IF NOT EXISTS idx_ca_creative_synced ON creative_analysis (creative_id, synced_at DESC NULLS LAST);
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

// ── Cached Latest Week ────────────────────────────────────────────────

async function getLatestWeek() {
  const now = Date.now();
  if (latestWeekCache.week && (now - latestWeekCache.timestamp) < LATEST_WEEK_CACHE_TTL) {
    return latestWeekCache.week;
  }
  const rows = await pgQuery(
    `SELECT week FROM (SELECT DISTINCT week FROM creative_analysis WHERE week IS NOT NULL) t
     ORDER BY SPLIT_PART(week, '_', 2)::int DESC, REPLACE(SPLIT_PART(week, '_', 1), 'WK', '')::int DESC LIMIT 1`
  );
  const week = rows.length > 0 ? rows[0].week : null;
  latestWeekCache = { week, timestamp: now };
  return week;
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
    // Optimized: use a CTE to compute a numeric week_key (year*100+weeknum)
    // then use MIN/MAX instead of ARRAY_AGG + SPLIT_PART + ORDER BY
    const rows = await pgQuery(
      `WITH keyed AS (
         SELECT creative_id, week, spend,
                revenue, purchases,
                SPLIT_PART(week,'_',2)::int * 100 + REPLACE(SPLIT_PART(week,'_',1),'WK','')::int AS wk
         FROM creative_analysis
         WHERE creative_id IN (${placeholders})
       ),
       agg AS (
         SELECT creative_id,
           SUM(spend) as lifetime_spend,
           SUM(revenue) as lifetime_revenue,
           SUM(purchases) as lifetime_purchases,
           COUNT(DISTINCT CASE WHEN spend > 0 THEN week END) as weeks_active,
           MIN(wk) as min_wk,
           MAX(wk) as max_wk
         FROM keyed GROUP BY creative_id
       )
       SELECT a.*,
         (SELECT k.week FROM keyed k WHERE k.creative_id = a.creative_id AND k.wk = a.min_wk LIMIT 1) as first_seen,
         (SELECT k.week FROM keyed k WHERE k.creative_id = a.creative_id AND k.wk = a.max_wk LIMIT 1) as last_seen
       FROM agg a`,
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

// ── Meta Thumbnails Sync ─────────────────────────────────────────────

/**
 * Fetch all ads from all Meta ad accounts and match them to our creative_analysis
 * rows by ad_name. Updates thumbnail_url, video_url, and meta_ad_id.
 */
async function syncMetaThumbnails() {
  if (!META_ACCESS_TOKEN || META_AD_ACCOUNT_IDS.length === 0) {
    console.warn('[Meta Sync] No META_ACCESS_TOKEN or META_AD_ACCOUNT_IDS configured');
    return { matched: 0, total: 0 };
  }

  await ensureTable();

  // 1. Get all unique ad_names that need thumbnails, have expired iframe preview URLs,
  //    or have thumbnails older than 12 hours (Meta CDN URLs expire)
  const dbRows = await pgQuery(
    `SELECT DISTINCT ad_name, creative_id FROM creative_analysis
     WHERE ad_name IS NOT NULL
       AND (thumbnail_url IS NULL OR thumbnail_url = ''
            OR (LOWER(type) = 'video' AND (video_url IS NULL OR video_url = ''))
            OR synced_at IS NULL
            OR synced_at < NOW() - INTERVAL '12 hours')`
  );
  const dbAdNames = new Set(dbRows.map(r => r.ad_name));
  // Build a map of creative_id -> ad_names for fuzzy matching
  const creativeIdToAdNames = new Map();
  for (const r of dbRows) {
    if (!creativeIdToAdNames.has(r.creative_id)) creativeIdToAdNames.set(r.creative_id, []);
    creativeIdToAdNames.get(r.creative_id).push(r.ad_name);
  }

  // 2. Fetch ads from all Meta accounts
  const metaAds = [];

  for (const accountId of META_AD_ACCOUNT_IDS) {
    try {
      let url = `${META_GRAPH_URL}/${accountId}/ads?fields=name,creative.fields(thumbnail_url,image_url,object_story_spec,video_id).thumbnail_width(720).thumbnail_height(720)&limit=100&access_token=${META_ACCESS_TOKEN}`;
      let pageCount = 0;

      while (url && pageCount < 20) {
        const resp = await fetch(url);
        const data = await resp.json();
        if (data.error) {
          console.warn(`[Meta Sync] Error for ${accountId}:`, data.error.message);
          break;
        }
        if (data.data) {
          for (const ad of data.data) { ad._sourceAccount = accountId; }
          metaAds.push(...data.data);
        }
        url = data.paging?.next || null;
        pageCount++;
      }
    } catch (err) {
      console.warn(`[Meta Sync] Fetch error for ${accountId}:`, err.message);
    }
  }

  console.log(`[Meta Sync] Fetched ${metaAds.length} ads from ${META_AD_ACCOUNT_IDS.length} accounts`);

  // 3. Match Meta ads to DB rows by ad_name
  let matched = 0;
  const updates = [];

  for (const ad of metaAds) {
    if (!ad.name) continue;
    // For video ads, use thumbnail_url (video frame preview); image_url is the page profile pic
    // For image ads, prefer image_url (full res) over thumbnail_url
    const isVideoAd = !!ad.creative?.video_id;
    const thumbnailUrl = isVideoAd
      ? (ad.creative?.thumbnail_url || ad.creative?.image_url || null)
      : (ad.creative?.image_url || ad.creative?.thumbnail_url || null);
    if (!thumbnailUrl) continue;

    if (dbAdNames.has(ad.name)) {
      // Exact match
      updates.push({
        ad_name: ad.name,
        thumbnail_url: thumbnailUrl,
        video_id: ad.creative?.video_id || null,
        meta_ad_id: ad.id,
        account_id: ad._sourceAccount,
      });
    } else {
      // Fuzzy match: extract creative_id from Meta ad name and match to DB rows missing thumbnails
      const parsed = parseAdName(ad.name);
      if (parsed?.creative_id && creativeIdToAdNames.has(parsed.creative_id)) {
        for (const dbName of creativeIdToAdNames.get(parsed.creative_id)) {
          updates.push({
            ad_name: dbName,
            thumbnail_url: thumbnailUrl,
            video_id: ad.creative?.video_id || null,
            meta_ad_id: ad.id,
            account_id: ad._sourceAccount,
          });
        }
      }
    }
  }

  // 4. For video ads, fetch video source URLs
  //    Strategy: bulk-fetch advideos per account, then try direct /{video_id} as fallback
  const adIdsWithVideo = updates.filter(u => u.video_id);
  const videoSourceUrls = new Map(); // video_id -> source URL

  // Group video_ids by their source account so we query the right account
  const videoIdsByAccount = new Map(); // account_id -> Set of video_ids
  for (const upd of adIdsWithVideo) {
    if (!videoIdsByAccount.has(upd.account_id)) videoIdsByAccount.set(upd.account_id, new Set());
    videoIdsByAccount.get(upd.account_id).add(upd.video_id);
  }

  // Bulk-fetch advideos from each account
  for (const accountId of META_AD_ACCOUNT_IDS) {
    try {
      let url = `${META_GRAPH_URL}/${accountId}/advideos?fields=id,source&limit=100&access_token=${META_ACCESS_TOKEN}`;
      let pageCount = 0;
      while (url && pageCount < 20) {
        const resp = await fetch(url);
        const data = await resp.json();
        if (data.error) {
          console.warn(`[Meta Sync] advideos error for ${accountId}:`, data.error.message);
          break;
        }
        for (const v of (data.data || [])) {
          if (v.source) videoSourceUrls.set(v.id, v.source);
        }
        url = data.paging?.next || null;
        pageCount++;
      }
    } catch (err) {
      console.warn(`[Meta Sync] advideos fetch error for ${accountId}:`, err.message);
    }
  }
  console.log(`[Meta Sync] Bulk advideos: ${videoSourceUrls.size} source URLs. Video ads: ${adIdsWithVideo.length}`);

  // Fallback: for video_ids not found in bulk, try direct /{video_id}?fields=source
  const missingVideoIds = adIdsWithVideo
    .filter(u => !videoSourceUrls.has(u.video_id))
    .map(u => u.video_id);
  const uniqueMissing = [...new Set(missingVideoIds)];
  if (uniqueMissing.length > 0) {
    console.log(`[Meta Sync] ${uniqueMissing.length} video_ids not found in bulk, trying direct fetch...`);
    let directFound = 0;
    // Limit direct fetches to avoid rate limits (max 50 at a time)
    for (const vid of uniqueMissing.slice(0, 50)) {
      try {
        const resp = await fetch(
          `${META_GRAPH_URL}/${vid}?fields=source&access_token=${META_ACCESS_TOKEN}`,
          { signal: AbortSignal.timeout(8000) }
        );
        if (resp.ok) {
          const data = await resp.json();
          if (data.source) {
            videoSourceUrls.set(vid, data.source);
            directFound++;
          }
        }
      } catch (e) { /* skip */ }
    }
    console.log(`[Meta Sync] Direct video fetch: found ${directFound}/${Math.min(uniqueMissing.length, 50)} source URLs`);
  }

  let videoMatchCount = 0;

  // 5. Update DB rows
  for (const upd of updates) {
    const videoUrl = videoSourceUrls.get(upd.video_id) || null;
    if (upd.video_id && videoUrl) videoMatchCount++;
    const finalThumb = upd.thumbnail_url;

    try {
      await pgQuery(
        `UPDATE creative_analysis
         SET thumbnail_url = $1, video_url = $2, meta_ad_id = $3, synced_at = NOW()
         WHERE ad_name = $4`,
        [finalThumb, videoUrl, upd.meta_ad_id, upd.ad_name]
      );
      matched++;
    } catch (err) {
      console.warn(`[Meta Sync] Update error for ${upd.ad_name}:`, err.message);
    }
  }

  console.log(`[Meta Sync] Matched and updated ${matched} creatives with thumbnails/videos (${videoMatchCount} got video URLs)`);
  return { matched, total: metaAds.length };
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
          thumbnail_url: row.thumbnail_url || null,
          video_url: row.video_url || null,
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
        // Keep best thumbnail/video
        if (row.thumbnail_url) grouped[cid].thumbnail_url = row.thumbnail_url;
        if (row.video_url) grouped[cid].video_url = row.video_url;
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

    // Check server-side cache to avoid repeated TW API calls
    const cacheKey = `${startDate}|${endDate}`;
    const cachedResult = dataByDateCache.get(cacheKey);
    if (cachedResult && (Date.now() - cachedResult.timestamp < DATA_CACHE_TTL)) {
      return res.json({ success: true, data: cachedResult.data });
    }

    const twAds = await fetchTripleWhaleAds(startDate, endDate);

    // Parse and aggregate by (creative_id, hook_id) — same pattern as syncData
    const hookAgg = new Map(); // key: "creative_id|hook_id"
    let skipped = 0;
    // Track unstructured/skipped ad totals for transparency
    let unstructuredSpend = 0, unstructuredRevenue = 0, unstructuredPurchases = 0;
    let unstructuredImpressions = 0, unstructuredClicks = 0;

    for (const ad of twAds) {
      const parsed = parseAdName(ad.ad_name);
      if (!parsed || !parsed.creative_id || !parsed.hook_id) {
        skipped++;
        unstructuredSpend += Number(ad.total_spend) || 0;
        unstructuredRevenue += Number(ad.total_revenue) || 0;
        unstructuredPurchases += Number(ad.total_purchases) || 0;
        unstructuredImpressions += Number(ad.total_impressions) || 0;
        unstructuredClicks += Number(ad.total_clicks) || 0;
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

    // Fetch lifetime metrics and thumbnails for all creative_ids
    const creativeIds = Object.keys(grouped);
    const lifetimeMap = await getLifetimeMetrics(creativeIds);

    // Look up thumbnails from DB for these creative_ids
    const thumbMap = new Map();
    if (creativeIds.length > 0) {
      try {
        const ph = creativeIds.map((_, i) => `$${i + 1}`).join(',');
        const thumbRows = await pgQuery(
          `SELECT DISTINCT ON (creative_id) creative_id, thumbnail_url, video_url
           FROM creative_analysis
           WHERE creative_id IN (${ph}) AND thumbnail_url IS NOT NULL
           ORDER BY creative_id, synced_at DESC NULLS LAST, spend DESC`,
          creativeIds
        );
        for (const r of thumbRows) thumbMap.set(r.creative_id, { thumbnail_url: r.thumbnail_url, video_url: r.video_url });
      } catch (err) { console.warn('[Creative] Thumbnail lookup error:', err.message); }
    }

    const creatives = Object.values(grouped).map(c => {
      const { _topSpend, ...rest } = c;
      const lt = lifetimeMap.get(c.creative_id) || {
        lifetime_spend: 0, lifetime_revenue: 0, lifetime_roas: 0,
        lifetime_purchases: 0, first_seen: null, last_seen: null,
        weeks_active: 0, is_winner: false,
      };
      const thumb = thumbMap.get(c.creative_id) || {};
      return {
        ...rest,
        thumbnail_url: thumb.thumbnail_url || null,
        video_url: thumb.video_url || null,
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

    const responseData = {
      creatives,
      dateRange: { startDate, endDate },
      meta: {
        total_ads: twAds.length,
        parsed: twAds.length - skipped,
        skipped,
        attributionModel: TW_ATTRIBUTION_MODEL,
        revenueColumn: twKnownRevCol || 'unknown',
        purchaseColumn: twKnownPurCol || 'unknown',
        unstructured: {
          count: skipped,
          spend: Math.round(unstructuredSpend * 100) / 100,
          revenue: Math.round(unstructuredRevenue * 100) / 100,
          purchases: unstructuredPurchases,
          ...computeMetrics({ spend: unstructuredSpend, revenue: unstructuredRevenue, purchases: unstructuredPurchases, impressions: unstructuredImpressions, clicks: unstructuredClicks }),
        },
      },
    };

    // Cache the result for subsequent requests
    dataByDateCache.set(cacheKey, { data: responseData, timestamp: Date.now() });
    // Evict old entries to prevent memory growth
    if (dataByDateCache.size > 50) {
      const oldest = [...dataByDateCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
      if (oldest) dataByDateCache.delete(oldest[0]);
    }

    res.json({ success: true, data: responseData });
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
        thumbnail_url: topRow.thumbnail_url || null,
        video_url: topRow.video_url || null,
        meta_ad_id: topRow.meta_ad_id || null,
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

    // Return cached response if fresh (avoids all DB queries on page refresh)
    const now = Date.now();
    if (activeCache.data && (now - activeCache.timestamp) < RESPONSE_CACHE_TTL) {
      return res.json(activeCache.data);
    }

    // Use cached latest week to avoid expensive SPLIT_PART sort on every request
    const latestWeek = await getLatestWeek();
    if (!latestWeek) {
      return res.json({ success: true, data: { creatives: [], latest_week: null } });
    }

    // Get active creatives (spend > 0 in latest week) with hook-level detail
    const activeRows = await pgQuery(
      `SELECT * FROM creative_analysis WHERE week = $1 AND spend > 0 ORDER BY spend DESC`,
      [latestWeek]
    );

    // Get lifetime metrics using the optimized helper (avoids N+1 subquery)
    const activeCreativeIds = [...new Set(activeRows.map(r => r.creative_id))];
    const lifetimeRows = activeCreativeIds.length > 0
      ? await getLifetimeMetrics(activeCreativeIds).then(m => [...m.entries()].map(([k, v]) => ({ creative_id: k, ...v })))
      : [];

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
          thumbnail_url: row.thumbnail_url || null,
          video_url: row.video_url || null,
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
        if (row.thumbnail_url) grouped[cid].thumbnail_url = row.thumbnail_url;
        if (row.video_url) grouped[cid].video_url = row.video_url;
      }
    }

    // Build lifetime map from pre-fetched data (already computed by getLifetimeMetrics)
    const lifetimeMap = new Map();
    for (const r of lifetimeRows) {
      lifetimeMap.set(r.creative_id, r);
    }

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

    const response = { success: true, data: { creatives, latest_week: latestWeek } };
    activeCache.data = response;
    activeCache.timestamp = Date.now();
    res.json(response);
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
    let { week } = req.query;

    await ensureTable();

    // Return cached response if fresh
    const cacheKey = (week || 'latest').toUpperCase();
    const cached = leaderboardCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < RESPONSE_CACHE_TTL) {
      return res.json(cached.data);
    }

    // Use cached latest week to avoid expensive SPLIT_PART sort
    if (!week || week.toLowerCase() === 'latest') {
      week = await getLatestWeek();
      if (!week) {
        return res.json({ success: true, data: { topRoas: [], topPurchases: [], topEfficiency: [] } });
      }
    }

    // Aggregate at creative_id level using a single pass with window functions
    // instead of LATERAL N+1 join (which fires a subquery per creative)
    const aggregated = await pgQuery(
      `WITH ranked AS (
         SELECT *,
           ROW_NUMBER() OVER (PARTITION BY creative_id ORDER BY spend DESC) as rn,
           SUM(spend) OVER (PARTITION BY creative_id) as total_spend,
           SUM(revenue) OVER (PARTITION BY creative_id) as total_revenue,
           SUM(purchases) OVER (PARTITION BY creative_id) as total_purchases,
           SUM(impressions) OVER (PARTITION BY creative_id) as total_impressions,
           SUM(clicks) OVER (PARTITION BY creative_id) as total_clicks
         FROM creative_analysis WHERE week = $1
       )
       SELECT
         creative_id,
         type, avatar, angle, format, editor, ad_name, thumbnail_url, video_url,
         total_spend as spend, total_revenue as revenue,
         total_purchases as purchases, total_impressions as impressions,
         total_clicks as clicks
       FROM ranked
       WHERE rn = 1 AND total_spend >= 200
       ORDER BY total_spend DESC`,
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
        thumbnail_url: row.thumbnail_url || null,
        video_url: row.video_url || null,
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

    const response = { success: true, data: { topRoas, topPurchases, topEfficiency } };
    leaderboardCache.set(cacheKey, { data: response, timestamp: Date.now() });
    res.json(response);
  } catch (err) {
    console.error('[Creative Analysis] /leaderboard error:', err);
    res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
});

/**
 * GET /build-velocity
 * Returns monthly counts of Net New (NN) vs Iteration (IT) creatives.
 * Parses NN/IT from ad_name and groups by the month of first appearance.
 */
const buildVelocityCache = { data: null, timestamp: 0 };
const BUILD_VELOCITY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

router.get('/build-velocity', authenticate, async (req, res) => {
  try {
    await ensureTable();

    // Return cached response if fresh
    if (buildVelocityCache.data && (Date.now() - buildVelocityCache.timestamp) < BUILD_VELOCITY_CACHE_TTL) {
      return res.json(buildVelocityCache.data);
    }

    // Get first appearance of each creative (earliest week) with an ad_name to parse NN/IT
    const rows = await pgQuery(`
      WITH first_week AS (
        SELECT creative_id,
          MIN(SPLIT_PART(week,'_',2)::int * 100 + REPLACE(SPLIT_PART(week,'_',1),'WK','')::int) as wk_key
        FROM creative_analysis
        WHERE week IS NOT NULL
        GROUP BY creative_id
      )
      SELECT DISTINCT ON (fw.creative_id)
        fw.creative_id, ca.ad_name, ca.week
      FROM first_week fw
      JOIN creative_analysis ca ON ca.creative_id = fw.creative_id
        AND (SPLIT_PART(ca.week,'_',2)::int * 100 + REPLACE(SPLIT_PART(ca.week,'_',1),'WK','')::int) = fw.wk_key
      ORDER BY fw.creative_id, ca.spend DESC
    `);

    // Parse NN/IT from each ad_name and group by month
    const monthlyData = {}; // key: "YYYY-MM" → { nn: count, it: count }

    for (const row of rows) {
      // Determine NN vs IT from ad_name
      const adName = row.ad_name || '';
      const segments = adName.includes(' - ')
        ? adName.split(' - ').map(s => s.trim())
        : adName.split('_').map(s => s.trim());

      const imLead = /^IM\d/i.test(segments[0] || '');
      const markerIdx = imLead ? 1 : 2;
      const marker = (segments[markerIdx] || '').toUpperCase();

      let buildType = 'other';
      if (marker === 'NN' || marker === 'NA') buildType = 'nn';
      else if (marker === 'IT') buildType = 'it';
      else {
        // Check if any segment is NN or IT (fallback for unusual formats)
        for (const seg of segments.slice(0, 5)) {
          if (/^NN$/i.test(seg)) { buildType = 'nn'; break; }
          if (/^IT$/i.test(seg)) { buildType = 'it'; break; }
        }
      }

      // Convert week code (WK08_2026) to month
      const weekCode = row.week || '';
      const weekMatch = weekCode.match(/^WK(\d+)_(\d{4})$/i);
      if (!weekMatch) continue;

      const weekNum = parseInt(weekMatch[1], 10);
      const year = parseInt(weekMatch[2], 10);

      // Convert ISO week number to approximate month
      // Week 1 starts around Jan 1, each week ~7 days
      const jan4 = new Date(Date.UTC(year, 0, 4));
      const dayOfWeek = jan4.getUTCDay() || 7;
      const mondayW1 = new Date(jan4);
      mondayW1.setUTCDate(jan4.getUTCDate() - dayOfWeek + 1);
      const weekStart = new Date(mondayW1);
      weekStart.setUTCDate(weekStart.getUTCDate() + (weekNum - 1) * 7);

      const monthKey = `${weekStart.getUTCFullYear()}-${String(weekStart.getUTCMonth() + 1).padStart(2, '0')}`;

      if (!monthlyData[monthKey]) {
        monthlyData[monthKey] = { month: monthKey, nn: 0, it: 0, total: 0 };
      }
      if (buildType === 'nn') monthlyData[monthKey].nn++;
      else if (buildType === 'it') monthlyData[monthKey].it++;
      monthlyData[monthKey].total++;
    }

    // Sort by month and return
    const result = Object.values(monthlyData).sort((a, b) => a.month.localeCompare(b.month));

    const response = { success: true, data: result };
    buildVelocityCache.data = response;
    buildVelocityCache.timestamp = Date.now();
    res.json(response);
  } catch (err) {
    console.error('[Creative Analysis] /build-velocity error:', err);
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

    // Clear data cache so next request gets fresh data
    dataByDateCache.clear(); creativeDailyCache.clear();
    latestWeekCache = { week: null, timestamp: 0 }; // invalidate latest week cache
    activeCache.data = null; activeCache.timestamp = 0; // invalidate active cache
    leaderboardCache.clear(); // invalidate leaderboard cache
    buildVelocityCache.data = null; buildVelocityCache.timestamp = 0; // invalidate build velocity cache

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
      dataByDateCache.clear(); creativeDailyCache.clear(); // Invalidate cached responses after sync
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

    // Generate past 12 weeks using ISO 8601 week numbers (matches getCurrentWeek)
    const weeks = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i * 7);
      const year = d.getUTCFullYear();
      const jan4 = new Date(Date.UTC(year, 0, 4));
      const dayOfWeek = jan4.getUTCDay() || 7;
      const mondayW1 = new Date(jan4);
      mondayW1.setUTCDate(jan4.getUTCDate() - dayOfWeek + 1);
      let weekNum = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - mondayW1.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1;
      let wkYear = year;
      if (weekNum < 1) {
        // Roll back to previous year's last ISO week
        const prevJan4 = new Date(Date.UTC(year - 1, 0, 4));
        const prevDow = prevJan4.getUTCDay() || 7;
        const prevMondayW1 = new Date(prevJan4);
        prevMondayW1.setUTCDate(prevJan4.getUTCDate() - prevDow + 1);
        weekNum = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - prevMondayW1.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1;
        wkYear = year - 1;
      }
      const wk = `WK${String(weekNum).padStart(2, '0')}_${wkYear}`;
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

/**
 * POST /sync-meta-thumbnails
 * Manually trigger Meta thumbnail/video sync across all ad accounts.
 */
router.post('/sync-meta-thumbnails', authenticate, async (req, res) => {
  try {
    const result = await syncMetaThumbnails();
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[Creative Analysis] /sync-meta-thumbnails error:', err);
    res.status(500).json({ success: false, error: { message: 'Meta thumbnail sync failed' } });
  }
});

// Start auto-sync after 30s delay, then every 5 minutes
// Also trigger one-time history backfill + meta thumbnails
setTimeout(() => {
  autoSync();
  backfillHistory();
  syncMetaThumbnails().catch(err => console.warn('[Meta Sync] Auto-sync error:', err.message));
  setInterval(autoSync, 5 * 60 * 1000);
  // Sync Meta thumbnails every 30 minutes
  setInterval(() => syncMetaThumbnails().catch(() => {}), 30 * 60 * 1000);
}, 30_000);

/**
 * GET /creative-daily?creative_id=B0066&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 * Returns daily performance data for a specific creative_id by querying
 * Triple Whale with daily granularity, filtered to ads matching the creative.
 */
router.get('/creative-daily', authenticate, async (req, res) => {
  try {
    const { creative_id, startDate, endDate } = req.query;
    if (!creative_id) {
      return res.status(400).json({ success: false, error: { message: 'creative_id query param is required' } });
    }
    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, error: { message: 'startDate and endDate query params are required (YYYY-MM-DD)' } });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      return res.status(400).json({ success: false, error: { message: 'Dates must be in YYYY-MM-DD format' } });
    }

    if (!TW_API_KEY) {
      return res.status(500).json({ success: false, error: { message: 'Triple Whale API key not configured' } });
    }

    // Check server-side cache
    const dailyCacheKey = `${creative_id}|${startDate}|${endDate}`;
    const cachedDaily = creativeDailyCache.get(dailyCacheKey);
    if (cachedDaily && (Date.now() - cachedDaily.timestamp < CREATIVE_DAILY_CACHE_TTL)) {
      return res.json({ success: true, data: cachedDaily.data });
    }

    // Revenue & purchase columns — use configured columns first, then fallbacks
    const revenueColumns = [...new Set([TW_REVENUE_COL, 'order_revenue', 'channel_reported_conversion_value'])];
    const purchaseColumns = [...new Set([TW_PURCHASE_COL, 'website_purchases', 'channel_reported_conversions'])];

    async function twQuery(sql) {
      const r = await fetch(TW_SQL_URL, {
        method: 'POST',
        headers: { 'x-api-key': TW_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopId: TW_SHOP_ID, query: sql.trim(), period: { startDate, endDate }, attributionModel: TW_ATTRIBUTION_MODEL }),
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) {
        const text = await r.text();
        if (r.status === 401 || r.status === 403 || r.status >= 500) return { ok: false, fatal: true };
        return { ok: false, fatal: false, errorText: text.slice(0, 100) };
      }
      const data = await r.json();
      const rows = Array.isArray(data) ? data : (data?.data || data?.rows || []);
      return { ok: true, rows };
    }

    function buildDailySql(revCol, purCol) {
      const revRef = revCol.includes(' ') ? `\`${revCol}\`` : revCol;
      const purPart = purCol ? `, SUM(${purCol.includes(' ') ? `\`${purCol}\`` : purCol}) as total_purchases` : '';
      return `
        SELECT event_date, ad_name, SUM(spend) as total_spend, SUM(${revRef}) as total_revenue${purPart},
               SUM(impressions) as total_impressions, SUM(clicks) as total_clicks
        FROM pixel_joined_tvf
        WHERE event_date BETWEEN @startDate AND @endDate
        GROUP BY event_date, ad_name
        HAVING SUM(spend) > 0.01
        ORDER BY event_date ASC
        LIMIT 5000
      `;
    }

    // Try cached column combo first (skip discovery loop on repeat calls)
    let dailyRows = [];
    let foundRevCol = null;
    let foundPurCol = null;

    if (twKnownRevCol) {
      const sql = buildDailySql(twKnownRevCol, twKnownPurCol);
      const result = await twQuery(sql);
      if (result.ok) {
        dailyRows = result.rows;
        foundRevCol = twKnownRevCol;
        foundPurCol = twKnownPurCol;
      }
      // If cached combo fails, fall through to full discovery
    }

    if (!foundRevCol) {
      for (const revenueCol of revenueColumns) {
        for (const purchaseCol of purchaseColumns) {
          const sql = buildDailySql(revenueCol, purchaseCol);
          const result = await twQuery(sql);
          if (result.fatal) {
            return res.status(502).json({ success: false, error: { message: 'Triple Whale API error' } });
          }
          if (result.ok) {
            dailyRows = result.rows;
            foundRevCol = revenueCol;
            foundPurCol = purchaseCol;
            break;
          }
        }
        if (foundRevCol) break;

        // Try revenue-only (no purchases)
        const sql = buildDailySql(revenueCol, null);
        const revResult = await twQuery(sql);
        if (revResult.fatal) {
          return res.status(502).json({ success: false, error: { message: 'Triple Whale API error' } });
        }
        if (revResult.ok) {
          dailyRows = revResult.rows;
          foundRevCol = revenueCol;
          break;
        }
      }
    }

    if (!foundRevCol) {
      return res.status(502).json({ success: false, error: { message: 'Could not query Triple Whale (all column variants failed)' } });
    }

    // Cache working columns for future requests
    twKnownRevCol = foundRevCol;
    twKnownPurCol = foundPurCol;

    // Filter rows to only those matching the creative_id
    const cid = creative_id.toUpperCase();
    const matchingRows = dailyRows.filter(row => {
      const parsed = parseAdName(row.ad_name);
      return parsed && parsed.creative_id && parsed.creative_id.toUpperCase() === cid;
    });

    // Aggregate by date
    const dateMap = {};
    let totalSpend = 0, totalRevenue = 0, totalPurchases = 0, totalImpressions = 0, totalClicks = 0;

    for (const row of matchingRows) {
      const date = (row.event_date || '').slice(0, 10);
      if (!date) continue;

      const spend = Number(row.total_spend) || 0;
      const revenue = Number(row.total_revenue) || 0;
      const purchases = Number(row.total_purchases) || 0;
      const impressions = Number(row.total_impressions) || 0;
      const clicks = Number(row.total_clicks) || 0;

      totalSpend += spend;
      totalRevenue += revenue;
      totalPurchases += purchases;
      totalImpressions += impressions;
      totalClicks += clicks;

      if (!dateMap[date]) {
        dateMap[date] = { date, spend: 0, revenue: 0, purchases: 0, impressions: 0, clicks: 0 };
      }
      dateMap[date].spend += spend;
      dateMap[date].revenue += revenue;
      dateMap[date].purchases += purchases;
      dateMap[date].impressions += impressions;
      dateMap[date].clicks += clicks;
    }

    const daily = Object.values(dateMap)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(d => ({
        date: d.date,
        spend: Math.round(d.spend * 100) / 100,
        revenue: Math.round(d.revenue * 100) / 100,
        purchases: d.purchases,
        impressions: d.impressions,
        clicks: d.clicks,
      }));

    const aggSpend = Math.round(totalSpend * 100) / 100;
    const aggRevenue = Math.round(totalRevenue * 100) / 100;

    const responseData = {
      creative_id: cid,
      daily,
      totals: {
        total_spend: aggSpend,
        total_revenue: aggRevenue,
        total_purchases: totalPurchases,
        total_impressions: totalImpressions,
        total_clicks: totalClicks,
        roas: aggSpend > 0 ? Math.round((aggRevenue / aggSpend) * 100) / 100 : 0,
        cpa: totalPurchases > 0 ? Math.round((aggSpend / totalPurchases) * 100) / 100 : 0,
        ctr: totalImpressions > 0 ? Math.round(((totalClicks / totalImpressions) * 100) * 100) / 100 : 0,
        cpm: totalImpressions > 0 ? Math.round((aggSpend / totalImpressions * 1000) * 100) / 100 : 0,
      },
      dateRange: { startDate, endDate },
    };

    // Cache for subsequent requests
    creativeDailyCache.set(dailyCacheKey, { data: responseData, timestamp: Date.now() });
    if (creativeDailyCache.size > 100) {
      const oldest = [...creativeDailyCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
      if (oldest) creativeDailyCache.delete(oldest[0]);
    }

    res.json({ success: true, data: responseData });
  } catch (err) {
    console.error('[Creative Analysis] /creative-daily error:', err);
    res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
});

// ── Meta Insights Cache Table ─────────────────────────────────────

async function ensureMetaInsightsTable() {
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS creative_meta_insights (
      id SERIAL PRIMARY KEY,
      meta_ad_id TEXT NOT NULL UNIQUE,
      creative_id TEXT,
      impressions BIGINT DEFAULT 0,
      reach BIGINT DEFAULT 0,
      clicks BIGINT DEFAULT 0,
      ctr NUMERIC(8,4) DEFAULT 0,
      cpc NUMERIC(10,2) DEFAULT 0,
      cpm NUMERIC(10,2) DEFAULT 0,
      frequency NUMERIC(8,2) DEFAULT 0,
      meta_spend NUMERIC(12,2) DEFAULT 0,
      reactions_like INTEGER DEFAULT 0,
      reactions_love INTEGER DEFAULT 0,
      reactions_care INTEGER DEFAULT 0,
      reactions_haha INTEGER DEFAULT 0,
      reactions_wow INTEGER DEFAULT 0,
      reactions_sad INTEGER DEFAULT 0,
      reactions_angry INTEGER DEFAULT 0,
      total_reactions INTEGER DEFAULT 0,
      post_clicks INTEGER DEFAULT 0,
      comments INTEGER DEFAULT 0,
      shares INTEGER DEFAULT 0,
      video_views INTEGER DEFAULT 0,
      video_3s_views INTEGER DEFAULT 0,
      video_30s_views INTEGER DEFAULT 0,
      video_avg_time NUMERIC(10,2) DEFAULT 0,
      video_p25 INTEGER DEFAULT 0,
      video_p50 INTEGER DEFAULT 0,
      video_p75 INTEGER DEFAULT 0,
      video_p95 INTEGER DEFAULT 0,
      video_p100 INTEGER DEFAULT 0,
      hook_rate NUMERIC(8,4) DEFAULT 0,
      hold_rate NUMERIC(8,4) DEFAULT 0,
      fetched_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// ── Meta Insights Fetch & Cache ──────────────────────────────────

const META_INSIGHTS_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

let metaInsightsTableReady = false;
async function fetchMetaInsights(metaAdId) {
  if (!META_ACCESS_TOKEN || !metaAdId) return null;
  if (!metaInsightsTableReady) {
    try { await ensureMetaInsightsTable(); metaInsightsTableReady = true; }
    catch (e) { console.warn('[Meta Insights] Table creation failed:', e.message); return null; }
  }

  // Check cache
  try {
    const cached = await pgQuery(
      `SELECT * FROM creative_meta_insights WHERE meta_ad_id = $1 AND fetched_at > NOW() - INTERVAL '4 hours'`,
      [metaAdId]
    );
    if (cached.length) return cached[0];
  } catch (cacheErr) {
    console.warn('[Meta Insights] Cache lookup failed:', cacheErr.message);
    // Continue to fetch from Meta API directly
  }

  // Fetch from Meta
  try {
    const fields = [
      'impressions', 'reach', 'clicks', 'ctr', 'cpc', 'cpm', 'frequency', 'spend',
      'actions', 'video_avg_time_watched_actions',
      'video_p25_watched_actions', 'video_p50_watched_actions',
      'video_p75_watched_actions', 'video_p95_watched_actions',
      'video_p100_watched_actions', 'video_30_sec_watched_actions',
      'video_play_actions',
    ].join(',');

    const url = `${META_GRAPH_URL}/${encodeURIComponent(metaAdId)}/insights?fields=${fields}&date_preset=maximum&action_breakdowns=action_reaction&access_token=${META_ACCESS_TOKEN}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) {
      const errText = await res.text();
      console.warn(`[Meta Insights] Failed for ${metaAdId}: ${res.status} ${errText.replace(META_ACCESS_TOKEN, '[REDACTED]').slice(0, 200)}`);
      return null;
    }

    const json = await res.json();
    const d = json.data?.[0] || {};

    // Parse actions array
    const actions = Array.isArray(d.actions) ? d.actions : [];
    const getAction = (type) => {
      const a = actions.find(a => a.action_type === type);
      return parseInt(a?.value || '0', 10);
    };

    // Parse video watched actions (they come as arrays of objects)
    const getVideoAction = (arr) => {
      if (!Array.isArray(arr)) return 0;
      return arr.reduce((sum, item) => sum + (parseInt(item?.value || '0', 10)), 0);
    };

    const impressions = parseInt(d.impressions || '0', 10);
    const reach = parseInt(d.reach || '0', 10);
    const clicks = parseInt(d.clicks || '0', 10);
    const ctr = parseFloat(d.ctr || '0');
    const cpc = parseFloat(d.cpc || '0');
    const cpm = parseFloat(d.cpm || '0');
    const frequency = parseFloat(d.frequency || '0');
    const metaSpend = parseFloat(d.spend || '0');

    // Engagement — parse reaction breakdowns (action_breakdowns=action_reaction)
    const getReaction = (reactionType) => {
      const a = actions.find(a => a.action_type === 'post_reaction' && a.action_reaction === reactionType);
      return parseInt(a?.value || '0', 10);
    };
    const reactionsLike = getReaction('like');
    const reactionsLove = getReaction('love');
    const reactionsCare = getReaction('care');
    const reactionsHaha = getReaction('haha');
    const reactionsWow = getReaction('wow');
    const reactionsSad = getReaction('sad');
    const reactionsAngry = getReaction('angry');
    const postReaction = getAction('post_reaction');
    const totalReactions = postReaction || (reactionsLike + reactionsLove + reactionsCare + reactionsHaha + reactionsWow + reactionsSad + reactionsAngry);
    const postClicks = getAction('link_click');
    const commentsCount = getAction('comment');
    const sharesCount = getAction('post');

    // Video metrics
    const videoViews = getVideoAction(d.video_play_actions);
    const video3s = getAction('video_view');
    const video30s = getVideoAction(d.video_30_sec_watched_actions);
    const videoAvgTimeArr = Array.isArray(d.video_avg_time_watched_actions) ? d.video_avg_time_watched_actions : [];
    const videoAvgTime = parseFloat(videoAvgTimeArr[0]?.value || '0');
    const videoP25 = getVideoAction(d.video_p25_watched_actions);
    const videoP50 = getVideoAction(d.video_p50_watched_actions);
    const videoP75 = getVideoAction(d.video_p75_watched_actions);
    const videoP95 = getVideoAction(d.video_p95_watched_actions);
    const videoP100 = getVideoAction(d.video_p100_watched_actions);

    // Computed rates
    const hookRate = impressions > 0 ? (video3s || videoViews) / impressions : 0;
    const holdRate = (video3s || videoViews) > 0 ? videoP100 / (video3s || videoViews) : 0;

    // Upsert cache
    const row = {
      meta_ad_id: metaAdId,
      impressions, reach, clicks, ctr, cpc, cpm, frequency, meta_spend: metaSpend,
      reactions_like: reactionsLike, reactions_love: reactionsLove, reactions_care: reactionsCare,
      reactions_haha: reactionsHaha, reactions_wow: reactionsWow, reactions_sad: reactionsSad,
      reactions_angry: reactionsAngry, total_reactions: totalReactions,
      post_clicks: postClicks, comments: commentsCount, shares: sharesCount,
      video_views: videoViews, video_3s_views: video3s || videoViews, video_30s_views: video30s,
      video_avg_time: videoAvgTime, video_p25: videoP25, video_p50: videoP50,
      video_p75: videoP75, video_p95: videoP95, video_p100: videoP100,
      hook_rate: hookRate, hold_rate: holdRate,
    };

    await pgQuery(`
      INSERT INTO creative_meta_insights (
        meta_ad_id, impressions, reach, clicks, ctr, cpc, cpm, frequency, meta_spend,
        reactions_like, reactions_love, reactions_care, reactions_haha, reactions_wow, reactions_sad, reactions_angry,
        total_reactions, post_clicks, comments, shares,
        video_views, video_3s_views, video_30s_views, video_avg_time,
        video_p25, video_p50, video_p75, video_p95, video_p100,
        hook_rate, hold_rate, fetched_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,NOW())
      ON CONFLICT (meta_ad_id) DO UPDATE SET
        impressions=$2, reach=$3, clicks=$4, ctr=$5, cpc=$6, cpm=$7, frequency=$8, meta_spend=$9,
        reactions_like=$10, reactions_love=$11, reactions_care=$12, reactions_haha=$13, reactions_wow=$14, reactions_sad=$15, reactions_angry=$16,
        total_reactions=$17, post_clicks=$18, comments=$19, shares=$20,
        video_views=$21, video_3s_views=$22, video_30s_views=$23, video_avg_time=$24,
        video_p25=$25, video_p50=$26, video_p75=$27, video_p95=$28, video_p100=$29,
        hook_rate=$30, hold_rate=$31, fetched_at=NOW()
    `, [
      metaAdId, impressions, reach, clicks, ctr, cpc, cpm, frequency, metaSpend,
      reactionsLike, reactionsLove, reactionsCare, reactionsHaha, reactionsWow, reactionsSad, reactionsAngry,
      totalReactions, postClicks, commentsCount, sharesCount,
      videoViews, video3s || videoViews, video30s, videoAvgTime,
      videoP25, videoP50, videoP75, videoP95, videoP100,
      hookRate, holdRate,
    ]);

    return row;
  } catch (err) {
    console.error(`[Meta Insights] Error fetching for ${metaAdId}:`, err.message);
    return null;
  }
}

// ── Meta Insights Endpoints ──────────────────────────────────────

/**
 * GET /meta-insights/:adId
 * Fetch engagement + video metrics for a specific Meta ad (cached 4hr)
 */
router.get('/meta-insights/:adId', authenticate, async (req, res) => {
  try {
    if (!META_ACCESS_TOKEN) {
      return res.status(503).json({ success: false, error: { message: 'Meta API not configured' } });
    }
    const adId = req.params.adId;
    if (!/^\d+$/.test(adId)) {
      return res.status(400).json({ success: false, error: { message: 'Invalid ad ID format' } });
    }
    const insights = await fetchMetaInsights(adId);
    if (!insights) {
      return res.status(404).json({ success: false, error: { message: 'Could not fetch Meta insights for this ad' } });
    }
    res.json({ success: true, data: insights });
  } catch (err) {
    console.error('[Creative Analysis] /meta-insights error:', err);
    res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
});

/**
 * GET /meta-insights/:adId/daily?startDate=&endDate=
 * Fetch daily Meta insights for ROAS/Spend chart
 */
router.get('/meta-insights/:adId/daily', authenticate, async (req, res) => {
  try {
    if (!META_ACCESS_TOKEN) {
      return res.status(503).json({ success: false, error: { message: 'Meta API not configured' } });
    }

    const { startDate, endDate } = req.query;
    const adId = req.params.adId;
    if (!/^\d+$/.test(adId)) {
      return res.status(400).json({ success: false, error: { message: 'Invalid ad ID format' } });
    }

    // Validate date format to prevent URL injection
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    const end = endDate && dateRegex.test(endDate) ? endDate : new Date().toISOString().slice(0, 10);
    const start = startDate && dateRegex.test(startDate) ? startDate : (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10); })();

    const url = `${META_GRAPH_URL}/${encodeURIComponent(adId)}/insights?fields=spend,impressions,clicks,actions&time_increment=1&time_range={"since":"${start}","until":"${end}"}&limit=500&access_token=${META_ACCESS_TOKEN}`;
    const apiRes = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!apiRes.ok) {
      const errText = await apiRes.text();
      // Sanitize error text to prevent token leakage
      const safeErr = errText.replace(META_ACCESS_TOKEN, '[REDACTED]').slice(0, 200);
      return res.status(apiRes.status === 400 ? 400 : 502).json({
        success: false, error: { message: `Meta API error: ${safeErr}` }
      });
    }

    const json = await apiRes.json();
    const rows = json.data || [];

    const daily = rows.map(d => {
      const actions = Array.isArray(d.actions) ? d.actions : [];
      const purchaseAction = actions.find(a =>
        a.action_type === 'offsite_conversion.fb_pixel_purchase' ||
        a.action_type === 'purchase' ||
        a.action_type === 'omni_purchase'
      );
      const revenue = parseFloat(purchaseAction?.value || '0');
      const spend = parseFloat(d.spend || '0');
      return {
        date: d.date_start,
        spend,
        revenue,
        roas: spend > 0 ? Math.round((revenue / spend) * 100) / 100 : 0,
        impressions: parseInt(d.impressions || '0', 10),
        clicks: parseInt(d.clicks || '0', 10),
      };
    });

    res.json({ success: true, data: daily });
  } catch (err) {
    console.error('[Creative Analysis] /meta-insights/:adId/daily error:', err);
    res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
});

/**
 * GET /meta-lookup/:creativeId
 * Find meta_ad_id for a creative, searching Meta API if not cached
 */
router.get('/meta-lookup/:creativeId', authenticate, async (req, res) => {
  try {
    const { creativeId } = req.params;
    if (!/^[A-Za-z0-9_-]+$/.test(creativeId)) {
      return res.status(400).json({ success: false, error: { message: 'Invalid creative ID format' } });
    }

    const forceVideo = req.query.force_video === '1';

    // Check DB first — return cached data if meta_ad_id exists
    const existing = await pgQuery(
      `SELECT meta_ad_id, thumbnail_url, video_url, type, synced_at
       FROM creative_analysis WHERE creative_id = $1 AND meta_ad_id IS NOT NULL
       ORDER BY video_url DESC NULLS LAST LIMIT 1`,
      [creativeId]
    );
    const cached = existing.length ? existing[0] : null;
    const isVideoCached = cached && (cached.type || '').toLowerCase() === 'video';

    // Video URLs expire (Meta CDN signed URLs) — re-fetch if:
    //   - video_url is null, OR
    //   - force_video requested (frontend retry after playback error), OR
    //   - synced_at is older than 2 hours
    const VIDEO_URL_TTL = 2 * 60 * 60 * 1000; // 2 hours
    const urlIsStale = cached?.synced_at && (Date.now() - new Date(cached.synced_at).getTime() > VIDEO_URL_TTL);
    const needsFreshUrl = isVideoCached && (!cached.video_url || forceVideo || urlIsStale);

    // Fast path: have meta_ad_id, just need a fresh video URL
    if (cached && cached.meta_ad_id && needsFreshUrl && META_ACCESS_TOKEN && META_AD_ACCOUNT_IDS.length) {
      try {
        // Get video_id from the ad object (Marketing API token works for ad objects)
        // Fetch ad creative with all useful video fields
        const adRes = await fetch(
          `${META_GRAPH_URL}/${cached.meta_ad_id}?fields=creative{video_id,thumbnail_url,object_story_spec,effective_object_story_id}&access_token=${META_ACCESS_TOKEN}`,
          { signal: AbortSignal.timeout(10000) }
        );
        if (adRes.ok) {
          const adData = await adRes.json();
          const videoId = adData.creative?.video_id;
          const creative = adData.creative || {};
          console.log(`[Meta Lookup] ad ${cached.meta_ad_id} -> video_id: ${videoId}, creative keys: ${JSON.stringify(Object.keys(creative))}`);
          if (videoId) {
            let freshUrl = null;

            // Strategy 1: check object_story_spec for video_data.url or video_data.video_id
            const videoData = creative.object_story_spec?.video_data;
            if (videoData) {
              console.log(`[Meta Lookup] video_data keys: ${JSON.stringify(Object.keys(videoData))}`);
              // video_data sometimes has a direct video URL or image_url
              if (videoData.video_url) freshUrl = videoData.video_url;
            }

            // Strategy 2: try direct /{video_id}?fields=source,permalink_url
            if (!freshUrl) {
              try {
                const directRes = await fetch(
                  `${META_GRAPH_URL}/${videoId}?fields=source,permalink_url&access_token=${META_ACCESS_TOKEN}`,
                  { signal: AbortSignal.timeout(8000) }
                );
                if (directRes.ok) {
                  const directBody = await directRes.json();
                  console.log(`[Meta Lookup] Direct /${videoId} keys: ${JSON.stringify(Object.keys(directBody))}`);
                  if (directBody.source) freshUrl = directBody.source;
                  // Note: permalink_url (/reel/...) can't be used as <video> src — needs mp4
                }
              } catch (e) { /* try next strategy */ }
            }

            // Strategy 3: try effective_object_story_id to get video from post
            if (!freshUrl) {
              const storyId = creative.effective_object_story_id;
              if (storyId) {
                try {
                  const postRes = await fetch(
                    `${META_GRAPH_URL}/${storyId}?fields=attachments{media{source}},source&access_token=${META_ACCESS_TOKEN}`,
                    { signal: AbortSignal.timeout(8000) }
                  );
                  if (postRes.ok) {
                    const postData = await postRes.json();
                    console.log(`[Meta Lookup] Story ${storyId} keys: ${JSON.stringify(Object.keys(postData))}`);
                    const mediaSource = postData.attachments?.data?.[0]?.media?.source || postData.source;
                    if (mediaSource) freshUrl = mediaSource;
                  }
                } catch (e) { /* try next strategy */ }
              }
            }

            // Strategy 4: try advideos bulk list on each account
            if (!freshUrl) {
              for (const accountId of META_AD_ACCOUNT_IDS) {
                try {
                  let pgUrl = `${META_GRAPH_URL}/${accountId}/advideos?fields=id,source&limit=100&access_token=${META_ACCESS_TOKEN}`;
                  let pages = 0;
                  while (pgUrl && pages < 5 && !freshUrl) {
                    const vidRes = await fetch(pgUrl, { signal: AbortSignal.timeout(10000) });
                    if (!vidRes.ok) break;
                    const vidData = await vidRes.json();
                    if (vidData.error) break;
                    for (const v of (vidData.data || [])) {
                      if (v.id === videoId && v.source) { freshUrl = v.source; break; }
                    }
                    pgUrl = vidData.paging?.next || null;
                    pages++;
                  }
                  if (freshUrl) break;
                } catch (e) { /* try next account */ }
              }
            }

            if (freshUrl) {
              console.log(`[Meta Lookup] Got fresh video URL for ${creativeId}`);
              await pgQuery(
                `UPDATE creative_analysis SET video_url = $1, synced_at = NOW() WHERE creative_id = $2`,
                [freshUrl, creativeId]
              );
              return res.json({
                success: true,
                data: {
                  meta_ad_id: cached.meta_ad_id,
                  thumbnail_url: adData.creative?.thumbnail_url || cached.thumbnail_url,
                  video_url: freshUrl,
                },
              });
            }
            console.warn(`[Meta Lookup] Could not resolve video source for video_id ${videoId}`);
          }
        }
      } catch (e) {
        console.warn('[Meta Lookup] Fast video refresh failed:', e.message);
      }
      // Fast refresh failed — return cached data with stale URL (better than nothing)
      return res.json({ success: true, data: cached });
    }

    if (cached && cached.meta_ad_id && !needsFreshUrl) {
      return res.json({ success: true, data: cached });
    }

    // Search Meta API
    if (!META_ACCESS_TOKEN || !META_AD_ACCOUNT_IDS.length) {
      return res.json({ success: true, data: cached || null, message: 'No Meta API configured or ad not linked' });
    }

    // Search all ad accounts in parallel for faster lookup
    const searchResults = await Promise.allSettled(
      META_AD_ACCOUNT_IDS.slice(0, 5).map(async (accountId) => {
        const searchUrl = `${META_GRAPH_URL}/${accountId}/ads?filtering=[{"field":"name","operator":"CONTAIN","value":"${encodeURIComponent(creativeId)}"}]&fields=id,name,creative{thumbnail_url,video_id,effective_object_story_id}&limit=10&access_token=${META_ACCESS_TOKEN}`;
        const apiRes = await fetch(searchUrl, { signal: AbortSignal.timeout(15000) });
        if (!apiRes.ok) return null;
        const json = await apiRes.json();
        const ads = json.data || [];
        return ads.length ? { ad: ads[0], accountId } : null;
      })
    );

    // Use the first successful match
    const match = searchResults
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value)[0];

    if (match) {
      const { ad, accountId: matchedAccountId } = match;
      const metaAdId = ad.id;
      const thumbnailUrl = ad.creative?.thumbnail_url || null;

      // Get video source if video_id exists
      let videoUrl = null;
      if (ad.creative?.video_id) {
        const vid = ad.creative.video_id;
        // Strategy 1: direct /{video_id}?fields=source
        try {
          const directRes = await fetch(
            `${META_GRAPH_URL}/${vid}?fields=source,permalink_url&access_token=${META_ACCESS_TOKEN}`,
            { signal: AbortSignal.timeout(8000) }
          );
          if (directRes.ok) {
            const directData = await directRes.json();
            if (directData.source) videoUrl = directData.source;
          }
        } catch (e) { /* try next */ }
        // Strategy 2: get video from ad's story post
        if (!videoUrl) {
          try {
            const storyId = ad.creative?.effective_object_story_id;
            if (storyId) {
              const postRes = await fetch(
                `${META_GRAPH_URL}/${storyId}?fields=attachments{media{source}}&access_token=${META_ACCESS_TOKEN}`,
                { signal: AbortSignal.timeout(8000) }
              );
              if (postRes.ok) {
                const postData = await postRes.json();
                const mediaSource = postData.attachments?.data?.[0]?.media?.source;
                if (mediaSource) videoUrl = mediaSource;
              }
            }
          } catch (e) { /* skip */ }
        }
      }

      // Update DB — always overwrite video_url since Meta URLs expire
      await pgQuery(
        `UPDATE creative_analysis SET meta_ad_id = $1, thumbnail_url = COALESCE($2, thumbnail_url), video_url = $3, synced_at = NOW() WHERE creative_id = $4`,
        [metaAdId, thumbnailUrl, videoUrl, creativeId]
      );

      return res.json({ success: true, data: { meta_ad_id: metaAdId, thumbnail_url: thumbnailUrl, video_url: videoUrl } });
    }

    return res.json({ success: true, data: cached || null, message: 'No matching Meta ad found' });
  } catch (err) {
    console.error('[Creative Analysis] /meta-lookup error:', err);
    res.status(500).json({ success: false, error: { message: 'Internal server error' } });
  }
});

// ── Exported helpers for cross-module use ──────────────────────────

/**
 * Fetch daily ad spend totals from Triple Whale for a date range.
 * Returns array of { date: 'YYYY-MM-DD', spend: Number }
 */
export async function fetchDailyAdSpend(startDate, endDate) {
  if (!TW_API_KEY) return [];
  try {
    const res = await fetch(TW_SQL_URL, {
      method: 'POST',
      headers: { 'x-api-key': TW_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopId: TW_SHOP_ID,
        query: `SELECT event_date, SUM(spend) as total_spend FROM pixel_joined_tvf WHERE event_date BETWEEN @startDate AND @endDate GROUP BY event_date ORDER BY event_date`,
        period: { startDate, endDate },
        attributionModel: TW_ATTRIBUTION_MODEL,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const rows = Array.isArray(data) ? data : (data?.data || data?.rows || []);
    return rows.map(r => ({
      date: (r.event_date || '').slice(0, 10),
      spend: parseFloat(r.total_spend || 0),
    }));
  } catch (err) {
    console.error('[TW] fetchDailyAdSpend error:', err.message);
    return [];
  }
}

export default router;
