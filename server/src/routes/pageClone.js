// CLONE-A-PAGE — paste code or import a file, scan & clean it server-side,
// split it into sections, and create a new funnel page from the picked ones.
//
// The scan is DETERMINISTIC string surgery — no AI, no DOM library, and it
// NEVER fetches a URL. `original_url` is used ONLY as a base for string-
// rewriting relative src/href paths (no request is ever made with it, so
// there is no SSRF surface here by construction).
//
// Sections become {type:'section', props:{html}} blocks — funnelRender.js
// renders props.html verbatim inside its section wrapper, which is exactly
// what a cloned page needs. Everything written goes through the SAME
// validateBlocks caps as the funnels router, because this payload is what
// the public renderer will walk later.
import { randomBytes } from 'crypto';
import { Router } from 'express';
import { client, pgQuery } from '../db/pg.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { ensureTables, validateBlocks } from './funnels.js';

const router = Router();
router.use(authenticate, requirePermission('funnels', 'access'));

// Same caps as the funnels router: 2MB is what a page write may carry.
// Exported because the Shopify import route (routes/shopifyPages.js) feeds
// the SAME scanHtml pipeline and must answer 413 at the SAME thresholds — a
// second copy of these numbers would drift.
export const INPUT_MAX = 10 * 1024 * 1024; // 10MB raw input to /scan
export const ESCAPE_HATCH_MAX = 2 * 1024 * 1024; // 2MB total cleaned output
const CSS_MAX = 512 * 1024; // 512KB optional CSS overlay (applied on top)
const PAGE_SLUG_RE = /^\/$|^\/[a-z0-9-]+$/;
const UNIQUE_VIOLATION = '23505';

const genId = (prefix) => `${prefix}_${randomBytes(7).toString('hex')}`;

const slugify = (name) =>
  String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

// ---------------------------------------------------------------------------
// Scan pipeline (exported for the verification harness)
// ---------------------------------------------------------------------------

// Third-party pixel/tracker hosts. A <script>/<img>/<iframe>/<noscript> that
// references any of these is counted as a stripped pixel, not a junk script.
const PIXEL_RE =
  /(facebook\.com\/tr|connect\.facebook\.net|googletagmanager\.com|google-analytics\.com|analytics\.tiktok\.com|sc-static\.net)/i;

// Void elements never push tag depth in the section splitter.
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// Attributes whose relative values get absolutized against original_url.
const URL_ATTRS = ['src', 'href', 'poster', 'data-src', 'data-href'];

// ---------------------------------------------------------------------------
// Active-content hardening (applies to EVERY source: paste, upload, Shopify)
//
// A cloned page is third-party markup we re-serve from OUR origin, under our
// session cookies. The scan already drops <script>, but an inline `onclick`,
// a `javascript:` href, an arbitrary <iframe> and an offsite <form action>
// are all live code paths that survived it. They do not survive it now.
// ---------------------------------------------------------------------------

// Hosts allowed to stay in an <iframe>. Everything else is removed: a cloned
// page has no business embedding an arbitrary origin under ours. Matched as
// the host itself or any subdomain of it.
export const IFRAME_EMBED_HOSTS = [
  'youtube.com',
  'youtube-nocookie.com',
  'player.vimeo.com',
  'wistia.com',
  'wistia.net', // covers fast.wistia.net
  'loom.com',
];

// Attributes that carry a navigable/loadable URL.
const UNSAFE_URL_ATTRS = [
  'href', 'src', 'action', 'formaction', 'poster',
  'data-src', 'data-href', 'xlink:href', 'background',
];

// Schemes that execute rather than fetch.
const EXECUTING_SCHEMES = new Set(['javascript', 'vbscript']);

/**
 * The scheme of an attribute value AS A BROWSER WOULD SEE IT — numeric and
 * the handful of named entities that spell a colon are decoded, and every
 * control character and space is removed, before the scheme is read. Without
 * this, `java&#09;script:x` and `&#106;avascript:x` both read as scheme-less.
 * Returns '' when the value has no scheme.
 */
