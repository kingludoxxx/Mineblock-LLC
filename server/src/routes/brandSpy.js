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
import { extractFreshVideoUrl, adLibraryUrl } from '../services/freshVideoUrl.js';
import { startMediaMirrorWorker } from '../services/brandSpyMediaMirror.js';

const router = Router();

// RFC4122 UUID v1-v5. Used to reject malformed :id params before they hit
// Postgres (where they'd otherwise throw a raw `invalid input syntax for
// type uuid` 500 with the value echoed back).
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateUuidParam(name) {
  return (req, res, next) => {
    const v = req.params[name];
    if (!v || !UUID_RX.test(v)) {
      return res.status(400).json({
        error: `Invalid ${name}: expected UUID`,
      });
    }
    next();
  };
}

// In-process mutex for concurrent transcribe-on-same-ad. Without this, two
// parallel POSTs to /ads/:id/transcribe both miss the cache, both pay
// OpenAI, and the second UPDATE overwrites the first with identical data.
// The set holds adId strings currently in-flight; a second caller awaits
// the first's promise instead of re-running.
const transcribeInFlight = new Map(); // adId → Promise<{transcript, segments, cached, transcriptAt}>

// Known subdomain prefixes that are storefront / CDN / indirection — never
// the brand identity itself. Stripping these from the followed domain lets
// users paste any URL they have (shop.brand.com, try.brand.com, m.brand.com,
// track.brand.com, …) and still have the worker find the brand's full ad
// library. An UNKNOWN prefix (blog., community., support.case.com, …) is
// preserved — better to follow a subdomain than to silently over-strip.
const STRIPPABLE_PREFIXES = new Set([
  'www', 'shop', 'store', 'm', 'mobile', 'app',
  'try', 'get', 'check', 'checkout', 'order', 'pay', 'cart',
  'secure', 'ssl', 'cdn', 'static', 'assets',
  'account', 'login', 'auth', 'admin',
  'go', 'track', 'click', 'lp', 'landing',
  'en', 'us', 'eu', 'uk',
]);

function stripCommonSubdomains(domain) {
  if (!domain) return domain;
  let result = domain;
  for (;;) {
    const parts = result.split('.');
    if (parts.length < 3) break;                       // already at registrable form
    if (!STRIPPABLE_PREFIXES.has(parts[0])) break;     // unknown prefix → preserve
    result = parts.slice(1).join('.');
  }
  return result;
}

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
  if (!cleaned) return null;
  // Peel known storefront/CDN prefixes — shop.try-sprtn.com → try-sprtn.com.
  return stripCommonSubdomains(cleaned);
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
router.get('/brands/:id', validateUuidParam('id'), async (req, res, next) => {
  try {
    const brand = await getBrandExpanded(req.params.id);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });
    res.json({ brand });
  } catch (err) { next(err); }
});

