import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// ── Config ──────────────────────────────────────────────────────────
const CLICKUP_TOKEN  = process.env.CLICKUP_API_TOKEN  || '';
const TW_API_KEY     = process.env.TRIPLEWHALE_API_KEY || '';
const TW_SHOP_ID     = process.env.TRIPLEWHALE_SHOP_ID || '17cca0-2.myshopify.com';

const CLICKUP_BASE   = 'https://api.clickup.com/api/v2';
const TW_SQL_URL     = 'https://api.triplewhale.com/api/v2/orcabase/api/sql';

const VIDEO_LIST_ID  = '901518716584';
const STATIC_LIST_ID = '901518769479';

// Known formats & angles for classification
const KNOWN_FORMATS = ['mashup', 'shortvid', 'mini vsl', 'img', 'short vid'];
const KNOWN_ANGLES  = [
  'lottery', 'againstcompetition', 'gtrs', 'btc made easy', 'founderstory',
  'hiddenopportunity', 'missedopportunity', 'btcfarm', 'moneyopportunity',
  'offer', 'retargeting', 'reaction', 'sharktank', 'lambo', 'mclaren',
  'scarcity', 'comparison',
];

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Parse the ClickUp naming convention.
 * Last segment = week (WKxx_YYYY), second-to-last = editor.
 * Scans remaining segments for known format and angle.
 */
function parseTaskName(name) {
  const segments = name.split(/\s*-\s*/).map(s => s.trim()).filter(Boolean);

  // Extract week (last segment matching WKxx_YYYY)
  let week = null;
  let weekIdx = -1;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (/^WK\d+_\d{4}$/i.test(segments[i])) {
      week = segments[i].toUpperCase();
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

  // Normalize editor name
  if (editor) {
    editor = editor.charAt(0).toUpperCase() + editor.slice(1).toLowerCase();
    // Common name normalizations
    const editorMap = {
      'mohammad': 'Muhammad',
      'mohammed': 'Muhammad',
      'muhammad': 'Muhammad',
      'antoni': 'Antoni',
      'anthony': 'Antoni',
      'ludovico': 'Ludovico',
      'faiz': 'Faiz',
      'atif': 'Atif',
      'ali': 'Ali',
      'hamza': 'Hamza',
      'usama': 'Usama',
      'carl': 'Carl',
      'alhamjatonni': 'Alhamjatonni',
      'abdul': 'Abdul',
      'robi': 'Robi',
      'abdullah': 'Abdullah',
      'farhan': 'Farhan',
    };
    editor = editorMap[editor.toLowerCase()] || editor;
  }

  // Extract creative ID (second segment, e.g. B0109, IM0004)
  const creativeId = segments.length > 1 ? segments[1] : null;

  // Determine type from creative ID prefix
  const isImage = creativeId && /^IM/i.test(creativeId);
  const type = isImage ? 'image' : 'video';

  // Find format — scan from right to left (before editor area)
  let format = null;
  const searchSegments = weekIdx > 0 ? segments.slice(0, weekIdx) : segments;
  for (let i = searchSegments.length - 1; i >= 0; i--) {
    const lower = searchSegments[i].toLowerCase().trim();
    if (KNOWN_FORMATS.some(f => lower === f || lower.replace(/\s/g, '') === f.replace(/\s/g, ''))) {
      format = searchSegments[i].trim();
      // Also check for angle right before format
      break;
    }
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
  for (let i = 0; i < searchSegments.length; i++) {
    const lower = searchSegments[i].toLowerCase().trim();
    if (KNOWN_ANGLES.some(a => lower === a || lower.includes(a))) {
      angle = searchSegments[i].trim();
      break;
    }
  }

  // Normalize angle
  if (angle) {
    const al = angle.toLowerCase().trim();
    if (al === 'againstcompetition') angle = 'Against Competition';
    else if (al === 'gtrs') angle = 'GTRS';
    else if (al === 'btcfarm') angle = 'BTC Farm';
    else if (al === 'btc made easy') angle = 'BTC Made Easy';
    else if (al === 'founderstory') angle = 'Founder Story';
    else if (al === 'hiddenopportunity') angle = 'Hidden Opportunity';
    else if (al === 'missedopportunity') angle = 'Missed Opportunity';
    else if (al === 'moneyopportunity') angle = 'Money Opportunity';
    else if (al === 'sharktank') angle = 'Shark Tank';
    else angle = angle.charAt(0).toUpperCase() + angle.slice(1).toLowerCase();
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

  // ISO week: Jan 4 is always in week 1
  const jan4 = new Date(year, 0, 4);
  const dayOfWeek = jan4.getDay() || 7; // Mon=1 ... Sun=7
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
  // Week overlaps with range if week-end >= range-start AND week-start <= range-end
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
 * Strips separators, extra spaces, .mp4, lowercases.
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
 * Try to match a ClickUp task to a Triple Whale ad.
 * Returns the best matching TW record or null.
 */
function matchCreative(parsed, twData, twNormalized) {
  if (!parsed.creativeId) return null;

  const creativeIdLower = parsed.creativeId.toLowerCase();

  // Strategy: Match creative ID near the start of the ad name.
  // The ID (e.g. "b0109") should appear as the 2nd segment, not as a reference deeper in the name.
  // We check if the normalized TW name starts with or has the ID within the first ~30 chars.
  // Aggregate all TW ads that match this creative ID (same creative can run as multiple ads)
  let totalSpend = 0;
  let totalRevenue = 0;
  let totalImpressions = 0;
  let totalClicks = 0;
  let matched = false;

  for (let i = 0; i < twData.length; i++) {
    const norm = twNormalized[i];
    const idx = norm.indexOf(creativeIdLower);
    if (idx >= 0 && idx < 40) {
      totalSpend += twData[i].total_spend || 0;
      totalRevenue += twData[i].total_revenue || 0;
      totalImpressions += twData[i].impressions || 0;
      totalClicks += twData[i].clicks || 0;
      matched = true;
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

    // Filter by date range (using week field)
    const filtered = allParsed.filter(p => {
      if (!p.week) return false;
      return weekInRange(p.week, startDate, endDate);
    });

    // Match with Triple Whale data and classify
    const creatives = filtered.map(p => {
      const twMatch = matchCreative(p, twData, twNormalized);
      const spend = twMatch ? (twMatch.total_spend || 0) : 0;
      const revenue = twMatch ? (twMatch.total_revenue || 0) : 0;
      const roas = spend > 0 ? revenue / spend : 0;
      const impressions = twMatch ? (twMatch.impressions || 0) : 0;
      const clicks = twMatch ? (twMatch.clicks || 0) : 0;
      const status = classify(spend, roas);

      return {
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
      };
    });

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
      if (!c.editor || !c.week) continue;
      const key = `${c.editor}__${c.week}`;
      if (!editorMap[key]) {
        editorMap[key] = { editor: c.editor, week: c.week, video: 0, image: 0, total: 0 };
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

export default router;
