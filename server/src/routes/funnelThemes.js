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
//     first, which is precisely the bug that queue was built to close. The
//     client re-derives the destructive diff against the FRESH row at commit
//     (M1 — see themePlan.js), so a plan left open in a modal can never commit
//     a stale overwrite.
//
//  2. IMPORT-URL IS SSRF-GUARDED WITH A PINNED IP. The reference has no guard
//     at all: it accepts http://, follows redirects, and returns the raw
//     connection error, together a working blind-SSRF oracle. We resolve the
//     host ONCE, validate every answer (incl. NAT64 / 6to4 tunnels), and
//     connect to the PINNED address so fetch cannot re-resolve to a private IP
//     (themeImportGuard.js). Redirects are refused, the body is capped, and the
//     route is rate-limited — it is the only outbound-fetching door in the lane.
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
import { checkRateLimit } from '../middleware/rateLimiter.js';
import { pgQuery } from '../db/pg.js';
import { ensureFunnelThemesTables } from '../services/funnelThemesSchema.js';
import { safeFetchHtml, ImportGuardError } from '../services/themeImportGuard.js';
import {
  DEFAULT_WORKSPACE, TOKEN_KEYS, TOKEN_DEFAULTS, TOKEN_SUPPORT, ThemeError,
  listPresets, getPreset, sanitizeTokens, sanitizeName, sanitizeUrl,
  buildApplyPlan, buildDraftFromHtml,
} from '../services/funnelThemes.js';

const router = Router();
router.use(authenticate, requirePermission('funnels', 'access'));

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

// The honest per-VALUE support summary for a token bag. Cards and grids read
// THIS (via each theme's plan_preview), never the static per-KEY TOKEN_SUPPORT
// map — because whether a token reaches the page is per-value: editorial's
// font_body is 'partial' as a KEY but resolves to nothing for THAT stack, so it
// must count as not-applied for editorial specifically (M4).
const previewOf = (tokens) => buildApplyPlan(tokens && typeof tokens === 'object' ? tokens : {}, {});

// A name may be omitted (partial PATCH) but if present it must be a string — a
// non-string used to be silently coerced to 'Untitled theme' and 200'd (m3).
function requireStringNameIfPresent(body) {
  if (body.name !== undefined && typeof body.name !== 'string') throw new ThemeError('name_must_be_string');
}

