// FUNNEL TRANSFER — portable export / import of a funnel and its pages.
//
// Ported from funnel-os's `funnel_transfer_service.py` (the "bundle" feature:
// GET /websites/{wid}/export + POST /websites/import). The SHAPE of the idea is
// the same — one JSON document that recreates a funnel somewhere else — but four
// of funnel-os's decisions are deliberately REVERSED here, because each one is a
// defect this port is not obliged to inherit:
//
//   1. funnel-os bundles SECRETS VERBATIM ("product decision": the whole
//      lb_websites row rides along, including payments.stripe.secret_key, and
//      every referenced store document with its Whop/Shopify tokens). This port
//      ships an ALLOWLIST (SETTINGS_ALLOWLIST below). A key that is not named
//      there does not travel — including a key added to `funnels.settings`
//      tomorrow by a lane that never read this file. Blocklisting would have
//      failed exactly then.
//   2. funnel-os keeps SOURCE IDS in the bundle and remaps them on import by
//      string-replacing them through the serialized JSON. This port emits NO
//      ids at all. The canvas flow is carried as ARRAY INDICES into `pages`
//      (see `flow`), which is the only id-free way to preserve the graph.
//   3. funnel-os has NO caps — `.to_list(1000)` silently truncates the export
//      and the import accepts any size. This port refuses (413) past explicit
//      caps and never truncates silently.
//   4. funnel-os's import is "atomically-ish" (its own comment): a failure
//      between its delete_many and its insert_many leaves a live funnel with
//      zero pages. This port writes the funnel AND every page in ONE
//      transaction (pgClient.begin), the same posture as
//      services/domainHub/attachService.js reassignDomain.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT TRAVELS
//   funnel   — name, slug, allowlisted settings, allowlisted seo
//   pages    — title, slug, type, is_home, status, blocks, allowlisted seo,
//              custom_html / custom_css / custom_js / head_html / body_end_html
//   flow     — the canvas graph, as ARRAY INDICES into `pages` (never ids)
//   redirects— funnel-relative (from_path, to_path, match, code, enabled) tuples
//   warnings — what code this file carries, so the SENDER is told before the
//              file is written, not just the receiver after it lands
//
// WHAT NEVER TRAVELS: row ids, funnel_id, custom_domain (funnel or page),
// default_page_id, `misc`, timestamps, split tests, any settings key outside
// the allowlist, and the `stripped` list itself (it names where THIS
// deployment keeps its credentials — it goes in the HTTP response, not the
// file). An imported funnel is ALWAYS a draft with no domain attached, so
// nothing it carries can serve before an operator looks at it (the public gate
// is funnelPublic.js:136, `funnel.status !== 'published'`).
// ─────────────────────────────────────────────────────────────────────────────
import { randomBytes } from 'crypto';
import { pgQuery, client as pgClient } from '../db/pg.js';
// The SAME gate PATCH /funnels/:id/pages/:pageId uses on blocks (funnels.js:1115).
// Imported blocks are operator-authored JSON from an untrusted file — the exact
// payload the public renderer will walk — so they go through the identical
// validator rather than a second, drifting copy of it.
// validateFunnelSettings is the SAME gate PATCH /funnels/:id applies to the
// settings blob (funnels.js:468). Review HIGH #1: without it, an import could
// land a settings object the settings modal can no longer PATCH — the funnel
// became permanently unsaveable from its own UI, and every GET /funnels paid
// for the bloat. The allowlist decides WHICH keys travel; this decides whether
// what travelled is still writable.
import { validateBlocks, validateFunnelSettings, ensureTables } from '../routes/funnels.js';

export const FORMAT_TAG = 'puure-funnel-v1';

// ── Caps ───────────────────────────────────────────────────────────────────
// Past any of these the answer is 413 and NOTHING is written. The per-page
// blocks cap is the same 2MB funnels.js enforces on a single PATCH; the total
// cap bounds what one request can ask the transaction to hold.
export const MAX_PAGES = 100;
export const MAX_BLOCKS_BYTES_PER_PAGE = 2 * 1024 * 1024; // 2MB
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024; // 20MB
export const MAX_REDIRECTS = 500;

// ⚠️ MIRRORED CONSTANTS, NOT IMPORTED ONES. funnels.js keeps FLOW_MAX_NODES /
// FLOW_MAX_EDGES / validateFlow module-private (funnels.js:548-552) and this
// task's change fence does not admit that file, so the caps are restated here.
// THE GAP IS REAL: if funnels.js lowers its caps, this file will not follow.
// It is covered the only way that actually proves anything — the harness feeds
// the flow layout this module STORED back through the REAL
// PATCH /api/v1/funnels/:id/flow endpoint and requires a 200. That is a
// round trip through the genuine validateFlow, not through a copy of it.
// To close the gap properly, export both constants and validateFlow from
// funnels.js and import them here.
const FLOW_MAX_NODES = 1000;
const FLOW_MAX_EDGES = 2000;

const UNIQUE_VIOLATION = '23505';
const genId = (prefix) => `${prefix}_${randomBytes(7).toString('hex')}`; // matches funnels.js
const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');

