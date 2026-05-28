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
  getAdFormatCounts,
  getBrandAggregations,
  getBrandAggregationCounts,
} from '../db/brandSpyDb.js';
import { query as pgQuery } from '../config/db.js';
import { runBrandScrape, scrapeAllInBackground, recoverStuckScrapes } from '../workers/brandSpyWorker.js';
import { getScrapeCreatorsClient } from '../services/scrapeCreators.js';
import { transcribeVideoUrl } from '../services/videoTranscribe.js';

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
    const daysRaw = req.query.days ? parseInt(String(req.query.days), 10) : null;
    const days    = (daysRaw !== null && !isNaN(daysRaw) && daysRaw > 0) ? daysRaw : null;
    const q = {
      page:         req.query.page        ? Math.max(1, parseInt(String(req.query.page), 10) || 1) : 1,
      pageSize:     req.query.pageSize    ? parseInt(String(req.query.pageSize), 10) || undefined : undefined,
      sort:         req.query.sort        ? String(req.query.sort)        : 'rank_asc',
      tier:         req.query.tier        ? String(req.query.tier)        : 'ALL',
      format:       req.query.format      ? String(req.query.format)      : undefined,
      status:       req.query.status      ? String(req.query.status)      : undefined,
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

// GET /brands/:id/format-counts — brand-wide media-mix counts
router.get('/brands/:id/format-counts', async (req, res, next) => {
  try {
    const counts = await getAdFormatCounts(req.params.id);
    res.json({ counts });
  } catch (err) { next(err); }
});

// GET /brands/:id/aggregations?type=hooks|adcopy|headlines|landing&activeOnly=1&limit=50
// Groups the brand's ads by content pattern. Used by the Hooks / Ad Copy /
// Headlines / Landing Pages tabs.
const VALID_AGG_TYPES = new Set(['hooks', 'adcopy', 'headlines', 'landing']);
router.get('/brands/:id/aggregations', async (req, res, next) => {
  try {
    const type = String(req.query.type ?? '');
    if (!VALID_AGG_TYPES.has(type)) {
      return res.status(400).json({ error: `Invalid type. Must be one of: ${[...VALID_AGG_TYPES].join(', ')}` });
    }
    const limitRaw = parseInt(String(req.query.limit ?? ''), 10);
    const limit = (!isNaN(limitRaw) && limitRaw > 0 && limitRaw <= 200) ? limitRaw : 50;
    const activeOnly = String(req.query.activeOnly ?? '') === '1';
    const result = await getBrandAggregations(req.params.id, type, { limit, activeOnly });
    res.json(result);
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
// Returns 202 immediately — fire-and-forget. The scrape runs in the background.
// Clients should poll GET /brands/:id and check lastScrapeStatus !== 'RUNNING'.
router.post('/brands/:id/scrape', async (req, res, next) => {
  try {
    const brand = await getBrandExpanded(req.params.id);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });
    runBrandScrape({ brandId: req.params.id, trigger: 'MANUAL' }).catch((err) =>
      console.error(`[brand-spy] manual scrape failed for ${req.params.id}:`, err),
    );
    res.status(202).json({ queued: true });
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

// GET /brands/:id/aggregation-counts — combined counts for Overview's 4
// mini-stat boxes (Hooks / Ad copy / Headlines / LPs). Replaces 4 parallel
// /aggregations?type=X&limit=1 calls with one round-trip + one in-memory pass.
router.get('/brands/:id/aggregation-counts', async (req, res, next) => {
  try {
    const counts = await getBrandAggregationCounts(req.params.id);
    res.json(counts);
  } catch (err) { next(err); }
});

// GET /brands/:id/intel — AI analysis of top active ads
//
// Result is cached on the brand row (intel_payload + intel_scraped_at columns).
// The cache is valid as long as intel_scraped_at >= last_scraped_at — when a
// new scrape lands and advances last_scraped_at, the next /intel call detects
// the mismatch and regenerates. Initial round-trip is ~7-8 s (Claude Haiku);
// cached calls return in <50 ms.
router.get('/brands/:id/intel', async (req, res, next) => {
  try {
    // Fast path: cached payload still in sync with last_scraped_at.
    const cacheRow = await pgQuery(
      `SELECT intel_payload, intel_scraped_at, last_scraped_at
         FROM brand_spy.brands WHERE id = $1`,
      [req.params.id],
    );
    const row = cacheRow.rows[0];
    if (row && row.intel_payload && row.intel_scraped_at && row.last_scraped_at
        && new Date(row.intel_scraped_at).getTime() >= new Date(row.last_scraped_at).getTime()) {
      return res.json(row.intel_payload);
    }

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

    const payload = {
      personas:  Array.isArray(intel.personas)  ? intel.personas  : [],
      adAngles:  Array.isArray(intel.adAngles)  ? intel.adAngles  : [],
      usps:      Array.isArray(intel.usps)      ? intel.usps      : [],
      desires:   Array.isArray(intel.desires)   ? intel.desires   : [],
      emotions:  Array.isArray(intel.emotions)  ? intel.emotions  : [],
      themes:    Array.isArray(intel.themes)    ? intel.themes    : [],
    };

    // Persist the result so subsequent calls until the next scrape return
    // instantly. Use the brand's current last_scraped_at as the cache key;
    // if last_scraped_at is null (brand never scraped) we still store with
    // NOW() so we have a marker, though that case is unusual.
    try {
      await pgQuery(
        `UPDATE brand_spy.brands
            SET intel_payload    = $2::jsonb,
                intel_scraped_at = COALESCE(last_scraped_at, NOW())
          WHERE id = $1`,
        [req.params.id, JSON.stringify(payload)],
      );
    } catch (cacheErr) {
      // Cache failure is non-fatal — the user still gets their result.
      console.warn('[brand-spy] intel cache write failed:', cacheErr.message);
    }

    res.json(payload);
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

// POST /ads/:id/transcribe — Whisper transcript with DB cache.
// Returns { transcript, cached, transcriptAt } where `cached: true` means the
// stored transcript was returned without hitting OpenAI again.
router.post('/ads/:id/transcribe', async (req, res, next) => {
  try {
    const adId = req.params.id;
    const ad = await getAdDetail(adId);
    if (!ad) return res.status(404).json({ error: 'Ad not found' });

    if (ad.transcript) {
      return res.json({
        transcript: ad.transcript,
        cached: true,
        transcriptAt: ad.transcriptAt,
      });
    }
    if (!ad.videoUrl) {
      return res.status(400).json({
        error: 'This ad has no video to transcribe',
        reason: 'NO_VIDEO_URL',
      });
    }

    const transcript = await transcribeVideoUrl(ad.videoUrl);
    const { rows } = await pgQuery(
      `UPDATE brand_spy.ads
          SET transcript = $1, transcript_at = NOW()
        WHERE id = $2
        RETURNING transcript_at`,
      [transcript, adId],
    );
    res.json({
      transcript,
      cached: false,
      transcriptAt: rows[0]?.transcript_at?.toISOString() ?? new Date().toISOString(),
    });
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