// postgres.js returns JSONB as a parsed object already; the guard on `tokens`
// is for a row written before the NOT NULL default (there are none, but a read
// that assumes shape is how a null becomes a 500).
const rowOut = (r) => {
  const tokens = r.tokens && typeof r.tokens === 'object' ? r.tokens : {};
  return {
    id: r.id,
    name: r.name,
    tokens,
    preview_url: r.preview_url || '',
    imported_from: r.imported_from || '',
    is_preset: false,
    plan_preview: previewOf(tokens),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
};

// ── GET /presets — the seeded library + the honest token map ────────────────
// Registered BEFORE the ensure-tables middleware: presets are in-memory
// constants, so listing them must never depend on the database (NIT). Each
// preset carries its own plan_preview so a gallery card can show the true
// "N of 11 reach the page" without a second round-trip.
router.get('/presets', guard('presets', async (req, res) => {
  res.json({
    success: true,
    data: {
      presets: listPresets().map((p) => ({ ...p, plan_preview: previewOf(p.tokens) })),
      token_keys: TOKEN_KEYS,
      token_defaults: TOKEN_DEFAULTS,
      token_support: TOKEN_SUPPORT,
    },
  });
}));

// Everything past here touches lb_funnel_themes, so ensure the table first.
router.use(async (req, res, next) => {
  try {
    await ensureFunnelThemesTables();
    next();
  } catch (err) {
    next(err);
  }
});

// ── GET / — saved themes, newest first ─────────────────────────────────────
// LIMIT 201 so a workspace that has grown past the display cap is SIGNALLED
// (truncated:true) rather than silently dropping the overflow (m2).
const LIST_CAP = 200;
router.get('/', guard('list', async (req, res) => {
  const rows = await pgQuery(
    `SELECT * FROM lb_funnel_themes
      WHERE workspace_id = $1 AND archived = FALSE
      ORDER BY updated_at DESC
      LIMIT ${LIST_CAP + 1}`,
    [DEFAULT_WORKSPACE],
  );
  const truncated = rows.length > LIST_CAP;
  res.json({ success: true, data: { themes: rows.slice(0, LIST_CAP).map(rowOut), truncated } });
}));

// ── POST / — create ────────────────────────────────────────────────────────
// Also the save door for an import draft: the client POSTs the draft back with
// an operator-chosen name, exactly as the reference intends.
router.post('/', guard('create', async (req, res) => {
  const body = req.body || {};
  requireStringNameIfPresent(body);
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
  requireStringNameIfPresent(body);
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
// The client renders the plan as the confirm dialog, and at COMMIT re-derives
// the destructive diff against the fresh funnel row (M1) so a stale plan can
// never overwrite a value the dialog didn't show.
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
    requireStringNameIfPresent(body);
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
const IMPORT_RATE_MAX = 20;               // fetches per window, per operator
const IMPORT_RATE_WINDOW_SEC = 60;

// Injectable for the harness (assert the rate-limit refusal without hammering
// a shared limiter). Mirrors the aiMedia _hooks pattern.
export const _hooks = { checkRateLimit, safeFetchHtml };

const importRefusal = (res, code, message) =>
  res.status(422).json({ success: false, error: { code, message } });

router.post('/import-url', guard('import-url', async (req, res) => {
  const raw = String((req.body || {}).url || '').trim();
  if (!raw) throw new ThemeError('url_required');

  // SCHEME (m1). If the operator typed an explicit scheme that is not http(s),
  // REFUSE it — do not rewrite `file:///etc/passwd` into a bogus
  // `https://file:///etc/passwd`. A bare host (no scheme) is upgraded to https.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
  if (hasScheme && !/^https?:\/\//i.test(raw)) {
    return importRefusal(res, 'url_not_allowed', 'That URL could not be fetched. Public https pages only.');
  }
  const url = hasScheme ? raw : `https://${raw}`;

  // RATE LIMIT (M2). This is the lane's only route that makes an outbound
  // request; without a cap it is a fetch amplifier. checkRateLimit increments
  // per call (aiMedia pattern).
  const who = userId(req) || 'anon';
  const rl = await _hooks.checkRateLimit(`theme-import:${who}`, IMPORT_RATE_MAX, IMPORT_RATE_WINDOW_SEC);
  if (!rl.allowed) {
    res.set('Retry-After', String(rl.retryAfter || IMPORT_RATE_WINDOW_SEC));
    return res.status(429).json({
      success: false,
      error: { code: 'rate_limited', message: 'Too many imports — try again shortly.' },
    });
  }

  // THE FETCH. safeFetchHtml resolves the host ONCE, validates every answer
  // (private / loopback / link-local / CGNAT / NAT64 / 6to4 all refused), pins
  // the address, and connects to the pin so there is no re-resolution window
  // (B1 / M5). https only; redirects refused; body capped.
  let result;
  try {
    result = await _hooks.safeFetchHtml(url, { maxBytes: IMPORT_BYTES_MAX, timeoutMs: IMPORT_TIMEOUT_MS });
  } catch (err) {
    // One coarse class per failure reason. The reference returns str(exc),
    // which turns the endpoint into a blind-SSRF oracle (ECONNREFUSED vs
    // EHOSTUNREACH vs timeout maps the internal network). The operator gets the
    // actionable half; the detail stays in the log.
    if (err instanceof ImportGuardError) {
      const code = err.code === 'redirect' ? 'url_redirected'
        : err.code === 'not_html' ? 'not_html'
          : (err.code === 'scheme' || err.code === 'blocked') ? 'url_not_allowed'
            : 'fetch_failed';
      const message = code === 'url_not_allowed' ? 'That URL could not be fetched. Public https pages only.'
        : code === 'url_redirected' ? 'That URL redirects. Enter the final page URL directly.'
          : code === 'not_html' ? 'That URL is not an HTML page.'
            : 'That page could not be fetched.';
      console.warn(`[funnelThemes] import-url refused (${err.code})`);
      return importRefusal(res, code, message);
    }
    console.warn('[funnelThemes] import-url fetch failed:', err && err.message);
    return importRefusal(res, 'fetch_failed', 'That page could not be fetched.');
  }

  const draft = buildDraftFromHtml(result.body, url);
  // The draft rides next to what applying it would actually do (plan_preview),
  // so the operator never saves a theme believing it carries more than it does.
  // `truncated` tells the UI the page was longer than the read cap.
  res.json({
    success: true,
    data: { draft, plan_preview: buildApplyPlan(draft.tokens, {}), truncated: result.truncated === true },
  });
}));

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
