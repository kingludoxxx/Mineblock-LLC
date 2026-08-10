// THEME SYSTEM — authed operator surface over funnelThemes.js.
//
// Mount (integrator-owned, routes/index.js):
//   app.use('/api/v1/funnel-themes', funnelThemesRoutes);
//
// Port of funnel-os's /themes* endpoints (routers/listicle_builders.py
// :6713-6875), with three deliberate departures:
//
//  1. THERE IS NO SERVER-SIDE APPLY WRITE. The reference's
//     POST /websites/{wid}/apply-theme writes the site document itself. Ours
//     answers POST /apply-plan with a PLAN and writes nothing. funnels.settings
//     is a whole-object PATCH, so every writer must go through the client's one
//     serialized read-merge-write queue (enqueueSettingsSave → saveFunnelPatch);
//     a second server-side door would be a second read-modify-write racing the
//     first, which is precisely the bug that queue was built to close.
//
//  2. IMPORT-URL IS SSRF-GUARDED. The reference has no guard at all: it accepts
//     http://, follows redirects, and returns the raw connection error, which
//     together are a working blind-SSRF oracle against the metadata service.
//     We reuse trackingDelivery.endpointAllowed — the same DNS-resolving,
//     fail-closed guard the postback lane uses — plus redirect:'manual', a body
//     cap, and a fixed error code.
//
//  3. THEME A/B IS OUT OF SCOPE for this lane and is NOT stubbed. See the
//     block above the router export.
//
// Same guard as the other funnel surfaces: authenticate +
// requirePermission('funnels','access'). Services LET IT THROW; this file is
// the boundary that maps ThemeError → 4xx and everything else → 500.
import { Router } from 'express';
import { randomUUID } from 'crypto';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { pgQuery } from '../db/pg.js';
import { ensureFunnelThemesTables } from '../services/funnelThemesSchema.js';
import { endpointAllowed } from '../services/trackingDelivery.js';
import {
  DEFAULT_WORKSPACE, TOKEN_KEYS, TOKEN_DEFAULTS, TOKEN_SUPPORT, ThemeError,
  listPresets, getPreset, sanitizeTokens, sanitizeName, sanitizeUrl,
  buildApplyPlan, buildDraftFromHtml,
} from '../services/funnelThemes.js';

const router = Router();
router.use(authenticate, requirePermission('funnels', 'access'));

router.use(async (req, res, next) => {
  try {
    await ensureFunnelThemesTables();
    next();
  } catch (err) {
    next(err);
  }
});

const NOT_FOUND_CODES = new Set(['theme_not_found', 'funnel_not_found']);

const guard = (name, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof ThemeError) {
      const status = NOT_FOUND_CODES.has(err.code) ? 404 : 422;
      return res.status(status).json({ success: false, error: { code: err.code } });
    }
    console.error(`[funnelThemes] ${name} failed:`, err && err.message ? err.message : err);
    return res.status(500).json({ success: false, error: { code: 'internal_error' } });
  }
};

const userId = (req) => String((req.user && (req.user.email || req.user.id)) || '');
const themeId = () => `thm_${randomUUID().replace(/-/g, '').slice(0, 10)}`;

// postgres.js returns JSONB as a parsed object already; the COALESCE is for a
// row written before the NOT NULL default (there are none, but a read that
// assumes shape is how a null becomes a 500).
const rowOut = (r) => ({
  id: r.id,
  name: r.name,
  tokens: r.tokens && typeof r.tokens === 'object' ? r.tokens : {},
  preview_url: r.preview_url || '',
  imported_from: r.imported_from || '',
  is_preset: false,
  created_at: r.created_at,
  updated_at: r.updated_at,
});

// ── GET /presets — the seeded library + the honest token map ────────────────
// TOKEN_SUPPORT rides along on purpose: the Themes section renders "what this
// actually changes" straight from the server's own map rather than keeping a
// second copy that can drift out of agreement with the renderer.
router.get('/presets', guard('presets', async (req, res) => {
  res.json({
    success: true,
    data: {
      presets: listPresets(),
      token_keys: TOKEN_KEYS,
      token_defaults: TOKEN_DEFAULTS,
      token_support: TOKEN_SUPPORT,
    },
  });
}));

// ── GET / — saved themes, newest first ─────────────────────────────────────
router.get('/', guard('list', async (req, res) => {
  const rows = await pgQuery(
    `SELECT * FROM lb_funnel_themes
      WHERE workspace_id = $1 AND archived = FALSE
      ORDER BY updated_at DESC
      LIMIT 200`,
    [DEFAULT_WORKSPACE],
  );
  res.json({ success: true, data: { themes: rows.map(rowOut) } });
}));

