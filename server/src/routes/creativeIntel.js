import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { pgQuery } from '../db/pg.js';
import { getEditors } from '../utils/clickupEditors.js';

const router = Router();
router.use(authenticate, requirePermission('creative-intelligence', 'access'));

// ── Config ──────────────────────────────────────────────────────────
const CLICKUP_TOKEN  = process.env.CLICKUP_API_TOKEN  || '';
const TW_API_KEY     = process.env.TRIPLEWHALE_API_KEY || '';
const TW_SHOP_ID     = process.env.TRIPLEWHALE_SHOP_ID || '17cca0-2.myshopify.com';
const CLICKUP_BASE   = 'https://api.clickup.com/api/v2';
const TW_SQL_URL     = 'https://api.triplewhale.com/api/v2/orcabase/api/sql';

const VIDEO_LIST_ID  = '901518716584';
const STATIC_LIST_ID = '901518769479';

// ClickUp custom field ID for Frame link
const FRAME_LINK_FIELD_ID = 'd90f9f25-d7a0-4eb4-9ded-aca0b4519a3b';

// Editor user IDs are now fetched dynamically from ClickUp list members (see utils/clickupEditors.js).

// Known formats & angles for classification
const KNOWN_FORMATS = ['mashup', 'mashups', 'shortvid', 'short vid', 'shortvideo', 'mini vsl', 'img'];
const KNOWN_ANGLES  = [
  'lottery', 'againstcompetition', 'against competition', 'against competitors',
  'gtrs', 'gt3', 'btc made easy', 'founderstory', 'founder story',
  'hiddenopportunity', 'hidden opportunity', 'missedopportunity', 'missed opportunity',
  'btcfarm', 'btc farm', 'moneyopportunity', 'money opportunity',
  'offer', 'retargeting', 'reaction', 'sharktank', 'shark tank',
  'lambo', 'mclaren', 'scarcity', 'comparison',
];

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Parse the ClickUp naming convention.
 * Supports both new format (` - ` separator) and old format (` _ ` separator).
 * Last segment = week (WKxx_YYYY), second-to-last = editor.
 * Scans remaining segments for known format and angle.
 */