export function urlScheme(value) {
  const decoded = String(value == null ? '' : value)
    .replace(/&#x([0-9a-f]+);?/gi, (_m, h) => {
      const n = parseInt(h, 16);
      return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    })
    .replace(/&#(\d+);?/g, (_m, d) => {
      const n = parseInt(d, 10);
      return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    })
    .replace(/&colon;/gi, ':')
    .replace(/&(?:tab|newline|nbsp);/gi, ' ')
    // Control chars and spaces are ignored by URL parsers inside a scheme.
    .replace(/[\u0000-\u0020]/g, '');
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(decoded);
  return m ? m[1].toLowerCase() : '';
}

/** True when `host` is one of IFRAME_EMBED_HOSTS or a subdomain of one. */
export function isAllowedEmbedHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  return IFRAME_EMBED_HOSTS.some((allowed) => h === allowed || h.endsWith(`.${allowed}`));
}

// A host that no real URL can resolve to, used as the base for resolving
// attribute values. Anything that comes back still pointing at it was
// relative; anything else named a host of its own.
const RELATIVE_BASE = 'https://relative.invalid';
const RELATIVE_HOST = 'relative.invalid';

/**
 * The host a URL attribute would ACTUALLY load, decided by the same parser the
 * browser uses rather than by pattern-matching the string.
 *
 * This is the only safe way to answer "is this off-site". A regex looking for
 * `//` misses `\\evil.tld/harvest`, which every browser normalises to
 * `https://evil.tld/harvest` (WHATWG treats backslashes in the authority as
 * slashes) — the string does not look absolute and the URL is.
 * Returns '' for a value with no host at all (javascript:, mailto:, empty).
 */
export function resolvedHost(rawValue) {
  const raw = String(rawValue == null ? '' : rawValue).replace(/&amp;/gi, '&').trim();
  if (!raw) return '';
  try {
    return new URL(raw, RELATIVE_BASE).hostname;
  } catch {
    return '';
  }
}

/** True when a URL attribute value names a host that is not our own page. */
export function isOffsiteUrl(rawValue) {
  const host = resolvedHost(rawValue);
  return Boolean(host) && host !== RELATIVE_HOST;
}

// The host an <iframe src> would actually load. A relative or absent src
// resolves to the sentinel host, which is not on the allowlist, so it goes.
function iframeHost(tag) {
  const m = /\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
  if (!m) return '';
  return resolvedHost(m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] || '');
}