// ── THE SETTINGS ALLOWLIST ─────────────────────────────────────────────────
//
// `funnels.settings` is an OPEN operator blob (funnels.js validateFunnelSettings
// bounds its SIZE, not its KEYS), and it already carries at least one live
// credential: `settings.checkout.maps_api_key`, the Google Maps key the address
// autocomplete script embeds (funnelRender.js:2708, written by
// settings/sections.jsx:151). A top-level allowlist would have passed `checkout`
// wholesale and shipped that key. So the allowlist is NESTED: a nested entry
// names its own permitted sub-keys and everything else under it is dropped.
//
// Every key here, and why it is safe to carry:
//   logo_url             — a public asset URL rendered on the page.
//   description          — operator prose.
//   brand_colors.*       — hex colors (funnelRender.js:2667).
//   fonts.family         — a font family NAME, already re-validated against a
//                          known set at render time (funnelRender.js:2674).
//   checkout.address_autocomplete / .intl_phone — booleans. Feature toggles.
//     ⛔ checkout.maps_api_key is DELIBERATELY ABSENT — it is the credential.
//        The toggle travels; the key does not; the render path fails open with
//        plain inputs when the key is missing (funnelRender.js:2710).
//   custom_head_code / custom_body_end_code — funnel-level operator SCRIPT,
//     the settings-level twin of a page's custom_js. Carried VERBATIM for the
//     same reason custom_js is (a funnel without its pixels is not the funnel),
//     and reported in `warnings` for the same reason: a human must read it
//     before publishing, because it is code and it may embed a token.
//
// ⚠️ ADDING A KEY HERE SHIPS IT TO ANOTHER ENVIRONMENT. Read the value, not the
// name, before you do.
export const SETTINGS_ALLOWLIST = {
  logo_url: 'string',
  description: 'string',
  brand_colors: { primary: 'string', secondary: 'string' },
  fonts: { family: 'string' },
  checkout: { address_autocomplete: 'boolean', intl_phone: 'boolean' },
  custom_head_code: 'string',
  custom_body_end_code: 'string',
};

// `seo` is a small structured blob written by the settings modal
// (sections.jsx:139-142). Same nested-allowlist treatment.
export const SEO_ALLOWLIST = {
  site_title: 'string',
  site_description: 'string',
  og_image: 'string',
  favicon: 'string',
  title: 'string',
  description: 'string',
};

const typeOk = (want, v) =>
  (want === 'string' && typeof v === 'string')
  || (want === 'boolean' && typeof v === 'boolean')
  || (want === 'number' && typeof v === 'number' && Number.isFinite(v));

/**
 * Project an operator blob through a (possibly nested) allowlist.
 * @returns {{ value: object, dropped: string[] }} `dropped` is the list of
 *   dotted paths that did NOT travel — surfaced to the operator so a stripped
 *   key is a REPORTED fact, never a silent one.
 */
export function applyAllowlist(blob, allowlist, prefix = '') {
  const value = {};
  const dropped = [];
  if (!isPlainObject(blob)) return { value, dropped };
  for (const key of Object.keys(blob)) {
    const rule = Object.prototype.hasOwnProperty.call(allowlist, key) ? allowlist[key] : undefined;
    const path = prefix ? `${prefix}.${key}` : key;
    if (rule === undefined) { dropped.push(path); continue; }
    const v = blob[key];
    if (typeof rule === 'string') {
      if (typeOk(rule, v)) value[key] = v;
      else dropped.push(path);
      continue;
    }
    // Nested rule object.
    if (!isPlainObject(v)) { dropped.push(path); continue; }
    const nested = applyAllowlist(v, rule, path);
    dropped.push(...nested.dropped);
    // An empty projection is not carried — an empty {} is noise, not settings.
    if (Object.keys(nested.value).length) value[key] = nested.value;
  }
  return { value, dropped };
}

// ── THE CODE DETECTOR ──────────────────────────────────────────────────────
//
// Review MED #4: warning on the `custom_js` / `head_html` / `body_end_html`
// COLUMNS missed the more common hiding place. funnelRender emits an `html`
// (and `embed`) block's `props.html` VERBATIM into the document, so a <script>
// pasted into a block is executable code that the old detector reported as
// nothing at all. A page can carry a tracking pixel, a redirect, or a keylogger
// in a block and the import summary would have said "no scripts".
//
// One detector, used by BOTH sides of the transfer (export warns before the
// file is written, import warns before it is opened) and mirrored in the client
// modal so the operator reads the same sentence at every step.
const HTML_BLOCK_TYPES = new Set(['html', 'embed']);

function pageCarriesRawHtmlBlock(page) {
  const blocks = Array.isArray(page?.blocks) ? page.blocks : [];
  return blocks.some((b) => {
    if (!isPlainObject(b)) return false;
    if (HTML_BLOCK_TYPES.has(String(b.type))) return true;
    // A non-html block can still hold markup in a props.html field.
    const html = isPlainObject(b.props) ? b.props.html : undefined;
    return typeof html === 'string' && /<script/i.test(html);
  });
}

/**
 * The warnings a set of pages + a settings blob earn, in operator language.
 * Pure and shared, so export, import and the client cannot drift apart.
 */