function parseTaskName(name) {
  // Detect separator: if name has ` - ` use that, else try ` _ ` or just `_`
  let segments;
  if (name.includes(' - ')) {
    segments = name.split(/\s*-\s*/).map(s => s.trim()).filter(Boolean);
  } else {
    segments = name.split(/\s*_\s*/).map(s => s.trim()).filter(Boolean);
  }

  // Remove .mp4 from last segment
  if (segments.length > 0) {
    segments[segments.length - 1] = segments[segments.length - 1].replace(/\.mp4$/i, '');
  }

  // Extract week (last segment matching WKxx_YYYY)
  let week = null;
  let weekIdx = -1;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (/^WK\d+[_\s]\d{4}$/i.test(segments[i])) {
      week = segments[i].toUpperCase().replace(/\s/, '_');
      weekIdx = i;
      break;
    }
  }

  // Editor is the segment right before the week
  let editor = null;
  if (weekIdx > 0) {
    const candidate = segments[weekIdx - 1].trim();
    if (candidate && candidate.toUpperCase() !== 'NA' && candidate.length > 1) {
      editor = candidate;
    }
    // Sometimes there's an extra NA gap — look one more back
    if (!editor && weekIdx > 1) {
      const c2 = segments[weekIdx - 2].trim();
      if (c2 && c2.toUpperCase() !== 'NA' && c2.length > 1) {
        editor = c2;
      }
    }
  }
  // For old format without WK, try to find editor from known positions
  // Old format: MR Miner _ B041 _ HX _ IT _ B011 _ Angle _ Avatar _ Format _ Person1 _ Person2
  // Editor is typically near the end
  if (!editor && !week && segments.length >= 3) {
    // Try last segment as editor
    const last = segments[segments.length - 1].trim();
    if (last && last.toUpperCase() !== 'NA' && last.length > 1 && !/^(MR|B\d|IM\d|HX|H\d|IT|NN)/i.test(last)) {
      editor = last;
    }
  }

  // Normalize editor name
  if (editor) {
    editor = editor.charAt(0).toUpperCase() + editor.slice(1).toLowerCase();
    const editorMap = {
      'ludovico': 'Ludovico', 'ludo': 'Ludovico',
      'uly': 'Uly', 'dimaranan': 'Dimaranan', 'fazlul': 'Fazlul',
      'muhammad': 'Muhammad', 'mohammad': 'Muhammad', 'mohammed': 'Muhammad',
      'atif': 'Atif', 'ali': 'Ali', 'hamza': 'Hamza',
      'usama': 'Usama', 'carl': 'Carl', 'alhamjatonni': 'Alhamjatonni',
      'abdul': 'Abdul', 'robi': 'Robi', 'abdullah': 'Abdullah', 'farhan': 'Farhan',
      'team': 'Team',
    };
    editor = editorMap[editor.toLowerCase()] || editor;
  }

  // Extract creative ID (second segment, e.g. B0109, IM0004, B041)
  let creativeId = segments.length > 1 ? segments[1] : null;
  // Clean: remove "Miner" prefix if present (old format: "MR Miner")
  if (creativeId && /^miner$/i.test(creativeId) && segments.length > 2) {
    creativeId = segments[2];
  }

  // Determine type from creative ID prefix
  const isImage = creativeId && /^IM/i.test(creativeId);
  const type = isImage ? 'image' : 'video';

  // Find format — scan all segments for known format keywords
  let format = null;
  for (let i = segments.length - 1; i >= 0; i--) {
    const lower = segments[i].toLowerCase().trim().replace(/\s+/g, '');
    for (const f of KNOWN_FORMATS) {
      const fNorm = f.replace(/\s+/g, '');
      if (lower === fNorm || lower === fNorm + 's') {
        format = segments[i].trim();
        break;
      }
    }
    if (format) break;
  }

  // Normalize format
  if (format) {
    const fl = format.toLowerCase().replace(/\s/g, '');
    if (fl === 'shortvid' || fl === 'shortvideo') format = 'ShortVid';
    else if (fl === 'mashup' || fl === 'mashups') format = 'Mashup';
    else if (fl === 'minivsl') format = 'Mini VSL';
    else if (fl === 'img') format = 'IMG';
    else format = format.charAt(0).toUpperCase() + format.slice(1);
  }

  // Find angle — look for known angle keywords in segments
  let angle = null;
  for (let i = 0; i < segments.length; i++) {
    const lower = segments[i].toLowerCase().trim().replace(/\s+/g, '');
    for (const a of KNOWN_ANGLES) {
      const aNorm = a.replace(/\s+/g, '');
      if (lower === aNorm || lower.includes(aNorm)) {
        angle = segments[i].trim();
        break;
      }
    }
    if (angle) break;
  }

  // Normalize angle
  if (angle) {
    const al = angle.toLowerCase().trim().replace(/\s+/g, '');
    const angleNormMap = {
      'againstcompetition': 'Against Competition',
      'againstcompetitors': 'Against Competition',
      'gtrs': 'GTRS',
      'gt3': 'GTRS',
      'btcfarm': 'BTC Farm',
      'btcmadeeasy': 'BTC Made Easy',
      'founderstory': 'Founder Story',
      'hiddenopportunity': 'Hidden Opportunity',
      'missedopportunity': 'Missed Opportunity',
      'moneyopportunity': 'Money Opportunity',
      'sharktank': 'Shark Tank',
    };
    angle = angleNormMap[al] || angle.charAt(0).toUpperCase() + angle.slice(1).toLowerCase();
  }

  return { name, creativeId, type, week, editor, format, angle };
}

/**
 * Convert WKxx_YYYY to a date range (ISO week).
 */
function weekToDateRange(weekStr) {
  const match = weekStr.match(/WK(\d+)_(\d{4})/i);
  if (!match) return null;
  const weekNum = parseInt(match[1], 10);
  const year = parseInt(match[2], 10);

  const jan4 = new Date(year, 0, 4);
  const dayOfWeek = jan4.getDay() || 7;
  const mondayW1 = new Date(jan4);
  mondayW1.setDate(jan4.getDate() - dayOfWeek + 1);

  const start = new Date(mondayW1);
  start.setDate(mondayW1.getDate() + (weekNum - 1) * 7);

  const end = new Date(start);
  end.setDate(start.getDate() + 6);

  return { start, end };
}

/**
 * Check if a week string falls within a date range.
 */
function weekInRange(weekStr, startDate, endDate) {
  const range = weekToDateRange(weekStr);
  if (!range) return false;
  const start = new Date(startDate);
  const end = new Date(endDate);
  return range.end >= start && range.start <= end;
}

/**
 * Fetch all tasks from a ClickUp list (handles pagination).
 */