// One open/void tag: name + the attribute run, quote-aware so a '>' inside a
// quoted value does not end the tag early. Close tags start with '/', which
// [a-zA-Z] excludes.
const OPEN_TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>/g;
const EVENT_ATTR_RE = /\son[a-zA-Z][a-zA-Z0-9-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

// PERF — every regex the per-tag pass uses is built ONCE, here. Compiling
// them inside the pass (a `new RegExp` per attribute name per tag) made the
// shared cleaner 20x slower: measured at 1,109 ms for a 10MB / ~414k-tag
// document, i.e. the event-loop block that POST /page-clone/scan shares with
// live checkout, reachable from the paste and upload tabs. Folding the nine
// attribute names into ONE alternation also turns nine passes over each
// tag's attributes into one. The harness pins the resulting budget.
const UNSAFE_URL_ATTR_RE = new RegExp(
  `\\s(?:${UNSAFE_URL_ATTRS.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`,
  'gi'
);
const FORM_TAG_RE = /<form\b((?:"[^"]*"|'[^']*'|[^"'>])*)>/gi;
const FORM_ACTION_RE = /\baction\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i;

// A value that already has a scheme (http:, data:, mailto:, javascript:...),
// is protocol-relative (//cdn...) or a bare fragment is NOT relative.
const NOT_RELATIVE_RE = /^\s*(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/|#|$)/;

function absolutize(value, base) {
  if (NOT_RELATIVE_RE.test(value)) return value;
  try {
    return new URL(value, base).toString();
  } catch {
    return value; // unparseable — leave it verbatim rather than corrupt it
  }
}

// The WHATWG serializer does NOT percent-encode a single quote (verified:
// new URL('pic.png', "http://evil.com/a'onerror=x//") keeps the ' verbatim),
// so a hostile original_url could close a single-quoted attribute early and
// inject live markup. Every rewritten value gets BOTH quote characters
// percent-encoded before it is re-inserted between quotes — %27/%22 are
// valid URL bytes, so the link still resolves identically.
const encodeAttrQuotes = (url) => url.replace(/"/g, '%22').replace(/'/g, '%27');

// Rewrite relative src/href/srcset in-place against `base`. String-only.
export function rewriteRelativeUrls(html, base) {
  const attrRe = new RegExp(
    `\\b(${URL_ATTRS.join('|')})\\s*=\\s*("([^"]*)"|'([^']*)')`,
    'gi'
  );
  let out = html.replace(attrRe, (full, attr, quoted, dq, sq) => {
    const val = dq !== undefined ? dq : sq;
    const abs = absolutize(val, base);
    if (abs === val) return full;
    const quote = quoted[0];
    return `${attr}=${quote}${encodeAttrQuotes(abs)}${quote}`;
  });
  // srcset is a comma-separated list of "url [descriptor]" pairs.
  const srcsetRe = /\b(srcset)\s*=\s*("([^"]*)"|'([^']*)')/gi;
  out = out.replace(srcsetRe, (full, attr, quoted, dq, sq) => {
    const val = dq !== undefined ? dq : sq;
    const quote = quoted[0];
    const rewritten = val
      .split(',')
      .map((entry) => {
        const t = entry.trim();
        if (!t) return t;
        const [url, ...desc] = t.split(/\s+/);
        const abs = absolutize(url, base);
        return [abs === url ? url : encodeAttrQuotes(abs), ...desc].join(' ');
      })
      .join(', ');
    return `${attr}=${quote}${rewritten}${quote}`;
  });
  return out;
}

// Strip junk: scripts, pixels, comments, title, meta (except charset /
// viewport), preconnect/dns-prefetch/preload links. Returns the cleaned
// document plus counts. Deterministic and order-dependent: comments first
// (so a commented-out pixel is a comment, not a pixel), then scripts split
// pixel/junk, then imgs/iframes, then head hygiene.
export function cleanHtml(rawHtml) {
  let html = String(rawHtml);
  const stats = {
    scripts_removed: 0,
    pixels_stripped: 0,
    comments_removed: 0,
    handlers_stripped: 0,
    unsafe_urls_stripped: 0,
    iframes_removed: 0,
    forms_neutralized: 0,
    title: '',
  };

  // 1. HTML comments (covers commented-out trackers and IE conditionals).
  html = html.replace(/<!--[\s\S]*?-->/g, () => {
    stats.comments_removed += 1;
    return '';
  });

  // 2. <script>…</script> — pixel hosts count as pixels, the rest as junk.
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, (m) => {
    if (PIXEL_RE.test(m)) stats.pixels_stripped += 1;
    else stats.scripts_removed += 1;
    return '';
  });
  // Stray self-closing / unclosed script open tags (defensive).
  html = html.replace(/<script\b[^>]*\/\s*>/gi, () => {
    stats.scripts_removed += 1;
    return '';
  });

  // 3. <noscript> blocks — the classic fb pixel <img> fallback lives here.
  html = html.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, (m) => {
    if (PIXEL_RE.test(m)) stats.pixels_stripped += 1;
    return '';
  });

  // 4. Bare pixel <img>/<iframe> elements outside noscript.
  html = html.replace(/<img\b[^>]*>/gi, (m) =>
    PIXEL_RE.test(m) ? ((stats.pixels_stripped += 1), '') : m
  );
  html = html.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, (m) =>
    PIXEL_RE.test(m) ? ((stats.pixels_stripped += 1), '') : m
  );

  // 5. Source <title> — captured for the page title, then removed.
  html = html.replace(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/gi, (m, inner) => {
    if (!stats.title) stats.title = inner.replace(/\s+/g, ' ').trim();
    return '';
  });

  // 6. <meta> except charset/viewport (source meta is the cloner's junk).
  // ANY http-equiv meta is stripped FIRST, regardless of what else it
  // carries — <meta charset=x http-equiv=refresh content="0;url=evil">
  // must not ride the charset keep-list into the cloned page.
  html = html.replace(/<meta\b[^>]*>/gi, (m) => {
    if (/\bhttp-equiv\s*=/i.test(m)) return '';
    return /charset\s*=|name\s*=\s*["']?viewport/i.test(m) ? m : '';
  });

  // 7. <link rel=preconnect|dns-prefetch|preload> — origin-tuning for a page
  // we no longer serve from that origin. Stylesheets stay.
  html = html.replace(/<link\b[^>]*>/gi, (m) =>
    /\brel\s*=\s*["']?\s*(preconnect|dns-prefetch|preload)\b/i.test(m) ? '' : m
  );

  // 8. <iframe> that is not a known video embed. Runs AFTER the pixel pass
  // (step 4), so a tracker iframe is already counted as a pixel and is not
  // double-counted here. An <iframe> without a src, or with a relative one,
  // has no host to check and therefore does not survive.
  html = html.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, (m) => {
    if (isAllowedEmbedHost(iframeHost(m))) return m;
    stats.iframes_removed += 1;
    return '';
  });
  // Unclosed / self-closed iframe open tags (defensive — same treatment).
  html = html.replace(/<iframe\b[^>]*>/gi, (m) => {
    if (isAllowedEmbedHost(iframeHost(m))) return m;
    stats.iframes_removed += 1;
    return '';
  });

  // 9. <form action> pointing off-origin. The form STAYS — it is layout the
  // operator cloned on purpose — but it must not post a visitor's data to the
  // source site from our domain. The original target is kept as an inert
  // data-* attribute so the operator can see where it used to go.
  html = html.replace(FORM_TAG_RE, (full, attrs) => {
    const m = FORM_ACTION_RE.exec(attrs);
    if (!m) return full;
    const value = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] || '';
    // "Off-site" is decided by the URL PARSER, not by a pattern. A regex
    // hunting for `//` cleared `\\evil.tld/harvest` — a string that does not
    // look absolute but that every browser loads as https://evil.tld/harvest,
    // which is a visitor's form data leaving for someone else's server.
    if (!isOffsiteUrl(value)) return full;
    stats.forms_neutralized += 1;
    const stripped = attrs.replace(m[0], '');
    // The value is re-emitted inside double quotes, so any " it carries is
    // entity-escaped — it cannot close the attribute and open a new one.
    return `<form${stripped} data-original-action="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`;
  });

  // 10. Inline event handlers and executing URL schemes, on EVERY remaining
  // tag. This is the last pass so it also covers tags the earlier passes
  // chose to keep (kept metas, stylesheet links, allowlisted iframes).
  html = html.replace(OPEN_TAG_RE, (full, name, attrs) => {
    let out = attrs;

    // (a) on* handlers — the whole attribute goes.
    out = out.replace(EVENT_ATTR_RE, () => {
      stats.handlers_stripped += 1;
      return '';
    });

    // (b) javascript:/vbscript: in a navigable attribute — the whole
    // attribute goes too. Blanking it to "#" would leave a dead control that
    // looks live; removing it lets the element render as inert markup.
    // ONE pre-compiled alternation over all nine attribute names (see
    // UNSAFE_URL_ATTR_RE) — nine `new RegExp`s per tag was the hot spot.
    out = out.replace(UNSAFE_URL_ATTR_RE, (whole, quoted) => {
      const value = /^["']/.test(quoted) ? quoted.slice(1, -1) : quoted;
      if (!EXECUTING_SCHEMES.has(urlScheme(value))) return whole;
      stats.unsafe_urls_stripped += 1;
      return '';
    });

    return out === attrs ? full : `<${name}${out}>`;
  });

  return { html, stats };
}

// Split cleaned markup into top-level sections: direct children of <main>
// if present, else of <body>, else of the whole fragment. Depth-tracked tag
// scan — void and self-closed elements do not push depth.
export function splitSections(cleanedHtml, { fragment = false } = {}) {
  let scope = String(cleanedHtml);
  // FRAGMENT MODE (opt-in, default off — the paste/upload paths are unchanged).
  // The body/main scoping below is a WHOLE-DOCUMENT heuristic: it keeps only
  // what sits between the first <body>…</body> (or <main>…</main>) pair. Fed a
  // FRAGMENT — e.g. a Shopify page's body_html — that heuristic silently
  // truncates: one stray </body> typed into the page editor scopes the split
  // to everything before it and the rest of the page is dropped with no error
  // and no count. A fragment has no document scope to find, so it skips it.
  if (!fragment) {
    const bodyMatch = scope.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i);
    if (bodyMatch) scope = bodyMatch[1];
    else {
      // No <body>: drop doctype/html/head wrappers so head remnants (kept
      // charset/viewport meta, stylesheet links) don't become "sections".
      scope = scope
        .replace(/<!doctype[^>]*>/gi, '')
        .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, '')
        .replace(/<\/?html\b[^>]*>/gi, '');
    }
    const mainMatch = scope.match(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/i);
    if (mainMatch) scope = mainMatch[1];
  }

  const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:"[^"]*"|'[^']*'|[^"'>])*>/g;
  const chunks = [];
  let depth = 0;
  let chunkStart = 0;
  let m;
  while ((m = TAG_RE.exec(scope))) {
    const full = m[0];
    const name = m[1].toLowerCase();
    const isClose = full[1] === '/';
    const isVoid = VOID_TAGS.has(name) || /\/\s*>$/.test(full);
    if (isClose) {
      if (depth > 0) depth -= 1;
      if (depth === 0) {
        chunks.push(scope.slice(chunkStart, m.index + full.length));
        chunkStart = m.index + full.length;
      }
    } else if (!isVoid) {
      if (depth === 0 && m.index > chunkStart) {
        chunks.push(scope.slice(chunkStart, m.index));
        chunkStart = m.index;
      }
      depth += 1;
    } else if (depth === 0) {
      chunks.push(scope.slice(chunkStart, m.index + full.length));
      chunkStart = m.index + full.length;
    }
  }
  if (chunkStart < scope.length) chunks.push(scope.slice(chunkStart));

  const sections = [];
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const text = trimmed
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
    sections.push({
      index: sections.length,
      html: trimmed,
      text_preview: text.slice(0, 120),
      approx_bytes: Buffer.byteLength(trimmed, 'utf8'),
    });
  }
  // A page with no top-level elements at all still clones as one section.
  if (!sections.length) {
    const whole = scope.trim();
    if (whole) {
      sections.push({
        index: 0,
        html: whole,
        text_preview: whole.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120),
        approx_bytes: Buffer.byteLength(whole, 'utf8'),
      });
    }
  }
  return sections;
}

