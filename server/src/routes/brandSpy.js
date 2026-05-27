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
    const q = {
      page:        req.query.page        ? Math.max(1, parseInt(String(req.query.page), 10) || 1) : 1,
      pageSize:    req.query.pageSize    ? parseInt(String(req.query.pageSize), 10) || undefined : undefined,
      sort:        req.query.sort        ? String(req.query.sort)        : 'rank_asc',
      tier:        req.query.tier        ? String(req.query.tier)        : 'ALL',
      format:      req.query.format      ? String(req.query.format)      : undefined,
      brandPageId: req.query.brandPageId ? String(req.query.brandPageId) : undefined,
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