// ── POST / — create ────────────────────────────────────────────────────────
// Also the save door for an import draft: the client POSTs the draft back with
// an operator-chosen name, exactly as the reference intends.
router.post('/', guard('create', async (req, res) => {
  const body = req.body || {};
  const tokens = sanitizeTokens(body.tokens);
  const rows = await pgQuery(
    `INSERT INTO lb_funnel_themes
       (id, workspace_id, name, tokens, preview_url, imported_from, created_by)
     VALUES ($1, $2, $3, $4::text::jsonb, $5, $6, $7)
     RETURNING *`,
    [
      themeId(), DEFAULT_WORKSPACE, sanitizeName(body.name),
      // jsonb discipline (aiDeveloperSchema.js:361): `$N::text::jsonb`, never a
      // bare `::jsonb` — postgres.js infers from the cast and a bare one stores
      // a jsonb STRING, so tokens->>'primary' would read NULL forever.
      JSON.stringify(tokens),
      sanitizeUrl(body.preview_url), sanitizeUrl(body.imported_from), userId(req),
    ],
  );
  res.status(201).json({ success: true, data: { theme: rowOut(rows[0]) } });
}));

// ── PATCH /:id — rename / retune ───────────────────────────────────────────
// Partial: an absent field is left alone. The reference's PATCH overwrites
// name+tokens wholesale, which turns a rename into a token wipe.
router.patch('/:id', guard('update', async (req, res) => {
  const body = req.body || {};
  const sets = ['updated_at = NOW()'];
  const params = [];
  let i = 1;
  if (body.name !== undefined) { sets.push(`name = $${i++}`); params.push(sanitizeName(body.name)); }
  if (body.tokens !== undefined) { sets.push(`tokens = $${i++}::text::jsonb`); params.push(JSON.stringify(sanitizeTokens(body.tokens))); }
  if (body.preview_url !== undefined) { sets.push(`preview_url = $${i++}`); params.push(sanitizeUrl(body.preview_url)); }

  const rows = await pgQuery(
    `UPDATE lb_funnel_themes SET ${sets.join(', ')}
      WHERE id = $${i++} AND workspace_id = $${i++} AND archived = FALSE
      RETURNING *`,
    [...params, String(req.params.id), DEFAULT_WORKSPACE],
  );
  if (!rows.length) throw new ThemeError('theme_not_found');
  res.json({ success: true, data: { theme: rowOut(rows[0]) } });
}));

// ── DELETE /:id — soft archive ─────────────────────────────────────────────
// 404s on a miss, unlike the reference's unconditional {"ok": true} — an
// operator deleting a theme that is already gone should learn that.
router.delete('/:id', guard('remove', async (req, res) => {
  const rows = await pgQuery(
    `UPDATE lb_funnel_themes SET archived = TRUE, updated_at = NOW()
      WHERE id = $1 AND workspace_id = $2 AND archived = FALSE
      RETURNING id`,
    [String(req.params.id), DEFAULT_WORKSPACE],
  );
  if (!rows.length) throw new ThemeError('theme_not_found');
  res.json({ success: true, data: { id: rows[0].id } });
}));

// ── POST /apply-plan — what applying this theme would change ───────────────
// { funnel_id, theme_id? | preset_slug? | tokens? } → the plan. WRITES NOTHING.
// The client renders the plan as the confirm dialog and then applies
// plan.writes inside saveFunnelPatch.
router.post('/apply-plan', guard('apply-plan', async (req, res) => {
  const body = req.body || {};
  const funnelId = String(body.funnel_id || '');
  if (!funnelId) throw new ThemeError('funnel_id_required');

  const fRows = await pgQuery(`SELECT id, name, settings FROM funnels WHERE id = $1`, [funnelId]);
  if (!fRows.length) throw new ThemeError('funnel_not_found');

  // Resolution order is preset FIRST, then saved theme — the reverse of the
  // reference, which tries theme_id first and silently falls through to
  // preset_slug when the id misses. A miss must be a miss, not a substitution.
  let source = null;
  let tokens = null;
  if (body.preset_slug) {
    const p = getPreset(String(body.preset_slug));
    if (!p) throw new ThemeError('theme_not_found');
    source = { kind: 'preset', id: p.id, name: p.name };
    tokens = p.tokens;
  } else if (body.theme_id) {
    const rows = await pgQuery(
      `SELECT * FROM lb_funnel_themes WHERE id = $1 AND workspace_id = $2 AND archived = FALSE`,
      [String(body.theme_id), DEFAULT_WORKSPACE],
    );
    if (!rows.length) throw new ThemeError('theme_not_found');
    source = { kind: 'theme', id: rows[0].id, name: rows[0].name };
    tokens = rows[0].tokens || {};
  } else if (body.tokens !== undefined) {
    source = { kind: 'draft', id: null, name: sanitizeName(body.name) };
    tokens = sanitizeTokens(body.tokens);
  } else {
    throw new ThemeError('theme_id_or_preset_slug_or_tokens_required');
  }

  const settings = fRows[0].settings && typeof fRows[0].settings === 'object' ? fRows[0].settings : {};
  const plan = buildApplyPlan(tokens, settings);
  res.json({ success: true, data: { source, funnel: { id: fRows[0].id, name: fRows[0].name }, plan } });
}));

// ── POST /import-url — propose a theme draft from a live page ──────────────
// Persists NOTHING. The operator names the draft and POSTs it to `/`.
const IMPORT_TIMEOUT_MS = 15_000;
const IMPORT_BYTES_MAX = 2 * 1024 * 1024; // 2MB of HTML is far past any real <head>