// Full pipeline: clean → (optional) URL rewrite → split. Exported for the
// harness; the route handler is a thin HTTP shell around this.
export function scanHtml(rawHtml, { originalUrl, fragment = false } = {}) {
  const { html, stats } = cleanHtml(rawHtml);
  const rewritten = originalUrl ? rewriteRelativeUrls(html, originalUrl) : html;
  const sections = splitSections(rewritten, { fragment });
  return { sections, stats };
}

// ---------------------------------------------------------------------------
// HTTP handlers (exported so the harness can mount them behind a stub auth
// WITHOUT weakening the real router, which keeps authenticate above)
// ---------------------------------------------------------------------------

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"

// Optional `css` field shared by /scan and /create: a string capped at 512KB.
// Returns { css } (possibly '') or { errorStatus, error }. Whitespace-only
// CSS is treated as absent — the pane is optional.
function readCssField(body) {
  if (body.css == null) return { css: '' };
  if (typeof body.css !== 'string') {
    return { errorStatus: 400, error: 'css must be a string' };
  }
  if (Buffer.byteLength(body.css, 'utf8') > CSS_MAX) {
    return { errorStatus: 413, error: 'CSS exceeds the 512KB limit' };
  }
  return { css: body.css.trim() ? body.css : '' };
}

// POST /api/v1/page-clone/scan
// { html?, file_base64?, filename?, original_url?, css? } → { sections, stats, css? }
export async function scanHandler(req, res) {
  try {
    const body = req.body || {};
    let html = null;
    let sourceName = '';

    if (typeof body.html === 'string' && body.html.trim()) {
      if (Buffer.byteLength(body.html, 'utf8') > INPUT_MAX) {
        return res.status(413).json({ error: 'Input exceeds the 10MB scan limit' });
      }
      html = body.html;
    } else if (typeof body.file_base64 === 'string' && body.file_base64.trim()) {
      const filename = String(body.filename || '').trim();
      let buf;
      try {
        buf = Buffer.from(body.file_base64, 'base64');
      } catch {
        return res.status(400).json({ error: 'file_base64 is not valid base64' });
      }
      if (!buf.length) {
        return res.status(400).json({ error: 'Uploaded file is empty' });
      }
      if (buf.length > INPUT_MAX) {
        return res.status(413).json({ error: 'Uploaded file exceeds the 10MB scan limit' });
      }
      const isZip =
        /\.zip$/i.test(filename) ||
        (buf.length >= 4 && buf.subarray(0, 4).equals(ZIP_MAGIC));
      if (isZip) {
        // No zip library in package.json and this feature adds no
        // dependencies — refuse with an actionable message instead of
        // guessing at the archive format.
        return res.status(422).json({
          error:
            'ZIP import needs an unzip dependency the server does not ship yet — unzip the export locally and upload the .html file directly',
        });
      }
      html = buf.toString('utf8');
      sourceName = filename.replace(/\.[a-z0-9]+$/i, '');
    } else {
      return res.status(400).json({ error: 'Provide html (paste) or file_base64 (upload)' });
    }

    const cssField = readCssField(body);
    if (cssField.error) {
      return res.status(cssField.errorStatus).json({ error: cssField.error });
    }

    let originalUrl;
    if (body.original_url != null && String(body.original_url).trim()) {
      const raw = String(body.original_url).trim();
      let parsed;
      try {
        parsed = new URL(raw);
      } catch {
        return res.status(400).json({ error: 'original_url must be a valid http(s) URL' });
      }
      if (!/^https?:$/.test(parsed.protocol)) {
        return res.status(400).json({ error: 'original_url must be a valid http(s) URL' });
      }
      originalUrl = parsed.toString();
    }

    const { sections, stats } = scanHtml(html, { originalUrl });
    if (!stats.title && sourceName) stats.title = sourceName;

    const totalBytes = sections.reduce((n, s) => n + s.approx_bytes, 0);
    if (totalBytes > ESCAPE_HATCH_MAX) {
      return res.status(413).json({
        error: 'Cleaned page exceeds the 2MB page limit — clone it in smaller pieces',
      });
    }

    // The optional CSS pane rides the scan result back to the client so the
    // picker step can hand it to /create without re-reading the pane.
    return res.json({
      success: true,
      data: { sections, stats, ...(cssField.css ? { css: cssField.css } : {}) },
    });
  } catch (err) {
    console.error('[page-clone] scan failed:', err);
    return res.status(500).json({ error: 'Scan failed' });
  }
}

