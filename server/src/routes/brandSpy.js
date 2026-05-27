/**
 * Brand Spy — Express router
 * Mounted at /api/v1/brand-spy
 */

import { Router } from 'express';
import {
  listBrands,
  getBrandExpanded,
  createBrand,
  deleteBrand,
  listAds,
  getAdDetail,
  getAdTierCounts,
} from '../db/brandSpyDb.js';
import { runBrandScrape, scrapeAllInBackground, recoverStuckScrapes } from '../workers/brandSpyWorker.js';
import { getScrapeCreatorsClient } from '../services/scrapeCreators.js';

const router = Router();

function normalizeDomain(input) {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^\d{6,}$/.test(trimmed)) return trimmed;
  let cleaned = trimmed.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
  if (cleaned.startsWith('facebook.com/') || cleaned.startsWith('fb.com/')) {
    return cleaned.replace(/\/$/, '');
  }
  cleaned = cleaned.split('/')[0].split('?')[0].split('#')[0];
  return cleaned || null;
}

function parseFollowInput(body) {
  if (body.bulk?.length) return body.bulk;
  if (body.domain || body.metaPageUrl || body.pageId) {
    return [{ domain: body.domain, metaPageUrl: body.metaPageUrl, pageId: body.pageId }];
  }
  return [];
}

// GET /brands
router.get('/brands', async (req, res, next) => {
  try {
    const brands = await listBrands(null);
    res.json({ brands });
  } catch (err) { next(err); }
});

// GET /brands/:id
router.get('/brands/:id', async (req, res, next) => {
  try {
    const brand = await getBrandExpanded(req.params.id);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });
    res.json({ brand });
  } catch (err) { next(err); }
});

// GET /brands/:id/ads
router.get('/brands/:id/ads', async (req, res, next) => {
  try {
    const days = req.query.days ? parseInt(String(req.query.days), 10) : null;
    const q = {
      page:         req.query.page        ? Math.max(1, parseInt(String(req.query.page), 10) || 1) : 1,
      pageSize:     req.query.pageSize    ? parseInt(String(req.query.pageSize), 10) || undefined : undefined,
      sort:         req.query.sort        ? String(req.query.sort)        : 'rank_asc',
      tier:         req.query.tier        ? String(req.query.tier)        : 'ALL',
      format:       req.query.format      ? String(req.query.format)      : undefined,
      brandPageId:  req.query.brandPageId ? String(req.query.brandPageId) : undefined,
      minStartDate: (days && days > 0)
        ? new Date(Date.now() - days * 86400000).toISOString()
        : undefined,
    };
    const result = await listAds(req.params.id, q);
    res.json(result);
  } catch (err) { next(err); }
});

// GET /brands/:id/tier-counts
router.get('/brands/:id/tier-counts', async (req, res, next) => {
  try {
    const counts = await getAdTierCounts(req.params.id);
    res.json({ counts });
  } catch (err) { next(err); }
});

// POST /brands/scrape-all — MUST be before /:id/scrape to avoid route conflict
router.post('/brands/scrape-all', async (req, res, next) => {
  try {
    const brands = await listBrands(null);
    scrapeAllInBackground(brands.map((b) => b.id)).catch((err) =>
      console.error('[brand-spy] scrape-all failed:', err),
    );
    res.status(202).json({ queued: brands.length });
  } catch (err) { next(err); }
});

// POST /brands
router.post('/brands', async (req, res, next) => {
  try {
    const inputs = parseFollowInput(req.body);
    if (!inputs.length) return res.status(400).json({ error: 'No domains or pages provided.' });

    const warnings = [];
    const createdBrands = [];

    for (const input of inputs) {
      try {
        const domain = normalizeDomain(input.domain ?? input.metaPageUrl ?? input.pageId ?? '');
        if (!domain) { warnings.push(`Could not parse: ${JSON.stringify(input)}`); continue; }
        const brand = await createBrand({ domain, workspaceId: null, ownerUserId: null });
        createdBrands.push(brand);
      } catch (err) {
        warnings.push(`Failed to follow ${input.domain ?? input.metaPageUrl}: ${err.message ?? 'unknown'}`);
      }
    }

    for (const brand of createdBrands) {
      runBrandScrape({ brandId: brand.id, trigger: 'FOLLOW' }).catch((err) =>
        console.error(`[brand-spy] background scrape failed for ${brand.id}:`, err),
      );
    }

    res.status(201).json({ brands: createdBrands, warnings });
  } catch (err) { next(err); }
});