export function codeWarnings(pages, settings) {
  const list = Array.isArray(pages) ? pages : [];
  const out = [];
  const plural = (n) => (n === 1 ? '' : 's');

  const js = list.filter((p) => str(p?.custom_js).trim()).length;
  if (js) out.push(`custom_js on ${js} page${plural(js)} — review before publishing`);

  const rawFields = list.filter(
    (p) => ['custom_html', 'head_html', 'body_end_html'].some((k) => str(p?.[k]).trim())
  ).length;
  if (rawFields) out.push(`raw HTML fields (custom_html / head_html / body_end_html) on ${rawFields} page${plural(rawFields)} — review before publishing`);

  const htmlBlocks = list.filter(pageCarriesRawHtmlBlock).length;
  if (htmlBlocks) out.push(`${htmlBlocks} page${plural(htmlBlocks)} carry raw HTML/embed blocks — review before publishing`);

  if (isPlainObject(settings)
    && (str(settings.custom_head_code).trim() || str(settings.custom_body_end_code).trim())) {
    out.push('funnel-level script (settings.custom_head_code / custom_body_end_code) — review before publishing');
  }
  return out;
}

// ── EXPORT ─────────────────────────────────────────────────────────────────

/**
 * Build the portable envelope for one funnel.
 *
 * `exported_at` comes from the DATABASE (`SELECT NOW()`), not from the Node
 * process clock and never from the client: the envelope is a record of a
 * database read, so its instant must be the database's.
 *
 * @param {string} funnelId
 * @param {{query?: Function}} [opts] injected query fn (tests pass a scoped one)
 * @returns {Promise<{ok: true, envelope: object} | {ok: false, status: number, error: string}>}
 */
export async function exportFunnel(funnelId, { query = pgQuery } = {}) {
  const id = String(funnelId || '').slice(0, 120);
  if (!id) return { ok: false, status: 400, error: 'funnel_id_required' };

  const [funnel] = await query(`SELECT * FROM funnels WHERE id = $1`, [id]);
  if (!funnel) return { ok: false, status: 404, error: 'funnel_not_found' };
  // Review LOW #14: every WRITE endpoint on funnels.js refuses an archived
  // funnel ("restore it before …"). Export is a READ, but it is the read that
  // produces a portable copy — resurrecting a trashed funnel by exporting and
  // re-importing it routes around the archive. Same refusal, same wording.
  if (funnel.archived) return { ok: false, status: 403, error: 'funnel_archived' };

  // Same page set and same order the funnel detail endpoint serves
  // (funnels.js:379-383) — home first, then creation order. That order IS the
  // export order, and the flow indices below are indices into it.
  const pages = await query(
    `SELECT * FROM funnel_pages
     WHERE funnel_id = $1 AND archived = FALSE
     ORDER BY is_home DESC, created_at ASC`,
    [id]
  );

  // Review MED #9: funnel-relative redirects travel too. They are pure
  // (from, to, match, code, enabled) tuples — no ids, no hosts — and a funnel
  // that loses them on transfer silently 404s every legacy ad URL pointed at it.
  let redirects = [];
  try {
    redirects = await query(
      `SELECT from_path, to_path, match, code, enabled FROM funnel_redirects
       WHERE funnel_id = $1 ORDER BY created_at ASC LIMIT $2`,
      [id, MAX_REDIRECTS]
    );
  } catch (err) {
    // funnel_redirects is created by the same ensureTables this route awaits,
    // so a missing table means an older database mid-upgrade — an export
    // without redirects beats no export at all.
    if (err?.code !== '42P01') throw err;
  }

  const [{ now }] = await query(`SELECT NOW() AS now`);

  const settings = applyAllowlist(funnel.settings, SETTINGS_ALLOWLIST);
  const seo = applyAllowlist(funnel.seo, SEO_ALLOWLIST);

  const envelope = {
    format: FORMAT_TAG,
    exported_at: now instanceof Date ? now.toISOString() : String(now),
    funnel: {
      name: str(funnel.name),
      slug: str(funnel.slug),
      // `type` is not a column on `funnels` in this schema — the funnel's type
      // is expressed by its pages. Emitted as a constant so a consumer that
      // reads envelope.funnel.type gets a defined answer instead of undefined.
      type: 'funnel',
      settings: settings.value,
      seo: seo.value,
    },
    pages: pages.map((p) => ({
      title: str(p.title),
      slug: str(p.slug),
      type: str(p.type) || 'generic',
      is_home: p.is_home === true,
      // Page status travels: the FUNNEL gate (draft) is what keeps an import
      // dark, so preserving per-page intent costs nothing and losing it would
      // silently un-publish a whole funnel on a round trip.
      status: p.status === 'published' ? 'published' : 'draft',
      blocks: Array.isArray(p.blocks) ? p.blocks : [],
      seo: applyAllowlist(p.seo, SEO_ALLOWLIST).value,
      custom_html: str(p.custom_html),
      custom_css: str(p.custom_css),
      custom_js: str(p.custom_js),
      head_html: str(p.head_html),
      body_end_html: str(p.body_end_html),
    })),
    // THE CANVAS GRAPH, ID-FREE. flow_layout stores page IDs; ids never leave,
    // so each node/edge endpoint is rewritten as the page's INDEX in `pages`
    // above. A node pointing at a page that is not in the export (archived
    // between the two reads) is dropped rather than emitted dangling.
    flow: buildPortableFlow(funnel.flow_layout, pages),
    redirects: redirects.map((r) => ({
      from_path: str(r.from_path),
      to_path: str(r.to_path),
      match: r.match === 'prefix' ? 'prefix' : 'exact',
      code: Number(r.code) === 302 ? 302 : 301,
      enabled: r.enabled !== false,
    })),
  };

  // Review MED #8: EXPORT IS THE IRREVERSIBLE ACT. Once the file exists the
  // operator has already handed the code inside it to wherever the file goes;
  // warning at import time is warning the receiver, not the sender. So the
  // envelope carries its own warnings and the client shows them BEFORE writing
  // the file to disk.
  envelope.warnings = codeWarnings(envelope.pages, envelope.funnel.settings);

  // ⚠️ `stripped` IS DELIBERATELY NOT PART OF THE ENVELOPE (review MED #8).
  // It is a list of KEY NAMES that were refused — `settings.checkout.
  // maps_api_key`, `settings.tracking` — which is a map of where this
  // deployment keeps its credentials. That belongs in the HTTP response to the
  // authenticated operator who asked, and NOT in a file designed to be handed
  // to someone else. The route puts it in `meta`, outside `data`.
  const stripped = [
    ...settings.dropped.map((k) => `settings.${k}`),
    ...seo.dropped.map((k) => `seo.${k}`),
  ];

  return { ok: true, envelope, stripped };
}