// GET /brands/:id/ads
router.get('/brands/:id/ads', validateUuidParam('id'), async (req, res, next) => {
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
router.get('/brands/:id/tier-counts', validateUuidParam('id'), async (req, res, next) => {
  try {
    const counts = await getAdTierCounts(req.params.id);
    res.json({ counts });
  } catch (err) { next(err); }
});

// GET /brands/:id/format-counts — brand-wide media-mix counts
router.get('/brands/:id/format-counts', validateUuidParam('id'), async (req, res, next) => {
  try {
    const counts = await getAdFormatCounts(req.params.id);
    res.json({ counts });
  } catch (err) { next(err); }
});

// GET /brands/:id/aggregations?type=hooks|adcopy|headlines|landing&activeOnly=1&limit=50
// Groups the brand's ads by content pattern. Used by the Hooks / Ad Copy /
// Headlines / Landing Pages tabs.
const VALID_AGG_TYPES = new Set(['hooks', 'adcopy', 'headlines', 'landing']);
router.get('/brands/:id/aggregations', validateUuidParam('id'), async (req, res, next) => {
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

// POST /brands/:id/heal-domain
// One-shot fix for brands originally followed with a storefront subdomain
// (shop.brand.com, try.brand.com, m.brand.com, …). Re-normalizes the brand's
// stored domain to the registrable form, registers the old subdomain in
// brand_domains so it's still tracked, and force-triggers a fresh scrape.
router.post('/brands/:id/heal-domain', validateUuidParam('id'), async (req, res, next) => {
  try {
    const brand = await getBrandExpanded(req.params.id);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    const original = brand.domain;
    const cleaned  = stripCommonSubdomains(original);
    if (cleaned === original) {
      return res.json({
        healed: false,
        reason: 'domain already at registrable form',
        domain: original,
      });
    }

    // Move the brand to the cleaned root. Subdomain row will record the
    // original so any leftover lookups still resolve.
    await pgQuery(
      `UPDATE brand_spy.brands SET domain = $1 WHERE id = $2`,
      [cleaned, req.params.id],
    );
    await pgQuery(
      `INSERT INTO brand_spy.brand_domains (brand_id, domain, is_primary)
         VALUES ($2, $1, FALSE)
         ON CONFLICT (brand_id, domain) DO NOTHING`,
      [original, req.params.id],
    );
    // Also ensure the new canonical primary domain exists.
    await pgQuery(
      `INSERT INTO brand_spy.brand_domains (brand_id, domain, is_primary)
         VALUES ($2, $1, TRUE)
         ON CONFLICT (brand_id, domain) DO UPDATE SET is_primary = TRUE`,
      [cleaned, req.params.id],
    );

    // Force-trigger a fresh scrape (bypass the 12h cool-down).
    runBrandScrape({ brandId: req.params.id, trigger: 'HEAL', force: true }).catch((err) =>
      console.error(`[brand-spy] heal-domain scrape failed for ${req.params.id}:`, err),
    );

    res.json({
      healed: true,
      from: original,
      to: cleaned,
      scrapeQueued: true,
    });
  } catch (err) { next(err); }
});

// POST /brands/:id/scrape
// Returns 202 immediately — fire-and-forget. The scrape runs in the background.
// Clients should poll GET /brands/:id and check lastScrapeStatus !== 'RUNNING'.
router.post('/brands/:id/scrape', validateUuidParam('id'), async (req, res, next) => {
  try {
    const brand = await getBrandExpanded(req.params.id);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });
    // Manual refresh from the UI always bypasses the 12h cool-down. The user
    // explicitly clicked, so honor it. Background callers (cron, pending
    // sweep, boot scrape) don't pass force and get rate-limited.
    runBrandScrape({ brandId: req.params.id, trigger: 'MANUAL', force: true }).catch((err) =>
      console.error(`[brand-spy] manual scrape failed for ${req.params.id}:`, err),
    );
    res.status(202).json({ queued: true });
  } catch (err) { next(err); }
});

// DELETE /brands/:id
router.delete('/brands/:id', validateUuidParam('id'), async (req, res, next) => {
  try {
    const ok = await deleteBrand(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Brand not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

// GET /brands/:id/aggregation-counts — combined counts for Overview's 4
// mini-stat boxes (Hooks / Ad copy / Headlines / LPs). Replaces 4 parallel
// /aggregations?type=X&limit=1 calls with one round-trip + one in-memory pass.
router.get('/brands/:id/aggregation-counts', validateUuidParam('id'), async (req, res, next) => {
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
router.get('/brands/:id/intel', validateUuidParam('id'), async (req, res, next) => {
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

// GET /brands/:id/_diag/league-vs-fb
//
// One-shot verification: pulls the live impression-sorted Facebook Ad
// Library list for the brand (via ScrapeCreators, the same source the
// worker uses) and compares it to our stored league. Tells us whether
// the ads we're labelling BANGER / CHAMP / A actually are the brand's
// top-impression ads.
//
// Returns:
//   • fbTopN   — first N ad_archive_ids in FB Ad Library's impression order
//   • ourTopN  — our first N ads ordered by current_rank
//   • overlap  — how many of FB's top N appear in our top N (and at what tier)
//   • missing  — FB top N ad_archive_ids NOT in our DB at all
//   • extras   — our top N ad_archive_ids that fell OUT of FB's top N
//
// Costs ~3 ScrapeCreators credits per call (capped at maxPages=3, ~90 ads).
router.get('/brands/:id/_diag/league-vs-fb', validateUuidParam('id'), async (req, res, next) => {
  try {
    const brand = await getBrandExpanded(req.params.id);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    const topN = Math.min(90, Math.max(5, parseInt(String(req.query.topN ?? '30'), 10) || 30));
    const maxPages = Math.min(5, Math.max(1, parseInt(String(req.query.pages ?? '3'), 10) || 3));

    // Pull FB Ad Library's impression-sorted list.
    // The worker's Phase 1d uses the domain with the TLD stripped as the
    // search keyword ('thegreatproject' not 'thegreatproject.com'), because
    // ad link_urls rarely contain ".com" inside FB's search index. Mirror
    // that here so we compare against the same population the league was
    // built from.
    const rootFragment = brand.domain.replace(/\.[a-z]{2,}(\.[a-z]{2,})?$/, '');
    const sc = getScrapeCreatorsClient();
    const fbOrdered = []; // each entry: { adArchiveId, headline, bodyText, isActive, linkUrl }
    try {
      for await (const batch of sc.iterateAdsByDomain({
        domain: rootFragment,
        status: 'ACTIVE',
        country: 'US',
        maxPages,
      })) {
        for (const ad of batch) {
          fbOrdered.push({
            adArchiveId: String(ad.ad_archive_id),
            headline:    ad.snapshot?.title ?? null,
            bodyText:    ad.snapshot?.body?.text ?? null,
            isActive:    !!ad.is_active,
            linkUrl:     ad.snapshot?.link_url ?? null,
            pageName:    ad.snapshot?.page_name ?? null,
          });
          if (fbOrdered.length >= topN * 2) break;
        }
        if (fbOrdered.length >= topN * 2) break;
      }
    } catch (err) {
      return res.status(502).json({ error: `ScrapeCreators failed: ${err.message}` });
    }

    // Our top-N from the same brand.
    const ours = await listAds(req.params.id, {
      page: 1, pageSize: topN, sort: 'rank_asc', tier: 'ALL', status: 'ACTIVE',
    });
    const ourTopN = ours.ads.map((a) => ({
      adArchiveId: a.adArchiveId,
      currentRank: a.currentRank,
      metaRank:    a.metaRank,
      tier:        a.tier,
      headline:    a.headline,
      isActive:    a.isActive,
      pageName:    a.pageName,
    }));

    const fbTopN = fbOrdered.slice(0, topN);
    const fbSet  = new Set(fbTopN.map((x) => x.adArchiveId));
    const ourSet = new Set(ourTopN.map((x) => x.adArchiveId));

    // Set-overlap analysis.
    const inBoth   = [...fbSet].filter((id) => ourSet.has(id));
    const missing  = fbTopN.filter((x) => !ourSet.has(x.adArchiveId));
    const extras   = ourTopN.filter((x) => !fbSet.has(x.adArchiveId));

    // Rank-correlation: for each ad that's in BOTH top-Ns, what's the
    // |fb_position - our_position| delta? Lower = better alignment.
    const positionDeltas = [];
    for (const id of inBoth) {
      const fbIdx  = fbTopN.findIndex((x) => x.adArchiveId === id);
      const ourIdx = ourTopN.findIndex((x) => x.adArchiveId === id);
      positionDeltas.push({ adArchiveId: id, fb: fbIdx + 1, ours: ourIdx + 1, delta: Math.abs(fbIdx - ourIdx) });
    }
    positionDeltas.sort((a, b) => b.delta - a.delta);

    // Tier histogram for the ads that overlap.
    const tierOfOverlap = {};
    for (const id of inBoth) {
      const ourAd = ourTopN.find((x) => x.adArchiveId === id);
      const tier  = ourAd?.tier ?? 'NULL';
      tierOfOverlap[tier] = (tierOfOverlap[tier] ?? 0) + 1;
    }

    const meanDelta = positionDeltas.length
      ? positionDeltas.reduce((s, d) => s + d.delta, 0) / positionDeltas.length
      : null;

    res.json({
      brand: { id: brand.id, name: brand.name, domain: brand.domain },
      topN,
      summary: {
        fbCount: fbTopN.length,
        ourCount: ourTopN.length,
        overlap: inBoth.length,
        overlapPct: fbTopN.length ? +(100 * inBoth.length / fbTopN.length).toFixed(1) : null,
        missingFromOurDB: missing.filter((m) => !ours.ads.some((a) => a.adArchiveId === m.adArchiveId)).length,
        meanPositionDelta: meanDelta,
        tierOfOverlap,
      },
      fbTopN,
      ourTopN,
      positionDeltas,
      missing,
      extras,
    });
  } catch (err) { next(err); }
});

// GET /brands/:id/_diag/league-vs-fb-full
//
// Comprehensive validation: walks every known FB page for the brand and
// fetches that page's live ad library (sorted by impressions). Diffs the
// union against our full active set in DB. Surfaces:
//   • ads FB shows but we don't have (scrape gaps)
//   • ads we say "active" but FB no longer surfaces (stale is_active)
//   • how every BANGER / CHAMP / A in our league shows up on FB
//
// Query params:
//   • maxPagesPerFbPage — cursor-pages per FB page (default 2, max 5).
//     Each = 1 ScrapeCreators credit. With 16 brand pages * 2 = 32 credits.
//   • topBrandPages — limit how many FB pages to walk (default unlimited).
router.get('/brands/:id/_diag/league-vs-fb-full', validateUuidParam('id'), async (req, res, next) => {
  try {
    const brand = await getBrandExpanded(req.params.id);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    const maxPagesPerFb = Math.min(5, Math.max(1, parseInt(String(req.query.maxPagesPerFbPage ?? '2'), 10) || 2));
    const topBrandPages = parseInt(String(req.query.topBrandPages ?? ''), 10);
    const pages = (brand.pages ?? [])
      .filter((p) => p.metaPageId)
      .sort((a, b) => (b.adCount ?? 0) - (a.adCount ?? 0))
      .slice(0, Number.isFinite(topBrandPages) && topBrandPages > 0 ? topBrandPages : 999);

    const sc = getScrapeCreatorsClient();
    const fbByArchive = new Map(); // ad_archive_id → { adArchiveId, pageId, pageName, isActive, headline, linkUrl, firstSeenFbIdx }
    const fbPerPage = []; // [{ pageId, pageName, adsFetched, hasMore }]
    let creditsUsed = 0;

    for (const page of pages) {
      let fetched = 0;
      let hasMore = false;
      try {
        for await (const batch of sc.iterateCompanyAds({
          pageId: page.metaPageId,
          country: 'ALL',
          status: 'ACTIVE',
          maxPages: maxPagesPerFb,
        })) {
          creditsUsed += 1;
          for (const ad of batch) {
            const id = String(ad.ad_archive_id);
            if (!fbByArchive.has(id)) {
              fbByArchive.set(id, {
                adArchiveId: id,
                pageId:      page.metaPageId,
                pageName:    ad.snapshot?.page_name ?? page.pageName,
                isActive:    !!ad.is_active,
                headline:    ad.snapshot?.title ?? null,
                linkUrl:     ad.snapshot?.link_url ?? null,
                firstSeenFbIdx: fbByArchive.size,
              });
            }
            fetched += 1;
          }
        }
      } catch (err) {
        fbPerPage.push({ pageId: page.metaPageId, pageName: page.pageName, adsFetched: fetched, error: err.message });
        continue;
      }
      fbPerPage.push({ pageId: page.metaPageId, pageName: page.pageName, adsFetched: fetched, hasMore });
    }

    // Pull our full active set for this brand (up to 500 — large brands need
    // multiple pages but the cap covers thegreatproject's 313 in one shot).
    const ours = await listAds(req.params.id, {
      page: 1, pageSize: 100, sort: 'rank_asc', tier: 'ALL', status: 'ACTIVE',
    });
    // Pull additional pages if total exceeds 100.
    const ourActive = [...ours.ads];
    if (ours.total > 100) {
      const pagesToFetch = Math.ceil(ours.total / 100);
      for (let p = 2; p <= pagesToFetch && p <= 10; p++) {
        const next = await listAds(req.params.id, {
          page: p, pageSize: 100, sort: 'rank_asc', tier: 'ALL', status: 'ACTIVE',
        });
        ourActive.push(...next.ads);
      }
    }
    const ourByArchive = new Map(ourActive.map((a) => [a.adArchiveId, a]));

    const fbIds  = new Set(fbByArchive.keys());
    const ourIds = new Set(ourByArchive.keys());

    const overlap     = [...fbIds].filter((id) => ourIds.has(id));
    const fbOnly      = [...fbIds].filter((id) => !ourIds.has(id));
    const ourOnly     = [...ourIds].filter((id) => !fbIds.has(id));

    // Tier histogram for OUR active set.
    const tierTotals = {};
    for (const a of ourActive) {
      const t = a.tier ?? 'NULL';
      tierTotals[t] = (tierTotals[t] ?? 0) + 1;
    }

    // Tier histogram for ourOnly (= what we think is active but FB doesn't surface).
    const tierStale = {};
    for (const id of ourOnly) {
      const t = ourByArchive.get(id)?.tier ?? 'NULL';
      tierStale[t] = (tierStale[t] ?? 0) + 1;
    }

    // Tier histogram for overlap (= what FB confirms).
    const tierVerified = {};
    for (const id of overlap) {
      const t = ourByArchive.get(id)?.tier ?? 'NULL';
      tierVerified[t] = (tierVerified[t] ?? 0) + 1;
    }

    // BANGER / CHAMP / A verification — exactly which of these tiers
    // FB confirms as currently active.
    const tierVerificationDetail = {};
    for (const tier of ['BANGER', 'CHAMP', 'A']) {
      const ads = ourActive.filter((a) => a.tier === tier);
      const verified = ads.filter((a) => fbIds.has(a.adArchiveId));
      tierVerificationDetail[tier] = {
        total: ads.length,
        verified: verified.length,
        verifiedPct: ads.length ? +(100 * verified.length / ads.length).toFixed(1) : null,
        unverifiedSample: ads
          .filter((a) => !fbIds.has(a.adArchiveId))
          .slice(0, 5)
          .map((a) => ({
            adArchiveId: a.adArchiveId,
            currentRank: a.currentRank,
            metaRank:    a.metaRank,
            headline:    a.headline,
            lastSeenAt:  a.lastSeenAt,
            pageName:    a.pageName,
          })),
      };
    }

    res.json({
      brand: { id: brand.id, name: brand.name, domain: brand.domain, pages: pages.length },
      creditsUsed,
      fbPerPage,
      summary: {
        fbActiveTotal:  fbIds.size,
        ourActiveTotal: ourIds.size,
        overlap:        overlap.length,
        overlapPct:     fbIds.size ? +(100 * overlap.length / fbIds.size).toFixed(1) : null,
        fbOnly:         fbOnly.length,    // we're missing these
        ourOnly:        ourOnly.length,   // we say active, FB says no
        tierTotals,
        tierVerified,
        tierStale,
        tierVerificationDetail,
      },
      // Trimmed samples — full lists are huge for many-page brands.
      fbOnlySample:  fbOnly.slice(0, 10).map((id) => fbByArchive.get(id)),
      ourOnlySample: ourOnly.slice(0, 10).map((id) => {
        const a = ourByArchive.get(id);
        return a && {
          adArchiveId: a.adArchiveId, currentRank: a.currentRank, metaRank: a.metaRank,
          tier: a.tier, headline: a.headline, lastSeenAt: a.lastSeenAt, pageName: a.pageName,
        };
      }),
    });
  } catch (err) { next(err); }
});

// GET /ads/:id
router.get('/ads/:id', validateUuidParam('id'), async (req, res, next) => {
  try {
    const ad = await getAdDetail(req.params.id);
    if (!ad) return res.status(404).json({ error: 'Ad not found' });
    res.json({ ad });
  } catch (err) { next(err); }
});

// POST /ads/:id/transcribe — Whisper transcript with DB cache + mutex.
// Returns { transcript, segments, cached, transcriptAt }. `cached: true`
// means we returned a previously stored transcript without hitting OpenAI.
router.post('/ads/:id/transcribe', validateUuidParam('id'), async (req, res, next) => {
  try {
    const adId = req.params.id;
    const ad = await getAdDetail(adId);
    if (!ad) return res.status(404).json({ error: 'Ad not found' });

    if (ad.transcript) {
      return res.json({
        transcript: ad.transcript,
        segments:   ad.transcriptSegments ?? [],
        cached:     true,
        transcriptAt: ad.transcriptAt,
      });
    }
    if (!ad.videoUrl) {
      return res.status(400).json({
        error: 'This ad has no video to transcribe',
        reason: 'NO_VIDEO_URL',
      });
    }

    // Mutex — if another request is already transcribing this ad, await it
    // instead of starting a duplicate Whisper call.
    let inflight = transcribeInFlight.get(adId);
    if (!inflight) {
      inflight = (async () => {
        let transcription;
        try {
          transcription = await transcribeVideoUrl(ad.videoUrl);
        } catch (err) {
          // Stored fbcdn URL expired (403 etc.) — the ad may still be live
          // in the FB Ad Library. Pull a fresh URL via yt-dlp and retry once.
          const archiveId = ad.adArchiveId || ad.ad_archive_id;
          const fresh = archiveId ? await extractFreshVideoUrl(adLibraryUrl(archiveId)) : null;
          if (!fresh) throw err;
          console.log(`[brand-spy] transcribe: stored URL dead (${err.message}) — retrying with fresh yt-dlp URL for ad ${adId}`);
          transcription = await transcribeVideoUrl(fresh);
        }
        const { text, segments } = transcription;
        const { rows } = await pgQuery(
          `UPDATE brand_spy.ads
              SET transcript = $1, transcript_segments = $2, transcript_at = NOW()
            WHERE id = $3
            RETURNING transcript_at`,
          [text, JSON.stringify(segments), adId],
        );
        return {
          transcript: text,
          segments,
          cached: false,
          transcriptAt: rows[0]?.transcript_at?.toISOString() ?? new Date().toISOString(),
        };
      })().finally(() => transcribeInFlight.delete(adId));
      transcribeInFlight.set(adId, inflight);
    }
    const result = await inflight;
    // Callers piggybacked on an in-flight request still see cached:false (we
    // did pay OpenAI for it — once — and they're getting the fresh result),
    // but the second physical caller didn't trigger a second Whisper call.
    res.json(result);
  } catch (err) { next(err); }
});

// POST /ads/:id/fresh-video-url — the stored fbcdn video URL has expired;
// re-extract a live one from the ad's FB Ad Library page via yt-dlp.
// Returns { videoUrl } or 404 if the ad is gone from the library.
// Takes 10-45s (yt-dlp) — the frontend shows a refreshing state.
router.post('/ads/:id/fresh-video-url', validateUuidParam('id'), async (req, res, next) => {
  try {
    const ad = await getAdDetail(req.params.id);
    if (!ad) return res.status(404).json({ error: 'Ad not found' });
    const archiveId = ad.adArchiveId || ad.ad_archive_id;
    if (!archiveId) return res.status(400).json({ error: 'Ad has no ad_archive_id to re-extract from' });
    const fresh = await extractFreshVideoUrl(adLibraryUrl(archiveId));
    if (!fresh) {
      return res.status(404).json({ error: 'Could not extract a fresh video URL — the ad may no longer be live in the FB Ad Library' });
    }
    res.json({ videoUrl: fresh });
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

  // Pending sweep — every 15 min, look for brands that never finished a
  // successful scrape (last_scrape_status NULL or 'OUT_OF_CREDITS') and
  // re-queue them. This means the user follows a brand, watches credits
  // arrive, and the next sweep auto-runs the scrape — no manual Refresh.
  // Cheap when there's nothing to do (one indexed SELECT) and bounded by
  // the ScrapeCreators pre-flight credit check.
  const PENDING_SWEEP_MS = 15 * 60 * 1000;
  const pendingSweep = async () => {
    try {
      const { rows } = await pgQuery(
        `SELECT id FROM brand_spy.brands
          WHERE last_scrape_status IS NULL
             OR last_scrape_status = 'OUT_OF_CREDITS'`,
      );
      if (!rows.length) return;
      console.log(`[brand-spy] pending sweep: ${rows.length} brand(s) waiting on credits — attempting`);
      await scrapeAllInBackground(rows.map((r) => r.id));
    } catch (err) {
      console.error('[brand-spy] pending sweep error:', err.message);
    }
  };
  setTimeout(pendingSweep, 60 * 1000);            // first sweep 1 min after boot
  setInterval(pendingSweep, PENDING_SWEEP_MS);    // then every 15 min

  console.log('[brand-spy] auto-scrape scheduled (boot +5min, then every 24h); pending-sweep every 15 min; recovery check running immediately');
}

scheduleDailyScrape();
startMediaMirrorWorker();

export default router;