// POST /api/v1/page-clone/create
// { funnel_id, title, sections: [html, ...], css? } → new draft 'generic'
// page; `css` lands on funnel_pages.custom_css (renderer injects it as
// <style id="lb-page-css"> on top of the page)
export async function createHandler(req, res) {
  try {
    await ensureTables();
    const body = req.body || {};
    const funnelId = String(body.funnel_id || '').trim();
    const title = String(body.title || '').trim();
    const sections = body.sections;

    if (!funnelId) return res.status(400).json({ error: 'funnel_id is required' });
    if (!title) return res.status(400).json({ error: 'title is required' });
    if (!Array.isArray(sections) || !sections.length) {
      return res.status(400).json({ error: 'sections must be a non-empty array of HTML strings' });
    }
    for (let i = 0; i < sections.length; i++) {
      if (typeof sections[i] !== 'string' || !sections[i].trim()) {
        return res.status(400).json({ error: `sections[${i}] must be a non-empty HTML string` });
      }
    }

    const cssField = readCssField(body);
    if (cssField.error) {
      return res.status(cssField.errorStatus).json({ error: cssField.error });
    }
    const css = cssField.css;

    const funnelRows = await pgQuery(`SELECT * FROM funnels WHERE id = $1`, [funnelId]);
    const funnel = funnelRows[0];
    if (!funnel) return res.status(404).json({ error: 'Funnel not found' });
    if (funnel.archived) {
      return res.status(400).json({ error: 'Funnel is archived — restore it before adding pages' });
    }

    const blocks = sections.map((html) => ({ type: 'section', props: { html } }));
    const blocksError = validateBlocks(blocks);
    if (blocksError) {
      // Same caps as the funnels router; size breaches are 413 here because
      // the client sends a whole scanned page, not a hand-edited field.
      const isSize = /2MB|exceed/i.test(blocksError);
      return res.status(isSize ? 413 : 400).json({ error: blocksError });
    }

    // Unique slug: slugified title, numeric suffix on collision.
    const base = slugify(title) || 'page';
    const existing = await pgQuery(
      `SELECT slug FROM funnel_pages WHERE funnel_id = $1 AND archived = FALSE`,
      [funnelId]
    );
    const taken = new Set(existing.map((r) => r.slug));
    let slug = `/${base}`;
    for (let n = 2; taken.has(slug); n += 1) slug = `/${base}-${n}`;
    if (!PAGE_SLUG_RE.test(slug)) {
      return res.status(400).json({ error: 'Could not derive a valid slug from that title' });
    }

    // is_home is decided by the DATABASE inside the insert itself — never by
    // a prior SELECT (two concurrent first-page creates would both read
    // "empty" and both insert is_home=TRUE). The conditional subquery alone
    // is not enough under READ COMMITTED (both statements' snapshots predate
    // each other's commit), so the transaction first takes a row lock on the
    // parent funnel: concurrent creates for the SAME funnel serialize, and
    // the second one's INSERT statement gets a fresh snapshot that sees the
    // first page — its NOT EXISTS then correctly yields FALSE.
    const INSERT_SQL = `
      INSERT INTO funnel_pages (id, funnel_id, slug, type, title, status, is_home, blocks, custom_css)
      VALUES ($1, $2, $3, 'generic', $4, 'draft',
        NOT EXISTS (SELECT 1 FROM funnel_pages
                    WHERE funnel_id = $2 AND archived = FALSE AND is_home = TRUE),
        $5, $6)
      RETURNING *`;
    const insertLocked = (pageId, pageSlug) =>
      client.begin(async (tx) => {
        await tx`SELECT id FROM funnels WHERE id = ${funnelId} FOR UPDATE`;
        return tx.unsafe(INSERT_SQL, [pageId, funnelId, pageSlug, title, blocks, css]);
      });

    let rows;
    try {
      rows = await insertLocked(genId('fpg'), slug);
    } catch (err) {
      if (err?.code !== UNIQUE_VIOLATION) throw err;
      // Raced another writer for the slug — retry once with a random suffix.
      const retrySlug = `/${base}-${randomBytes(2).toString('hex')}`.slice(0, 81);
      rows = await insertLocked(genId('fpg'), retrySlug);
    }

    return res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[page-clone] create failed:', err);
    return res.status(500).json({ error: 'Failed to create the cloned page' });
  }
}

router.post('/scan', scanHandler);
router.post('/create', createHandler);

export default router;