function buildPortableFlow(flowLayout, pages) {
  const out = { nodes: [], edges: [] };
  if (!isPlainObject(flowLayout)) return out;
  const indexById = new Map(pages.map((p, i) => [p.id, i]));
  const nodes = Array.isArray(flowLayout.nodes) ? flowLayout.nodes : [];
  const edges = Array.isArray(flowLayout.edges) ? flowLayout.edges : [];
  for (const n of nodes) {
    if (!isPlainObject(n)) continue;
    const i = indexById.get(n.id);
    if (i === undefined) continue;
    const x = Number(n.x);
    const y = Number(n.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.nodes.push({ page_index: i, x, y });
  }
  for (const e of edges) {
    if (!isPlainObject(e)) continue;
    const s = indexById.get(e.source);
    const t = indexById.get(e.target);
    if (s === undefined || t === undefined) continue;
    out.edges.push({ source_index: s, target_index: t, kind: e.kind === 'fallback' ? 'fallback' : 'main' });
  }
  return out;
}

// ── IMPORT: validation ─────────────────────────────────────────────────────

/**
 * Validate an incoming envelope's TAG and CAPS. Pure — touches no database.
 * Returns a structured refusal with the HTTP status the route should answer:
 * 400 for a shape/tag problem, 413 for a cap.
 *
 * @returns {{ok: true, pages: object[], warnings: string[]} | {ok: false, status: number, error: string, detail?: string}}
 */
export function validateEnvelope(raw) {
  if (!isPlainObject(raw)) return { ok: false, status: 400, error: 'envelope_must_be_object' };
  if (raw.format !== FORMAT_TAG) {
    return { ok: false, status: 400, error: 'not_a_funnel_envelope', detail: `expected format '${FORMAT_TAG}'` };
  }
  if (!isPlainObject(raw.funnel)) return { ok: false, status: 400, error: 'envelope_missing_funnel' };
  if (!Array.isArray(raw.pages)) return { ok: false, status: 400, error: 'envelope_missing_pages' };
  if (!raw.pages.length) return { ok: false, status: 400, error: 'envelope_has_no_pages' };
  if (raw.pages.length > MAX_PAGES) {
    return { ok: false, status: 413, error: 'too_many_pages', detail: `${raw.pages.length} pages exceeds the ${MAX_PAGES} cap` };
  }

  // TOTAL first: measure what actually arrived, before walking it.
  let total;
  try {
    total = Buffer.byteLength(JSON.stringify(raw), 'utf8');
  } catch {
    return { ok: false, status: 400, error: 'envelope_not_serializable' };
  }
  if (total > MAX_TOTAL_BYTES) {
    return { ok: false, status: 413, error: 'envelope_too_large', detail: `${total} bytes exceeds the ${MAX_TOTAL_BYTES} cap` };
  }

  for (let i = 0; i < raw.pages.length; i++) {
    const p = raw.pages[i];
    if (!isPlainObject(p)) return { ok: false, status: 400, error: 'page_must_be_object', detail: `pages[${i}]` };
    const blocks = p.blocks === undefined ? [] : p.blocks;
    let size;
    try {
      size = Buffer.byteLength(JSON.stringify(blocks), 'utf8');
    } catch {
      return { ok: false, status: 400, error: 'blocks_not_serializable', detail: `pages[${i}]` };
    }
    if (size > MAX_BLOCKS_BYTES_PER_PAGE) {
      return {
        ok: false, status: 413, error: 'page_blocks_too_large',
        detail: `pages[${i}] blocks are ${size} bytes, over the ${MAX_BLOCKS_BYTES_PER_PAGE} cap`,
      };
    }
    // THE SAME GATE THE EDITOR USES. 422 (not 400): the envelope's shape is
    // fine, its CONTENT is unprocessable. (Review NIT #16: this used to read
    // `Array.isArray(blocks) ? blocks : blocks` — both arms identical, which
    // read as a guard that guarded nothing. validateBlocks refuses a non-array
    // itself, so the value goes straight in.)
    const err = validateBlocks(blocks);
    if (err) return { ok: false, status: 422, error: 'invalid_blocks', detail: `pages[${i}]: ${err}` };
  }

  if (raw.redirects !== undefined) {
    if (!Array.isArray(raw.redirects)) return { ok: false, status: 400, error: 'redirects_must_be_an_array' };
    if (raw.redirects.length > MAX_REDIRECTS) {
      return {
        ok: false, status: 413, error: 'too_many_redirects',
        detail: `${raw.redirects.length} redirects exceeds the ${MAX_REDIRECTS} cap`,
      };
    }
  }

  return { ok: true };
}

// ── Redirect sanitising ────────────────────────────────────────────────────
// funnels.js keeps its redirect validators module-private (validatePath /
// validateRedirectRule, funnels.js:658-687), so the rules are restated here —
// same rules, same reasons, and the same gap note as the flow caps above.
// A BAD REDIRECT IS DROPPED, NEVER A HARD FAILURE: a redirect is a convenience
// attached to a funnel, and refusing an entire import over one malformed rule
// would trade the whole funnel for a rule the operator can retype in seconds.
// Every drop is reported in `notes`.
const REDIRECT_PATH_RE = /^\/[^\s?#]*$/;
const REDIRECT_PATH_MAX = 2048;

function sanitizeRedirects(raw, notes) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  const seen = new Set();
  for (let i = 0; i < raw.length && out.length < MAX_REDIRECTS; i++) {
    const r = raw[i];
    const drop = (why) => notes.push(`Redirect ${i + 1} was dropped (${why}).`);
    if (!isPlainObject(r)) { drop('not an object'); continue; }
    const from = String(r.from_path ?? '').trim();
    const to = String(r.to_path ?? '').trim();
    const match = r.match === 'prefix' ? 'prefix' : 'exact';
    const bad = (label, v) =>
      !v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\')
      || v.length > REDIRECT_PATH_MAX || !REDIRECT_PATH_RE.test(v)
        ? `${label} is not a same-site funnel path` : null;
    const e = bad('from_path', from) || bad('to_path', to);
    if (e) { drop(e); continue; }
    // The two shapes that take a whole funnel offline (funnels.js:681-687).
    if (from === to) { drop('it redirects to itself forever'); continue; }
    if (match === 'prefix' && from === '/') { drop("a prefix rule on '/' swallows every page"); continue; }
    const key = `${match}:${from}`;
    if (seen.has(key)) { drop('duplicate of an earlier rule'); continue; }
    seen.add(key);
    out.push({ from_path: from, to_path: to, match, code: Number(r.code) === 302 ? 302 : 301, enabled: r.enabled !== false });
  }
  if (Array.isArray(raw) && raw.length > MAX_REDIRECTS) {
    notes.push(`Only the first ${MAX_REDIRECTS} redirects were imported.`);
  }
  return out;
}

const PAGE_SLUG_RE = /^\/$|^\/[a-z0-9-]+$/;
const FUNNEL_SLUG_RE = /^[a-z0-9-]+$/;
const slugify = (name) =>
  String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

// Derive a legal, unique-within-this-import page slug. The envelope is an
// untrusted file: a slug may be missing, malformed, or repeated. A malformed
// one is REWRITTEN (an import must not fail on cosmetics), a repeated one gets
// a numeric suffix — the same `-2`, `-3` ladder funnel-os's unique_website_slug
// walks. Uniqueness only has to hold WITHIN the envelope: the funnel is brand
// new, so it has no pre-existing pages to collide with.
function resolvePageSlug(raw, { title, type, index }, taken) {
  let base = String(raw ?? '').trim().toLowerCase();
  if (!PAGE_SLUG_RE.test(base)) {
    const derived = slugify(title) || slugify(type) || `page-${index + 1}`;
    base = `/${derived}`;
    if (!PAGE_SLUG_RE.test(base)) base = `/page-${index + 1}`;
  }
  if (!taken.has(base)) { taken.add(base); return { slug: base, rewritten: base !== raw }; }
  const stem = base === '/' ? '/home' : base;
  for (let n = 2; n <= MAX_PAGES + 2; n++) {
    const cand = `${stem}-${n}`;
    if (!taken.has(cand)) { taken.add(cand); return { slug: cand, rewritten: true }; }
  }
  const fallback = `/page-${index + 1}-${randomBytes(2).toString('hex')}`;
  taken.add(fallback);
  return { slug: fallback, rewritten: true };
}

const PAGE_TYPES = new Set([
  'listicle', 'lead', 'quiz', 'checkout', 'upsell', 'downsell', 'thankyou',
  'generic', 'optin', 'storefront',
]);

const ESCAPE_HATCH_MAX = 2 * 1024 * 1024;

// Review MED #5: this used to blank an over-cap field and say NOTHING. The
// operator was told "custom_js on 1 page — review before publishing" about code
// that had already been deleted, and the page they went to review was empty.
// Clamping still happens (funnels.js refuses over-cap escape hatches, so
// storing one would make the page unsaveable — the same trap as HIGH #1), but
// now it REPORTS, per field and per page.
function clampCode(value, { field, page, notes }) {
  const s = String(value ?? '');
  if (Buffer.byteLength(s, 'utf8') <= ESCAPE_HATCH_MAX) return s;
  notes.push(`${field} on page ${page} exceeded the 2MB limit and was removed.`);
  return '';
}

// ── IMPORT ─────────────────────────────────────────────────────────────────

/**
 * Create a NEW funnel + all its pages from an envelope, in ONE transaction.
 *
 * ATOMICITY IS THE POINT. funnel-os's import is "atomically-ish" and can leave
 * a live funnel with zero pages; this one cannot leave anything. Either the
 * funnel row and every page row are committed together, or nothing is — which
 * is exactly what the harness asserts by counting rows before and after a
 * deliberately-invalid import.
 *
 * @param {{envelope: object, nameOverride?: string}} input
 * @param {{client?: object, query?: Function}} [opts]
 * @returns {Promise<{ok: true, data: object} | {ok: false, status: number, error: string, detail?: string}>}
 */
export async function importFunnel({ envelope, nameOverride } = {}, { client = pgClient, query = pgQuery } = {}) {
  const v = validateEnvelope(envelope);
  if (!v.ok) return { ok: false, status: v.status, error: v.error, detail: v.detail };

  await ensureTables();

  const srcFunnel = envelope.funnel;
  const rawName = nameOverride !== undefined && nameOverride !== null
    ? String(nameOverride).trim()
    : String(srcFunnel.name ?? '').trim();
  const name = rawName || 'Imported funnel';
  if (name.length > 200) return { ok: false, status: 400, error: 'name_too_long' };

  const warnings = [];
  const notes = [];

  // ── Home invariant, decided BEFORE any write ────────────────────────────
  // funnel_pages carries an exactly-one-home rule that funnels.js repairs
  // after the fact (ensureHomeInvariant). An import can supply zero homes or
  // five; both are resolved here, deterministically — FIRST PAGE WINS, the
  // rest are demoted — and the resolution is REPORTED, never silent.
  const homeFlags = envelope.pages.map((p) => p.is_home === true);
  const homeCount = homeFlags.filter(Boolean).length;
  let homeIndex = homeFlags.indexOf(true);
  if (homeCount === 0) {
    homeIndex = 0;
    notes.push('No page in the envelope was marked home — the first page was promoted.');
  } else if (homeCount > 1) {
    notes.push(`${homeCount} pages were marked home — the first won and ${homeCount - 1} were demoted.`);
  }

  const importedSettings = applyAllowlist(srcFunnel.settings, SETTINGS_ALLOWLIST);
  if (importedSettings.dropped.length) {
    notes.push(`Settings keys outside the transfer allowlist were dropped: ${importedSettings.dropped.join(', ')}.`);
  }
  const importedSeo = applyAllowlist(srcFunnel.seo, SEO_ALLOWLIST);

  // ── REVIEW HIGH #1: the allowlisted settings must still be WRITABLE ──────
  // The allowlist decides which KEYS travel. It says nothing about SIZE, and
  // `description` is an allowlisted string. A 3MB description plus a 5MB
  // custom_head_code imported cleanly at 201, added ~8MB to every GET /funnels
  // response, and — worst of all — made the funnel permanently unsaveable from
  // the settings modal, because PATCH runs validateFunnelSettings and the
  // funnel now failed it ON ITS OWN STORED DATA. A row you cannot edit through
  // the only UI that edits it is corruption, not content.
  //
  // So the import runs the SAME validator the PATCH path runs, and refuses.
  // 422 rather than 413: nothing here is over a TRANSFER cap (the envelope was
  // well within 20MB) — the content is unprocessable by the app that has to
  // own it afterwards.
  const settingsErr = validateFunnelSettings(importedSettings.value);
  if (settingsErr) {
    return { ok: false, status: 422, error: 'settings_invalid', detail: settingsErr };
  }

  // ── Page rows, fully resolved before the transaction opens ──────────────
  const taken = new Set();
  const rows = envelope.pages.map((p, i) => {
    const type = PAGE_TYPES.has(p.type) ? p.type : 'generic';
    const title = String(p.title ?? '').trim().slice(0, 500) || `Page ${i + 1}`;
    const { slug, rewritten } = resolvePageSlug(p.slug, { title, type, index: i }, taken);
    if (rewritten) notes.push(`Page ${i + 1} slug became ${slug}.`);
    return {
      id: genId('fpg'),
      title,
      slug,
      type,
      status: p.status === 'published' ? 'published' : 'draft',
      is_home: i === homeIndex,
      blocks: Array.isArray(p.blocks) ? p.blocks : [],
      seo: applyAllowlist(p.seo, SEO_ALLOWLIST).value,
      custom_html: clampCode(p.custom_html, { field: 'custom_html', page: i + 1, notes }),
      custom_css: clampCode(p.custom_css, { field: 'custom_css', page: i + 1, notes }),
      custom_js: clampCode(p.custom_js, { field: 'custom_js', page: i + 1, notes }),
      head_html: clampCode(p.head_html, { field: 'head_html', page: i + 1, notes }),
      body_end_html: clampCode(p.body_end_html, { field: 'body_end_html', page: i + 1, notes }),
    };
  });

  // ── Warnings are computed from what is ACTUALLY STORED ──────────────────
  // Review MED #5: computing them from the ENVELOPE warned about code that
  // clampCode had just deleted. `rows` is the post-clamp, post-allowlist truth
  // — the exact values the INSERT below writes — so a warning here always has
  // a page behind it that really carries the code.
  warnings.push(...codeWarnings(rows, importedSettings.value));

  const redirectRows = sanitizeRedirects(envelope.redirects, notes);

  // Layout is cosmetic and must never cost the operator the funnel (HIGH #2).
  let flowLayout = rebuildFlow(envelope.flow, rows, notes);
  if (!flowLooksStorable(flowLayout, rows)) {
    notes.push('The canvas layout in this export could not be made valid and was dropped. Page content is unaffected — open the canvas and re-arrange.');
    flowLayout = { nodes: [], edges: [] };
  }

  // Funnel slug: a fresh one derived from the name, de-collided against LIVE
  // funnels. The unique index is partial (`WHERE NOT archived`, funnels.js:62),
  // so the read below asks the same question the index will.
  const baseSlug = FUNNEL_SLUG_RE.test(String(srcFunnel.slug ?? '')) && !nameOverride
    ? String(srcFunnel.slug)
    : (slugify(name) || 'imported-funnel');

  // A UNIQUE violation ABORTS a Postgres transaction — it cannot be caught and
  // retried inside the same `begin`. So the retry wraps the WHOLE transaction
  // with a fresh suffix, which is also what makes the read-then-insert race
  // safe: the index, not the read, is the arbiter.
  let created = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const slug = attempt === 0 ? baseSlug : `${baseSlug}-${randomBytes(2).toString('hex')}`.slice(0, 80);
    try {
      // eslint-disable-next-line no-await-in-loop
      created = await client.begin(async (tx) => {
        const q = (text, params = []) => tx.unsafe(text, params);
        const funnelId = genId('fnl');
        const [funnelRow] = await q(
          `INSERT INTO funnels (id, slug, name, status, seo, settings, flow_layout)
           VALUES ($1, $2, $3, 'draft', $4, $5, $6)
           RETURNING id, slug, name, status, archived, custom_domain, seo, settings, flow_layout, created_at, updated_at`,
          // Raw objects — postgres.js serializes JSONB itself. JSON.stringify
          // here would store the TEXT as a jsonb STRING scalar, and every
          // reader would get "{\"nodes\":[]}" instead of an object.
          [funnelId, slug, name, importedSeo.value, importedSettings.value, flowLayout]
        );
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          // created_at IS THE PAGE ORDER. Every reader that lists a funnel's
          // pages sorts `is_home DESC, created_at ASC` (funnels.js:382 and the
          // summary read below), and Postgres's NOW() is TRANSACTION-scoped —
          // so all N pages inserted here would share one identical timestamp
          // and the non-home pages would come back in whatever order the plan
          // felt like. Measured: a 3-page round trip put the imported pages in
          // a DIFFERENT order from the envelope. A per-row millisecond offset
          // makes the envelope's order the funnel's order, deterministically.
          // eslint-disable-next-line no-await-in-loop
          await q(
            `INSERT INTO funnel_pages
               (id, funnel_id, slug, type, title, status, is_home, blocks, seo,
                custom_html, custom_css, custom_js, head_html, body_end_html, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                     NOW() + ($15 * INTERVAL '1 millisecond'))`,
            [r.id, funnelId, r.slug, r.type, r.title, r.status, r.is_home,
              r.blocks, r.seo, // raw — postgres.js handles JSONB (funnels.js:1118)
              r.custom_html, r.custom_css, r.custom_js, r.head_html, r.body_end_html, i]
          );
        }
        // Redirects ride the SAME transaction (review MED #9): a funnel that
        // committed without its redirects would answer 404 on every legacy ad
        // URL, which is the failure the redirects exist to prevent.
        for (const rd of redirectRows) {
          // eslint-disable-next-line no-await-in-loop
          await q(
            `INSERT INTO funnel_redirects (id, funnel_id, from_path, to_path, match, code, enabled)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [genId('frd'), funnelId, rd.from_path, rd.to_path, rd.match, rd.code, rd.enabled]
          );
        }
        return funnelRow;
      });
      break;
    } catch (err) {
      lastErr = err;
      if (err?.code === UNIQUE_VIOLATION) continue; // fresh suffix, whole tx again
      throw err; // LET IT THROW — the route logs and answers 500
    }
  }
  if (!created) {
    if (lastErr?.code === UNIQUE_VIOLATION) {
      return { ok: false, status: 409, error: 'slug_collision', detail: 'could not find a free funnel slug' };
    }
    throw lastErr || new Error('import produced no funnel');
  }

  const pageSummary = await query(
    `SELECT id, slug, title, type, status, is_home FROM funnel_pages
     WHERE funnel_id = $1 ORDER BY is_home DESC, created_at ASC`,
    [created.id]
  );

  return {
    ok: true,
    data: {
      funnel: created,
      pages: pageSummary,
      pages_count: pageSummary.length,
      redirects_count: redirectRows.length,
      home_page_slug: rows[homeIndex]?.slug ?? null,
      home_adjusted: homeCount !== 1,
      warnings,
      notes,
    },
  };
}

// Turn the id-free `flow` back into funnels.flow_layout's id-keyed shape, now
// pointing at the NEW page ids.
//
// REVIEW HIGH #2 — THIS FUNCTION USED TO WRITE A LAYOUT THE CANVAS COULD NOT
// SAVE. `page_index` is attacker-controlled and repeatable, so 5000 nodes all
// pointing at index 0 became 5000 nodes sharing ONE id, and 5000 self-edges
// became 5000 loops. Both stored happily at 201 — and then the canvas refused
// its own persisted layout ("duplicate id") on the next save. The import
// succeeded and left the funnel's canvas permanently unsaveable.
//
// Everything validateFlow refuses is now refused HERE, at the same values:
//   • duplicate node ids     — FIRST WINS (the operator's first placement)
//   • self-edges             — dropped
//   • duplicate edges        — dropped
//   • dangling indices       — dropped (an index outside the imported set)
//   • non-finite coordinates — dropped (NaN/Infinity crash React Flow)
//   • counts over the caps   — truncated at FLOW_MAX_NODES / FLOW_MAX_EDGES
//   • edges whose endpoints did not survive node de-duplication — dropped
//
// Layout is COSMETIC. Nothing here ever fails the import: a flow that cannot be
// made legal is dropped to an empty layout with a note, because losing the
// node positions is a smaller harm than losing the funnel.
function rebuildFlow(flow, rows, notes = []) {
  const out = { nodes: [], edges: [] };
  if (!isPlainObject(flow)) return out;
  const at = (i) => (Number.isInteger(i) && i >= 0 && i < rows.length ? rows[i].id : null);

  const seenNode = new Set();
  let droppedNodes = 0;
  for (const n of Array.isArray(flow.nodes) ? flow.nodes : []) {
    if (out.nodes.length >= FLOW_MAX_NODES) { droppedNodes++; continue; }
    if (!isPlainObject(n)) { droppedNodes++; continue; }
    const id = at(n.page_index);
    const x = Number(n.x);
    const y = Number(n.y);
    if (!id || !Number.isFinite(x) || !Number.isFinite(y)) { droppedNodes++; continue; }
    if (seenNode.has(id)) { droppedNodes++; continue; } // first placement wins
    seenNode.add(id);
    out.nodes.push({ id, x, y });
  }

  const seenEdge = new Set();
  let droppedEdges = 0;
  for (const e of Array.isArray(flow.edges) ? flow.edges : []) {
    if (out.edges.length >= FLOW_MAX_EDGES) { droppedEdges++; continue; }
    if (!isPlainObject(e)) { droppedEdges++; continue; }
    const source = at(e.source_index);
    const target = at(e.target_index);
    // An edge may only join nodes that actually survived above — otherwise the
    // layout references a node it does not contain.
    if (!source || !target || !seenNode.has(source) || !seenNode.has(target)) { droppedEdges++; continue; }
    if (source === target) { droppedEdges++; continue; } // self-edge
    const kind = e.kind === 'fallback' ? 'fallback' : 'main';
    const key = `${source}>${target}:${kind}`;
    if (seenEdge.has(key)) { droppedEdges++; continue; }
    seenEdge.add(key);
    out.edges.push({ source, target, kind });
  }

  if (droppedNodes || droppedEdges) {
    notes.push(
      `Canvas layout was repaired on import: ${droppedNodes} node${droppedNodes === 1 ? '' : 's'} and `
      + `${droppedEdges} edge${droppedEdges === 1 ? '' : 's'} were dropped (duplicates, self-links, `
      + 'unknown pages or over the layout limits). Page content is unaffected.'
    );
  }
  return out;
}

// Last line of defence for the layout, restating validateFlow's structural
// rules over the ALREADY-rebuilt object. If this ever returns false the flow is
// stored empty rather than stored broken — see the note in importFunnel.
function flowLooksStorable(flow, rows) {
  if (!isPlainObject(flow) || !Array.isArray(flow.nodes) || !Array.isArray(flow.edges)) return false;
  if (flow.nodes.length > FLOW_MAX_NODES || flow.edges.length > FLOW_MAX_EDGES) return false;
  const valid = new Set(rows.map((r) => r.id));
  const ids = new Set();
  for (const n of flow.nodes) {
    if (!isPlainObject(n) || !valid.has(n.id) || ids.has(n.id)) return false;
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return false;
    ids.add(n.id);
  }
  for (const e of flow.edges) {
    if (!isPlainObject(e) || !ids.has(e.source) || !ids.has(e.target)) return false;
    if (e.source === e.target) return false;
    if (e.kind !== 'main' && e.kind !== 'fallback') return false;
  }
  return true;
}