async function fetchClickUpTasks(listId) {
  if (!CLICKUP_TOKEN) return [];

  const tasks = [];
  let page = 0;
  const pageSize = 100;

  while (true) {
    const url = `${CLICKUP_BASE}/list/${listId}/task?page=${page}&limit=${pageSize}&include_closed=true`;
    const res = await fetch(url, {
      headers: { Authorization: CLICKUP_TOKEN },
    });

    if (!res.ok) {
      console.error(`ClickUp API error: ${res.status} ${res.statusText}`);
      break;
    }

    const data = await res.json();
    if (!data.tasks || data.tasks.length === 0) break;

    tasks.push(...data.tasks);
    if (data.tasks.length < pageSize) break;
    page++;
  }

  return tasks;
}

/**
 * Fetch creative performance data from Triple Whale.
 */
async function fetchTripleWhaleData(startDate, endDate) {
  if (!TW_API_KEY) return [];

  const query = `
    SELECT
      ad_name,
      SUM(spend) as total_spend,
      SUM(order_revenue) as total_revenue,
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
    console.error(`Triple Whale API error: ${res.status} — ${text}`);
    return [];
  }

  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/**
 * Normalize an ad name for fuzzy matching.
 */
function normalizeAdName(name) {
  return name
    .toLowerCase()
    .replace(/\.mp4$/i, '')
    .replace(/[_\-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize a creative ID for matching — strip leading zeros after prefix.
 * e.g. B0041 → b41, B041 → b41, B0003 → b3, IM0004 → im4
 */
function normalizeCreativeId(id) {
  if (!id) return '';
  return id.toLowerCase().replace(/^(b|im)0*/, '$1');
}

/**
 * Match a ClickUp task to Triple Whale ad data.
 * Aggregates all TW ads that match this creative ID.
 */
function matchCreative(parsed, twData, twNormalized) {
  if (!parsed.creativeId) return null;

  const creativeIdNorm = normalizeCreativeId(parsed.creativeId);
  const creativeIdLower = parsed.creativeId.toLowerCase();

  let totalSpend = 0;
  let totalRevenue = 0;
  let totalImpressions = 0;
  let totalClicks = 0;
  let matched = false;

  for (let i = 0; i < twData.length; i++) {
    const norm = twNormalized[i];

    // Strategy 1: Exact creative ID match within first 50 chars
    let idx = norm.indexOf(creativeIdLower);
    if (idx >= 0 && idx < 50) {
      totalSpend += twData[i].total_spend || 0;
      totalRevenue += twData[i].total_revenue || 0;
      totalImpressions += twData[i].impressions || 0;
      totalClicks += twData[i].clicks || 0;
      matched = true;
      continue;
    }

    // Strategy 2: Normalized ID match (B0041 matches B041)
    // Extract creative IDs from the TW ad name and normalize them
    const twIds = norm.match(/\b(b|im)\d+/g) || [];
    for (const twId of twIds) {
      // Only check IDs that appear early in the name (first ~60 chars position)
      const twIdIdx = norm.indexOf(twId);
      if (twIdIdx < 60 && normalizeCreativeId(twId) === creativeIdNorm) {
        totalSpend += twData[i].total_spend || 0;
        totalRevenue += twData[i].total_revenue || 0;
        totalImpressions += twData[i].impressions || 0;
        totalClicks += twData[i].clicks || 0;
        matched = true;
        break;
      }
    }
  }

  if (!matched) return null;
  return { total_spend: totalSpend, total_revenue: totalRevenue, impressions: totalImpressions, clicks: totalClicks };
}

/**
 * Classify a creative based on spend and ROAS.
 */
function classify(spend, roas) {
  if (spend >= 1000 && roas >= 2.0) return 'winner';
  if (spend >= 300 && roas >= 2.0) return 'promising';
  if (spend >= 300) return 'tested';
  return 'other';
}

// ── Dynamic editor list ─────────────────────────────────────────────

router.get('/editors', authenticate, async (_req, res) => {
  try {
    const editors = await getEditors();
    res.json({ success: true, editors: Object.keys(editors) });
  } catch (err) {
    console.error('[CreativeIntel] editors error:', err.message);
    res.status(500).json({ success: false, error: { message: 'Failed to load editors.' } });
  }
});

// ── Main endpoint ───────────────────────────────────────────────────

router.get('/data', authenticate, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: { message: 'startDate and endDate are required (YYYY-MM-DD)' },
      });
    }

    // Fetch data from both sources in parallel
    const [videoTasks, staticTasks, twData] = await Promise.all([
      fetchClickUpTasks(VIDEO_LIST_ID),
      fetchClickUpTasks(STATIC_LIST_ID),
      fetchTripleWhaleData(startDate, endDate),
    ]);

    // Pre-normalize TW ad names for matching
    const twNormalized = twData.map(d => normalizeAdName(d.ad_name || ''));

    // Parse all ClickUp tasks
    const allParsed = [];

    for (const task of videoTasks) {
      const parsed = parseTaskName(task.name);
      parsed.status = task.status?.status || 'unknown';
      parsed.clickupId = task.id;
      allParsed.push(parsed);
    }

    for (const task of staticTasks) {
      const parsed = parseTaskName(task.name);
      parsed.status = task.status?.status || 'unknown';
      parsed.clickupId = task.id;
      allParsed.push(parsed);
    }

    // Match ALL ClickUp tasks against TW data for the selected period.
    // A creative is included if it has TW spend in the date range OR was launched during it.
    const creatives = [];
    const seenCreativeIds = new Set();

    for (const p of allParsed) {
      const twMatch = matchCreative(p, twData, twNormalized);
      const spend = twMatch ? (twMatch.total_spend || 0) : 0;
      const revenue = twMatch ? (twMatch.total_revenue || 0) : 0;
      const roas = spend > 0 ? revenue / spend : 0;
      const impressions = twMatch ? (twMatch.impressions || 0) : 0;
      const clicks = twMatch ? (twMatch.clicks || 0) : 0;
      const status = classify(spend, roas);

      // Include if: has TW spend data in period OR was launched (week) in period
      const launchedInRange = p.week && weekInRange(p.week, startDate, endDate);
      if (!twMatch && !launchedInRange) continue;

      // Deduplicate by normalized creative ID
      const normId = normalizeCreativeId(p.creativeId);
      if (normId && seenCreativeIds.has(normId)) continue;
      if (normId) seenCreativeIds.add(normId);

      creatives.push({
        name: p.name,
        creativeId: p.creativeId,
        type: p.type,
        week: p.week,
        editor: p.editor,
        format: p.format,
        angle: p.angle,
        clickupStatus: p.status,
        spend: Math.round(spend * 100) / 100,
        revenue: Math.round(revenue * 100) / 100,
        roas: Math.round(roas * 100) / 100,
        impressions,
        clicks,
        status,
        hasPerformanceData: !!twMatch,
      });
    }

    // ── Compute KPIs ──────────────────────────────────────────────

    const videoCreatives = creatives.filter(c => c.type === 'video');
    const imageCreatives = creatives.filter(c => c.type === 'image');

    const videoWinners = videoCreatives.filter(c => c.status === 'winner');
    const imageWinners = imageCreatives.filter(c => c.status === 'winner');
    const videoPromising = videoCreatives.filter(c => c.status === 'promising');
    const imagePromising = imageCreatives.filter(c => c.status === 'promising');

    // Hit rate = winners / total launched (those with performance data)
    const videoLaunched = videoCreatives.filter(c => c.hasPerformanceData);
    const imageLaunched = imageCreatives.filter(c => c.hasPerformanceData);

    const videoHitRate = videoLaunched.length > 0
      ? Math.round((videoWinners.length / videoLaunched.length) * 10000) / 100
      : 0;
    const imageHitRate = imageLaunched.length > 0
      ? Math.round((imageWinners.length / imageLaunched.length) * 10000) / 100
      : 0;

    const summary = {
      totalCreatives: creatives.length,
      totalVideo: videoCreatives.length,
      totalImage: imageCreatives.length,
      videoWinners: videoWinners.length,
      imageWinners: imageWinners.length,
      videoPromising: videoPromising.length,
      imagePromising: imagePromising.length,
      videoHitRate,
      imageHitRate,
      videoLaunched: videoLaunched.length,
      imageLaunched: imageLaunched.length,
      totalSpend: Math.round(creatives.reduce((s, c) => s + c.spend, 0) * 100) / 100,
      totalRevenue: Math.round(creatives.reduce((s, c) => s + c.revenue, 0) * 100) / 100,
    };

    // ── Editor productivity (by week) ─────────────────────────────

    const editorMap = {};
    for (const c of creatives) {
      if (!c.editor) continue;
      const weekKey = c.week || 'unknown';
      const key = `${c.editor}__${weekKey}`;
      if (!editorMap[key]) {
        editorMap[key] = { editor: c.editor, week: weekKey, video: 0, image: 0, total: 0 };
      }
      editorMap[key][c.type]++;
      editorMap[key].total++;
    }
    const editorProductivity = Object.values(editorMap).sort((a, b) => {
      if (a.week < b.week) return -1;
      if (a.week > b.week) return 1;
      return a.editor.localeCompare(b.editor);
    });

    // ── Format performance ────────────────────────────────────────

    const formatMap = {};
    for (const c of creatives) {
      if (!c.format) continue;
      if (!formatMap[c.format]) {
        formatMap[c.format] = { format: c.format, count: 0, spend: 0, revenue: 0, winners: 0, launched: 0 };
      }
      formatMap[c.format].count++;
      formatMap[c.format].spend += c.spend;
      formatMap[c.format].revenue += c.revenue;
      if (c.status === 'winner') formatMap[c.format].winners++;
      if (c.hasPerformanceData) formatMap[c.format].launched++;
    }
    const formatPerformance = Object.values(formatMap).map(f => ({
      ...f,
      spend: Math.round(f.spend * 100) / 100,
      revenue: Math.round(f.revenue * 100) / 100,
      roas: f.spend > 0 ? Math.round((f.revenue / f.spend) * 100) / 100 : 0,
      hitRate: f.launched > 0 ? Math.round((f.winners / f.launched) * 10000) / 100 : 0,
    })).sort((a, b) => b.roas - a.roas);

    // ── Angle performance ─────────────────────────────────────────

    const angleMap = {};
    for (const c of creatives) {
      if (!c.angle) continue;
      if (!angleMap[c.angle]) {
        angleMap[c.angle] = { angle: c.angle, count: 0, spend: 0, revenue: 0, winners: 0, launched: 0 };
      }
      angleMap[c.angle].count++;
      angleMap[c.angle].spend += c.spend;
      angleMap[c.angle].revenue += c.revenue;
      if (c.status === 'winner') angleMap[c.angle].winners++;
      if (c.hasPerformanceData) angleMap[c.angle].launched++;
    }
    const anglePerformance = Object.values(angleMap).map(a => ({
      ...a,
      spend: Math.round(a.spend * 100) / 100,
      revenue: Math.round(a.revenue * 100) / 100,
      roas: a.spend > 0 ? Math.round((a.revenue / a.spend) * 100) / 100 : 0,
      hitRate: a.launched > 0 ? Math.round((a.winners / a.launched) * 10000) / 100 : 0,
    })).sort((a, b) => b.roas - a.roas);

    // ── Response ──────────────────────────────────────────────────

    res.json({
      success: true,
      data: {
        summary,
        editorProductivity,
        formatPerformance,
        anglePerformance,
        creatives: creatives.sort((a, b) => b.spend - a.spend),
      },
    });
  } catch (err) {
    console.error('Creative Intel error:', err);
    res.status(500).json({
      success: false,
      error: { message: err.message || 'Internal server error' },
    });
  }
});

// ── Frame.io helpers ────────────────────────────────────────────────

/**
 * Extract the Frame.io asset/folder ID from a URL.
 */
function extractFrameAssetId(url) {
  if (!url) return null;
  const nextMatch = url.match(/next\.frame\.io\/project\/[a-f0-9-]+\/([a-f0-9-]+)/i);
  if (nextMatch) return nextMatch[1];
  const playerMatch = url.match(/frame\.io\/player\/([a-f0-9-]+)/i);
  if (playerMatch) return playerMatch[1];
  return null;
}

// ── Sync video durations (POST from browser) ───────────────────────

router.post('/sync-durations', authenticate, async (req, res) => {
  try {
    const { durations } = req.body;
    if (!Array.isArray(durations) || durations.length === 0) {
      return res.status(400).json({
        success: false,
        error: { message: 'durations array is required' },
      });
    }

    let upserted = 0;
    for (const d of durations) {
      if (!d.frameAssetId || d.durationSeconds == null) continue;
      await pgQuery(
        `INSERT INTO video_durations (frame_asset_id, brief_code, task_name, editor, week_code, duration_seconds, video_count, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (frame_asset_id) DO UPDATE SET
           duration_seconds = EXCLUDED.duration_seconds,
           video_count = EXCLUDED.video_count,
           brief_code = COALESCE(EXCLUDED.brief_code, video_durations.brief_code),
           task_name = COALESCE(EXCLUDED.task_name, video_durations.task_name),
           editor = COALESCE(EXCLUDED.editor, video_durations.editor),
           week_code = COALESCE(EXCLUDED.week_code, video_durations.week_code),
           synced_at = NOW()`,
        [
          d.frameAssetId,
          d.briefCode || null,
          d.taskName || null,
          d.editor || null,
          d.weekCode || null,
          d.durationSeconds,
          d.videoCount || 1,
        ]
      );
      upserted++;
    }

    res.json({ success: true, upserted });
  } catch (err) {
    console.error('[Creative Intel] sync-durations error:', err);
    res.status(500).json({
      success: false,
      error: { message: err.message || 'Failed to sync durations.' },
    });
  }
});

// ── Editor Minutes endpoint (reads from DB + ClickUp) ───────────────

router.get('/editor-minutes', authenticate, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: { message: 'startDate and endDate are required (YYYY-MM-DD)' },
      });
    }

    // 1. Fetch all video tasks from ClickUp
    const allTasks = await fetchClickUpTasks(VIDEO_LIST_ID);

    // 2. Load all synced durations from DB, keyed by frame_asset_id
    let durationMap = {};
    try {
      const rows = await pgQuery('SELECT frame_asset_id, duration_seconds, video_count FROM video_durations');
      for (const r of rows) {
        durationMap[r.frame_asset_id] = {
          durationSeconds: Number(r.duration_seconds) || 0,
          videoCount: Number(r.video_count) || 1,
        };
      }
    } catch {
      // Table might not exist yet — proceed with empty map
    }

    // 3. Process tasks
    const editorMinutes = {};
    const editorWeekMinutes = {};
    const processedBriefs = new Set();
    let totalSynced = 0;
    let totalMissing = 0;

    for (const task of allTasks) {
      const parsed = parseTaskName(task.name);
      if (!parsed.week || !parsed.editor) continue;
      if (!weekInRange(parsed.week, startDate, endDate)) continue;

      // Deduplicate by creative ID
      const briefId = parsed.creativeId;
      if (!briefId || processedBriefs.has(briefId)) continue;
      processedBriefs.add(briefId);

      // Extract Frame.io link
      let frameUrl = null;
      for (const cf of task.custom_fields || []) {
        if (cf.id === FRAME_LINK_FIELD_ID && cf.value) {
          frameUrl = cf.value;
          break;
        }
      }

      const assetId = extractFrameAssetId(frameUrl);

      // Look up duration from DB
      let durationSec = 0;
      let hasDuration = false;
      if (assetId && durationMap[assetId]) {
        durationSec = durationMap[assetId].durationSeconds;
        hasDuration = true;
        totalSynced++;
      } else {
        totalMissing++;
      }

      const durationMin = Math.round((durationSec / 60) * 100) / 100;
      const editor = parsed.editor;

      // Accumulate per editor
      if (!editorMinutes[editor]) {
        editorMinutes[editor] = { editor, totalMinutes: 0, videoCount: 0, briefs: [] };
      }
      editorMinutes[editor].totalMinutes += durationMin;
      editorMinutes[editor].videoCount++;
      editorMinutes[editor].briefs.push({
        briefId,
        week: parsed.week,
        durationMin,
        hasDuration,
        taskName: task.name,
      });

      // Accumulate per editor per week
      const weekKey = `${editor}__${parsed.week}`;
      if (!editorWeekMinutes[weekKey]) {
        editorWeekMinutes[weekKey] = { editor, week: parsed.week, totalMinutes: 0, videoCount: 0 };
      }
      editorWeekMinutes[weekKey].totalMinutes += durationMin;
      editorWeekMinutes[weekKey].videoCount++;
    }

    // Round totals
    for (const ed of Object.values(editorMinutes)) {
      ed.totalMinutes = Math.round(ed.totalMinutes * 100) / 100;
    }
    for (const ew of Object.values(editorWeekMinutes)) {
      ew.totalMinutes = Math.round(ew.totalMinutes * 100) / 100;
    }

    const editorSummary = Object.values(editorMinutes).sort((a, b) => b.totalMinutes - a.totalMinutes);
    const weeklyBreakdown = Object.values(editorWeekMinutes).sort((a, b) => {
      if (a.week < b.week) return -1;
      if (a.week > b.week) return 1;
      return a.editor.localeCompare(b.editor);
    });

    res.json({
      success: true,
      data: {
        editorSummary,
        weeklyBreakdown,
        syncStatus: { synced: totalSynced, missing: totalMissing },
      },
    });
  } catch (err) {
    console.error('[Creative Intel] editor-minutes error:', err);
    res.status(500).json({
      success: false,
      error: { message: err.message || 'Failed to fetch editor minutes.' },
    });
  }
});

export default router;