// POST /brands/:id/scrape
router.post('/brands/:id/scrape', async (req, res, next) => {
  try {
    const result = await runBrandScrape({ brandId: req.params.id, trigger: 'MANUAL' });
    res.json({ result });
  } catch (err) { next(err); }
});

// DELETE /brands/:id
router.delete('/brands/:id', async (req, res, next) => {
  try {
    const ok = await deleteBrand(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Brand not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

// GET /brands/:id/intel — AI analysis of top active ads
router.get('/brands/:id/intel', async (req, res, next) => {
  try {
    const brand = await getBrandExpanded(req.params.id);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    const adsResult = await listAds(req.params.id, {
      page: 1, pageSize: 60, sort: 'rank_asc', tier: 'ALL',
    });
    const activeAds = adsResult.ads.filter((a) => a.isActive);
    const adsToAnalyze = activeAds.length ? activeAds : adsResult.ads;

    if (!adsToAnalyze.length) {
      return res.json({ personas: [], adAngles: [], usps: [], desires: [], emotions: [], themes: [] });
    }

    const adsData = adsToAnalyze
      .slice(0, 60)
      .map((a) => ({
        headline: a.headline ?? null,
        body: a.bodyText ? a.bodyText.slice(0, 200) : null,
      }))
      .filter((a) => a.headline || a.body);

    if (!adsData.length) {
      return res.json({ personas: [], adAngles: [], usps: [], desires: [], emotions: [], themes: [] });
    }

    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content: `Analyze these ${adsData.length} Facebook ads from the brand "${brand.domain}" and identify patterns. Return ONLY a valid JSON object with exactly these 6 keys (no other text, no markdown, no explanation):
{
  "personas": ["5 to 7 specific target audience personas, e.g. Health-conscious moms 28-40"],
  "adAngles": ["5 to 7 creative angles or hooks used, e.g. Before and after transformation"],
  "usps": ["5 to 7 unique selling propositions highlighted, e.g. Clinically tested formula"],
  "desires": ["5 to 7 core desires being addressed, e.g. Want visible results fast"],
  "emotions": ["5 to 7 emotions being triggered, e.g. Fear of missing out"],
  "themes": ["5 to 7 recurring creative themes, e.g. Natural ingredients"]
}

Ads data:
${JSON.stringify(adsData)}`,
      }],
    });

    const rawText = message.content[0]?.text ?? '';
    let intel;
    try {
      const match = rawText.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('No JSON in response');
      intel = JSON.parse(match[0]);
    } catch (parseErr) {
      console.error('[brand-spy] intel parse error:', parseErr.message, 'raw:', rawText.slice(0, 300));
      return res.status(500).json({ error: 'Failed to parse AI response' });
    }

    res.json({
      personas:  Array.isArray(intel.personas)  ? intel.personas  : [],
      adAngles:  Array.isArray(intel.adAngles)  ? intel.adAngles  : [],
      usps:      Array.isArray(intel.usps)      ? intel.usps      : [],
      desires:   Array.isArray(intel.desires)   ? intel.desires   : [],
      emotions:  Array.isArray(intel.emotions)  ? intel.emotions  : [],
      themes:    Array.isArray(intel.themes)    ? intel.themes    : [],
    });
  } catch (err) { next(err); }
});