router.post('/import-url', guard('import-url', async (req, res) => {
  const raw = String((req.body || {}).url || '').trim();
  if (!raw) throw new ThemeError('url_required');
  // Bare-host convenience, same as the reference — but https, never http.
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

  // THE GUARD, IN TWO PARTS.
  //
  // PART 1 — https-only, checked HERE and not delegated. endpointAllowed has a
  // deliberate escape hatch for its own caller: when NODE_ENV !== 'production'
  // it ALLOWS http://localhost, http://127.0.0.1 and http://[::1] so a
  // developer can point a postback at a loopback relay. That is right for the
  // tracking lane and wrong for this one — import-url takes an OPERATOR-SUPPLIED
  // url, so inheriting that hatch makes `http://127.0.0.1:5433/` a working
  // request against the local Postgres in every dev and staging environment.
  // Caught by execution: the SSRF block below failed on exactly that target
  // until this pre-check existed. A shared guard's exceptions belong to the
  // caller that asked for them.
  //
  // PART 2 — endpointAllowed: literal-IP check, DNS resolution, and every
  // resolved answer required to be public unicast, failing CLOSED on a
  // resolution error. Reached only once the scheme is already https.
  let scheme = '';
  try { scheme = new URL(url).protocol; } catch { scheme = ''; }
  const verdict = scheme === 'https:' ? await endpointAllowed(url) : 'scheme';
  if (verdict !== true) {
    // One fixed code for every refusal reason. The reference returns the raw
    // exception text, which turns the endpoint into a blind-SSRF oracle:
    // ECONNREFUSED vs EHOSTUNREACH vs a timeout maps out an internal network.
    // The operator gets the actionable half; the class stays in the log.
    console.warn(`[funnelThemes] import-url refused (${verdict})`);
    return res.status(422).json({
      success: false,
      error: {
        code: 'url_not_allowed',
        message: 'That URL could not be fetched. Public https pages only.',
      },
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMPORT_TIMEOUT_MS);
  if (timer.unref) timer.unref();
  let html = '';
  try {
    const resp = await fetch(url, {
      // redirect:'manual' — a 302 from a validated host to an unvalidated one
      // walks straight past the guard. The reference follows redirects, which
      // is the hole that makes its guardlessness exploitable from a public URL.
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (resp.status >= 300 && resp.status < 400) {
      return res.status(422).json({
        success: false,
        error: { code: 'url_redirected', message: 'That URL redirects. Enter the final page URL directly.' },
      });
    }
    if (!resp.ok) {
      return res.status(422).json({
        success: false,
        error: { code: 'fetch_failed', message: `The page answered ${resp.status}.` },
      });
    }
    const ctype = String(resp.headers.get('content-type') || '');
    if (ctype && !/text\/html|application\/xhtml|text\/plain/i.test(ctype)) {
      return res.status(422).json({
        success: false,
        error: { code: 'not_html', message: 'That URL is not an HTML page.' },
      });
    }
    // Bounded read. `resp.text()` on an endless body is an OOM, and neither a
    // Content-Length header nor a content-type is trustworthy enough to skip
    // counting the bytes that actually arrive.
    html = await readCapped(resp, IMPORT_BYTES_MAX);
  } catch (err) {
    console.warn('[funnelThemes] import-url fetch failed:', err && err.name === 'AbortError' ? 'timeout' : (err && err.message));
    return res.status(422).json({
      success: false,
      error: { code: 'fetch_failed', message: 'That page could not be fetched.' },
    });
  } finally {
    clearTimeout(timer);
  }

  const draft = buildDraftFromHtml(html, url);
  // The draft is shown next to what applying it would actually do, so the
  // operator never saves a theme believing it carries more than it does.
  res.json({ success: true, data: { draft, plan_preview: buildApplyPlan(draft.tokens, {}) } });
}));

async function readCapped(resp, maxBytes) {
  if (!resp.body || typeof resp.body.getReader !== 'function') {
    const text = await resp.text();
    return text.slice(0, maxBytes);
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) { chunks.push(value); try { await reader.cancel(); } catch { /* already closed */ } break; }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, maxBytes).toString('utf8');
}

// ── THEME A/B — DELIBERATELY NOT BUILT ─────────────────────────────────────
// The reference ships POST /websites/{wid}/theme-ab: a sticky per-site cookie
// picks arm A or B at render time and merges that arm's tokens over the site
// theme. Porting it here is a RENDERER change (the arm has to be resolved
// per-request, before the head is emitted) and a SPLIT-MACHINERY change (this
// install already has a split-test lane with its own assignment, ledger and
// results endpoints at /api/v1/split-tests).
//
// Wiring themes into THAT lane's arms is the right shape. Standing up a second,
// cookie-based assignment path beside it would give the install two
// disagreeing sources of truth for which visitor saw which variant — and the
// reference's version has no results endpoint at all, so it could not even
// answer which theme won. A half-built A/B that assigns traffic it cannot
// score is worse than none.
//
// Out of scope for this lane, on purpose. No stub, no dead column, no toggle
// that does nothing.

export default router;