// GET /debug/snapshots/:id — temporary diagnostic
router.get('/debug/snapshots/:id', async (req, res, next) => {
  try {
    const { query: pgQuery } = await import('../config/db.js');
    const id = req.params.id;

    const { rows: countRows } = await pgQuery(
      `SELECT COUNT(*) AS total, MIN(snapshot_at) AS oldest, MAX(snapshot_at) AS newest
         FROM brand_spy.ad_rank_snapshots WHERE brand_id = $1`,
      [id],
    );

    // Distinct timestamps (scrape run times)
    const { rows: runRows } = await pgQuery(
      `SELECT DISTINCT DATE_TRUNC('minute', snapshot_at) AS run_time, COUNT(*) AS ads
         FROM brand_spy.ad_rank_snapshots WHERE brand_id = $1
         GROUP BY DATE_TRUNC('minute', snapshot_at)
         ORDER BY run_time DESC LIMIT 10`,
      [id],
    );

    // Run the EXACT d3 DISTINCT ON query used by loadHistoricalRanks
    const lower = '0', upper = '6', center = '3';
    const { rows: d3Sample } = await pgQuery(
      `SELECT DISTINCT ON (ad_archive_id) ad_archive_id, rank, snapshot_at
         FROM brand_spy.ad_rank_snapshots
        WHERE brand_id = $1
          AND snapshot_at BETWEEN NOW() - ($3::text || ' days')::INTERVAL
                              AND NOW() - ($2::text || ' days')::INTERVAL
        ORDER BY ad_archive_id,
                 ABS(EXTRACT(EPOCH FROM (NOW() - snapshot_at - ($4::text || ' days')::INTERVAL)))
        LIMIT 5`,
      [id, lower, upper, center],
    );

    // Check current rank_3d value in ads table for a sample ad
    const { rows: adsCheck } = await pgQuery(
      `SELECT ad_archive_id, current_rank, rank_3d, rank_7d, rank_21d, velocity_7d, velocity_21d
         FROM brand_spy.ads
        WHERE brand_id = $1 AND current_rank IS NOT NULL
        ORDER BY current_rank ASC LIMIT 3`,
      [id],
    );

    res.json({
      snapshotCount: countRows[0],
      scrapeRuns: runRows,
      d3QuerySampleRows: d3Sample.length,
      d3QuerySample: d3Sample,
      adsVelocitySample: adsCheck,
    });
  } catch (err) { next(err); }
});

// GET /ads/:id
router.get('/ads/:id', async (req, res, next) => {
  try {
    const ad = await getAdDetail(req.params.id);
    if (!ad) return res.status(404).json({ error: 'Ad not found' });
    res.json({ ad });
  } catch (err) { next(err); }
});

// GET /credits
router.get('/credits', async (_req, res, next) => {
  try {
    const sc = getScrapeCreatorsClient();
    const balance = await sc.getCreditBalance();
    res.json(balance);
  } catch (err) { next(err); }
});

router.use((err, _req, res, _next) => {
  console.error('[brand-spy]', err);
  res.status(500).json({ error: err.message || 'Internal error' });
});

// ---------------------------------------------------------------------------
// Daily auto-scrape scheduler
// Runs once 5 minutes after boot, then every 24 hours.
// Mirrors the standalone brand-spy-daily-scrape cron job.
// ---------------------------------------------------------------------------
function scheduleDailyScrape() {
  const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
  const BOOT_DELAY_MS = 5 * 60 * 1000;     // 5 min — let the server fully settle

  const runScrapeAll = async () => {
    try {
      const brands = await listBrands(null);
      if (!brands.length) return;
      console.log(`[brand-spy] auto-scrape: starting ${brands.length} brand(s)`);
      await scrapeAllInBackground(brands.map((b) => b.id));
      console.log(`[brand-spy] auto-scrape: complete`);
    } catch (err) {
      console.error('[brand-spy] auto-scrape error:', err.message);
    }
  };

  // Boot recovery: immediately re-scrape any brand left in RUNNING or INTERRUPTED
  // state by a previous deploy that killed an in-flight scrape. These brands have
  // stale is_active=false flags and their active_ads_count was never updated.
  // Runs immediately on boot (no delay) so recovery starts before the regular 5-min scrape.
  recoverStuckScrapes()
    .then((stuckIds) => {
      if (stuckIds.length > 0) {
        console.log(`[brand-spy] boot recovery: launching scrape for ${stuckIds.length} brand(s)`);
        scrapeAllInBackground(stuckIds).catch((err) =>
          console.error('[brand-spy] recovery scrape failed:', err),
        );
      } else {
        console.log('[brand-spy] boot recovery: no stuck brands found');
      }
    })
    .catch((err) => console.error('[brand-spy] boot recovery check failed:', err.message));

  // Regular auto-scrape: 5 min after boot (give server time to settle), then every 24h.
  setTimeout(() => {
    runScrapeAll();
    setInterval(runScrapeAll, INTERVAL_MS);
  }, BOOT_DELAY_MS);

  console.log('[brand-spy] auto-scrape scheduled (boot +5min, then every 24h); recovery check running immediately');
}

scheduleDailyScrape();

export default router;
