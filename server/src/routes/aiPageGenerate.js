// GENERATE-A-PAGE WITH AI — the Clone modal's "Generate with AI" tab.
//
// POST /api/v1/ai-generate/page takes a text brief and streams back a page
// build as NDJSON lines the UI consumes live:
//
//   {type:'architecture', page_title, sections:[{name,purpose,wants_image,aspect}]}
//   {type:'section', index, name, html, images:[{prompt,aspect}]}   (one per section)
//   {type:'done', total}                                            (clean finish)
//   {type:'error', error}                                           (stream ends; partial sections stay usable)
//
// TWO-PHASE generation against the Anthropic API (@anthropic-ai/sdk):
//   1. ARCHITECTURE — a forced tool call returns {page_title, sections[]}.
//   2. SECTIONS — one request per section returns self-contained HTML
//      (inline styles allowed), sanitized server-side BEFORE it is sent.
//
// SANITIZATION IS STRICTER THAN pageClone's cleaner — deliberately. Cloned
// pages are operator-pasted; generated pages are model output steerable via
// a free-text brief, and /page-clone/create + funnelRender ship props.html
// to the PUBLIC page verbatim. So sanitizeGeneratedHtml() removes script/
// iframe/object/embed/base/form, strips every on* handler attribute, and
// neutralizes javascript:/data: URLs in href/src/srcset/action/style —
// while preserving the lb-ai-image placeholder contract.
//
// Images are NEVER generated here. Where a section needs one, the model
// emits the placeholder contract
//   <div class="lb-ai-image" data-ai-image-prompt="…" data-aspect="16:9">Click to generate image</div>
// so the prompt is preserved in the markup for the AI-Developer rollout.
//
// This route NEVER writes funnel_pages (it does not even import the DB) —
// creation goes through the existing /api/v1/page-clone/create.
import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { checkRateLimit } from '../middleware/rateLimiter.js';

const router = Router();
router.use(authenticate, requirePermission('funnels', 'access'));

// ---------------------------------------------------------------------------
// Caps + model allowlist
// ---------------------------------------------------------------------------
const BRIEF_MAX = 20 * 1024; //  20KB brief
const BRAND_MAX = 2 * 1024; //   2KB "brand colors, fonts, vibe" line
const MAX_SECTIONS = 15; //      architecture is truncated past this
const SECTION_HTML_MAX = 200 * 1024; // 200KB per generated section
const TOTAL_HTML_MAX = 2 * 1024 * 1024; // 2MB across the whole build

// Server-side allowlist — the client dropdown mirrors this exactly.
export const MODEL_ALLOWLIST = new Set([
  'claude-sonnet-5', // best balance (default)
  'claude-fable-5', // frontier
  'claude-opus-5', // deepest
]);
const DEFAULT_MODEL = 'claude-sonnet-5';

// Modest limiter: 10 builds per 10 minutes per user (repo limiter pattern).
const RL_MAX = 10;
const RL_WINDOW_SEC = 600;

// ---------------------------------------------------------------------------
// sanitizeGeneratedHtml — linear quote-aware scanner (same tag-walking
// approach as the client tokenizers), STRICTER than pageClone's cleaner:
//   - <script>/<iframe>/<object> removed WITH their content; <embed>/<base>
//     tags removed; <form> tags unwrapped (open/close dropped, children kept
//     — the submit surface and its action go away, visible copy stays)
//   - every on* attribute stripped (any case, any quoting, `onerror =` too)
//   - javascript:/vbscript:/unknown-scheme URLs dropped from href/src/srcset/
//     action/formaction/poster/xlink:href (entity + control-char tricks
//     decoded first); data: allowed ONLY as data:image/* and ONLY in
//     src/srcset/poster/data-src
//   - url(javascript:…), url(data:non-image…) and expression() neutralized
//     inside <style> bodies and style="" attributes
// The lb-ai-image contract (class + data-ai-image-prompt + data-aspect)
// passes through untouched. Exported for the harness.
// ---------------------------------------------------------------------------
const REMOVE_WITH_CONTENT = new Set(['script', 'iframe', 'object']);
const REMOVE_TAG_ONLY = new Set(['embed', 'base', 'form']); // form = unwrap
const URL_ATTRS = new Set([
  'href', 'src', 'action', 'formaction', 'poster', 'xlink:href', 'data-href', 'data-src',
]);
const DATA_IMAGE_OK = new Set(['src', 'srcset', 'poster', 'data-src']);

// Find the '>' that ends a tag starting at `start`, honouring quoted values.
function findTagEnd(src, start) {
  let quote = null;
  for (let i = start; i < src.length; i += 1) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
  }
  return -1;
}

// Decode the entity/control-char tricks browsers forgive before scheme checks
// (`jav&#x61;script:`, `java\tscript:`, `&Tab;` …).
const decodeForSchemeCheck = (value) =>
  String(value)
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; }
    })
    .replace(/&#(\d+);?/g, (_, d) => {
      try { return String.fromCodePoint(Number(d)); } catch { return ''; }
    })
    .replace(/&tab;/gi, '\t')
    .replace(/&newline;/gi, '\n')
    .replace(/&colon;/gi, ':')
    .replace(/&amp;/gi, '&')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0020]+/g, '');

function isSafeUrl(value, attrLower) {
  const cleaned = decodeForSchemeCheck(value);
  const m = cleaned.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!m) return true; // relative path, fragment, protocol-relative
  const scheme = m[1].toLowerCase();
  if (scheme === 'data') {
    return DATA_IMAGE_OK.has(attrLower) && /^data:image\//i.test(cleaned);
  }
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel';
}

// Neutralize the CSS-side vectors; layout CSS passes through untouched.
export function sanitizeCss(css) {
  return String(css)
    .replace(/expression\s*\(/gi, 'blocked(')
    .replace(/url\(\s*(['"]?)\s*(?:javascript|vbscript)[^)]*\)/gi, 'url()')
    .replace(/url\(\s*(['"]?)\s*data:(?!image\/)[^)]*\)/gi, 'url()');
}

// Rebuild one open tag from its parsed attributes, dropping the unsafe ones.
function sanitizeTag(raw) {
  const head = raw.match(/^<[a-zA-Z][a-zA-Z0-9:-]*/)[0];
  let rest = raw.slice(head.length);
  const tail = rest.match(/\/?\s*>$/)?.[0] ?? '>';
  rest = rest.slice(0, rest.length - tail.length);

  let out = head;
  const attrRe = /([^\s=>/'"]+)(\s*=\s*("[^"]*"|'[^']*'|[^\s>]*))?/g;
  let a;
  while ((a = attrRe.exec(rest))) {
    const name = a[1];
    const lower = name.toLowerCase();
    if (lower.startsWith('on')) continue; // every handler attribute
    if (a[2] === undefined) { out += ` ${name}`; continue; } // boolean attr
    const rawVal = a[3] ?? '';
    const quote = rawVal[0] === '"' || rawVal[0] === "'" ? rawVal[0] : '';
    let val = quote ? rawVal.slice(1, -1) : rawVal;

    if (lower === 'srcset') {
      const kept = val
        .split(',')
        .map((e) => e.trim())
        .filter(Boolean)
        .filter((entry) => isSafeUrl(entry.split(/\s+/)[0], 'srcset'));
      if (!kept.length) continue;
      val = kept.join(', ');
    } else if (URL_ATTRS.has(lower)) {
      if (!isSafeUrl(val, lower)) continue;
    } else if (lower === 'style') {
      val = sanitizeCss(val);
    }
    out += quote
      ? ` ${name}=${quote}${val}${quote}`
      : ` ${name}="${val.replace(/"/g, '&quot;')}"`;
  }
  return out + tail;
}

export function sanitizeGeneratedHtml(html) {
  const src = String(html);
  let out = '';
  let removed = 0;
  let i = 0;
  while (i < src.length) {
    if (src[i] !== '<') {
      const next = src.indexOf('<', i);
      const stop = next === -1 ? src.length : next;
      out += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      const stop = end === -1 ? src.length : end + 3;
      out += src.slice(i, stop);
      i = stop;
      continue;
    }
    const end = findTagEnd(src, i);
    if (end === -1) { out += src.slice(i); break; } // unterminated — inert text
    const raw = src.slice(i, end + 1);
    const m = raw.match(/^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/);
    if (!m) { out += raw; i = end + 1; continue; } // doctype / decl
    const isClose = m[1] === '/';
    const name = m[2].toLowerCase();
    const selfClosed = /\/\s*>$/.test(raw);
    i = end + 1;

    if (REMOVE_WITH_CONTENT.has(name)) {
      removed += 1;
      if (!isClose && !selfClosed) {
        const close = src.slice(i).match(new RegExp(`</${name}\\s*>`, 'i'));
        i = close ? i + close.index + close[0].length : src.length;
      }
      continue;
    }
    if (REMOVE_TAG_ONLY.has(name)) { removed += 1; continue; } // unwrap
    if (isClose) { out += raw; continue; }

    out += sanitizeTag(raw);

    if (name === 'style' && !selfClosed) {
      const close = src.slice(i).match(/<\/style\s*>/i);
      const body = close ? src.slice(i, i + close.index) : src.slice(i);
      out += sanitizeCss(body);
      if (close) {
        out += close[0];
        i += close.index + close[0].length;
      } else {
        i = src.length;
      }
    }
  }
  return { html: out, removed };
}

// Pull the lb-ai-image placeholders out of a section so the UI can show an
// image-count chip without re-parsing. Exported for the harness.
export function extractImageSlots(html) {
  const slots = [];
  const tagRe = /<[^>]*\bdata-ai-image-prompt\s*=[^>]*>/gi;
  let m;
  while ((m = tagRe.exec(String(html)))) {
    const tag = m[0];
    const p = tag.match(/\bdata-ai-image-prompt\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const a = tag.match(/\bdata-aspect\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    slots.push({
      prompt: (p && (p[1] ?? p[2])) || '',
      aspect: (a && (a[1] ?? a[2])) || '16:9',
    });
  }
  return slots;
}

// Models love to wrap HTML in markdown fences even when told not to.
const unfence = (text) => {
  const t = String(text).trim();
  const m = t.match(/^```(?:html)?\s*\n([\s\S]*?)\n?```\s*$/);
  return m ? m[1] : t;
};

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
const ARCHITECTURE_TOOL = {
  name: 'emit_page_architecture',
  description:
    'Emit the landing-page architecture: a short page title and an ordered list of the sections the page needs.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      page_title: {
        type: 'string',
        description: 'Short human-readable page title (3-8 words).',
      },
      sections: {
        type: 'array',
        description: 'Ordered page sections, top to bottom. 4-12 sections is typical.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: {
              type: 'string',
              description: 'Short section name, e.g. "Masthead + Kicker", "Hero Figure".',
            },
            purpose: {
              type: 'string',
              description: 'One sentence: what this section must accomplish.',
            },
            wants_image: {
              type: 'boolean',
              description: 'True when the section needs a generated image slot.',
            },
            aspect: {
              type: 'string',
              description: 'Aspect ratio for the image slot, e.g. "16:9", "1:1", "4:5".',
            },
          },
          required: ['name', 'purpose', 'wants_image'],
        },
      },
    },
    required: ['page_title', 'sections'],
  },
};

const IMAGE_CONTRACT = `Wherever the section needs a generated image, emit EXACTLY this placeholder element (never an <img> with an invented URL, never base64):
<div class="lb-ai-image" data-ai-image-prompt="…a detailed, self-contained image generation prompt…" data-aspect="16:9">Click to generate image</div>
Put the full art-direction into data-ai-image-prompt (subject, style, lighting, mood) and the right ratio into data-aspect. Style the placeholder inline as a pale box with centered text.`;

const SECTION_SYSTEM = `You write ONE section of a high-converting landing page as self-contained HTML.
Rules:
- Output ONLY the raw HTML for the section — no markdown fences, no commentary, no <html>/<head>/<body> wrapper.
- Inline styles are allowed and encouraged; the section must look finished on a plain white page with no external CSS.
- NEVER include <script> tags, event-handler attributes (onclick etc.), external stylesheets, fonts, iframes, or tracking of any kind.
- ${IMAGE_CONTRACT}`;

const archUserPrompt = (brief, brand) =>
  `Design the section architecture for this landing page brief:\n\n<brief>\n${brief}\n</brief>\n${
    brand ? `\n<brand>\n${brand}\n</brand>\n` : ''
  }\nCall emit_page_architecture with the page title and the ordered sections.`;

const sectionUserPrompt = ({ brief, brand, pageTitle, sections, index }) => {
  const s = sections[index];
  const outline = sections
    .map((x, i) => `${i + 1}. ${x.name} — ${x.purpose}${i === index ? '   <== YOU ARE WRITING THIS ONE' : ''}`)
    .join('\n');
  return `Page: "${pageTitle}"

Full brief:
<brief>
${brief}
</brief>
${brand ? `\nBrand notes:\n<brand>\n${brand}\n</brand>\n` : ''}
Page outline:
${outline}

Write section ${index + 1}: "${s.name}" (${s.purpose}).${
    s.wants_image
      ? ` This section needs ${s.aspect ? `a ${s.aspect}` : 'an'} image slot — use the lb-ai-image placeholder contract.`
      : ' This section needs no image.'
  }
Output only the section HTML.`;
};

// ---------------------------------------------------------------------------
// POST /api/v1/ai-generate/page  (exported for the verification harness —
// the real router above keeps authenticate + requirePermission)
// ---------------------------------------------------------------------------
export async function generateHandler(req, res) {
  try {
    const body = req.body || {};

    // ---- Validation (plain JSON errors — nothing streamed yet) ----------
    if (typeof body.brief !== 'string' || !body.brief.trim()) {
      return res.status(400).json({ error: 'brief is required' });
    }
    if (Buffer.byteLength(body.brief, 'utf8') > BRIEF_MAX) {
      return res.status(413).json({ error: 'brief exceeds the 20KB limit' });
    }
    if (body.brand != null && typeof body.brand !== 'string') {
      return res.status(400).json({ error: 'brand must be a string' });
    }
    const brand = typeof body.brand === 'string' ? body.brand.trim() : '';
    if (Buffer.byteLength(brand, 'utf8') > BRAND_MAX) {
      return res.status(413).json({ error: 'brand exceeds the 2KB limit' });
    }
    const model = body.model == null ? DEFAULT_MODEL : String(body.model);
    if (!MODEL_ALLOWLIST.has(model)) {
      return res.status(400).json({
        error: `model must be one of: ${[...MODEL_ALLOWLIST].join(', ')}`,
      });
    }
    const brief = body.brief;

    // ---- Rate limit (per user; IP fallback keeps the key non-empty) -----
    const rl = await checkRateLimit(
      `ai-generate:${req.user?.id || req.ip}`,
      RL_MAX,
      RL_WINDOW_SEC
    );
    if (!rl.allowed) {
      res.set('Retry-After', String(rl.retryAfter));
      return res.status(429).json({
        error: `Too many builds — try again in ${rl.retryAfter}s`,
      });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'AI generation is not configured (missing API key)' });
    }

    // ---- Switch to the NDJSON stream ------------------------------------
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    // Client disconnect aborts the in-flight Anthropic call too — no point
    // finishing a build nobody is reading. NOTE: on a streaming response the
    // reliable disconnect signal is `res` 'close' with writableEnded still
    // false (`req` 'close' fires at message completion in modern Node, not
    // on connection teardown).
    let aborted = false;
    const upstream = new AbortController();
    const onGone = () => {
      if (!res.writableEnded && !aborted) {
        aborted = true;
        upstream.abort();
      }
    };
    res.on('close', onGone);
    req.on('error', onGone);

    // Per-request timeout on every model call (default 120s; env-overridable
    // so the harness can exercise the timeout path); maxRetries 1 bounds a
    // flaky upstream to two attempts instead of the SDK's default three. A
    // hung call fails the phase with a clean error event instead of holding
    // the stream open forever.
    const CALL_TIMEOUT_MS =
      Number(process.env.AI_GENERATE_CALL_TIMEOUT_MS) > 0
        ? Number(process.env.AI_GENERATE_CALL_TIMEOUT_MS)
        : 120_000;
    const timeoutSecs = Math.round(CALL_TIMEOUT_MS / 1000);
    const callOpts = { signal: upstream.signal, timeout: CALL_TIMEOUT_MS, maxRetries: 1 };
    const isTimeout = (err) =>
      err?.name === 'APIConnectionTimeoutError' || /timed?\s?out/i.test(err?.message || '');

    const send = (obj) => {
      if (!aborted && !res.writableEnded) res.write(`${JSON.stringify(obj)}\n`);
    };
    const fail = (message) => {
      send({ type: 'error', error: message });
      res.end();
    };

    // baseURL honours ANTHROPIC_BASE_URL automatically (mockable in tests).
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // ---- Phase 1: architecture (forced tool call) -----------------------
    let arch;
    try {
      const msg = await client.messages.create({
        model,
        max_tokens: 4096,
        tools: [ARCHITECTURE_TOOL],
        tool_choice: { type: 'tool', name: 'emit_page_architecture' },
        messages: [{ role: 'user', content: archUserPrompt(brief, brand) }],
      }, callOpts);
      const block = (msg.content || []).find(
        (b) => b.type === 'tool_use' && b.name === 'emit_page_architecture'
      );
      arch = block?.input;
    } catch (err) {
      if (aborted) return undefined; // client hung up — nothing to report to
      console.error('[ai-generate] architecture call failed:', err?.message || err);
      return fail(
        isTimeout(err)
          ? `The architecture phase timed out after ${timeoutSecs}s — try again.`
          : 'The model could not design the page architecture — try again.'
      );
    }
    if (!arch || !Array.isArray(arch.sections) || !arch.sections.length) {
      return fail('The model returned no page architecture — try a more specific brief.');
    }

    const pageTitle = String(arch.page_title || 'AI generated page').slice(0, 200);
    const sections = arch.sections.slice(0, MAX_SECTIONS).map((s) => ({
      name: String(s?.name || 'Section').slice(0, 120),
      purpose: String(s?.purpose || '').slice(0, 400),
      wants_image: Boolean(s?.wants_image),
      aspect: typeof s?.aspect === 'string' ? s.aspect.slice(0, 12) : '16:9',
    }));

    send({ type: 'architecture', page_title: pageTitle, sections });

    // ---- Phase 2: one request per section, streamed out as each lands ---
    let totalBytes = 0;
    let emitted = 0;
    for (let i = 0; i < sections.length; i += 1) {
      if (aborted) return; // client went away — stop burning tokens
      let raw;
      try {
        const msg = await client.messages.create({
          model,
          max_tokens: 8192,
          system: SECTION_SYSTEM,
          messages: [
            { role: 'user', content: sectionUserPrompt({ brief, brand, pageTitle, sections, index: i }) },
          ],
        }, callOpts);
        raw = (msg.content || [])
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('');
      } catch (err) {
        if (aborted) return undefined; // client hung up — nothing to report to
        console.error(`[ai-generate] section ${i + 1} failed:`, err?.message || err);
        return fail(
          isTimeout(err)
            ? `Section ${i + 1} ("${sections[i].name}") timed out after ${timeoutSecs}s — the ${emitted} finished section${emitted === 1 ? '' : 's'} above are still usable.`
            : `Section ${i + 1} ("${sections[i].name}") failed mid-build — the ${emitted} finished section${emitted === 1 ? '' : 's'} above are still usable.`
        );
      }

      const { html } = sanitizeGeneratedHtml(unfence(raw));
      const trimmed = html.trim();
      if (!trimmed) {
        return fail(`Section ${i + 1} ("${sections[i].name}") came back empty — try again.`);
      }
      const bytes = Buffer.byteLength(trimmed, 'utf8');
      if (bytes > SECTION_HTML_MAX) {
        return fail(`Section ${i + 1} exceeds the 200KB section limit — simplify the brief.`);
      }
      totalBytes += bytes;
      if (totalBytes > TOTAL_HTML_MAX) {
        return fail('The generated page exceeds the 2MB page limit — reduce the section count.');
      }

      send({
        type: 'section',
        index: i,
        name: sections[i].name,
        html: trimmed,
        images: extractImageSlots(trimmed),
      });
      emitted += 1;
    }

    send({ type: 'done', total: emitted });
    return res.end();
  } catch (err) {
    console.error('[ai-generate] failed:', err);
    if (res.headersSent) {
      if (!res.writableEnded) {
        res.write(`${JSON.stringify({ type: 'error', error: 'Generation failed' })}\n`);
        res.end();
      }
      return undefined;
    }
    return res.status(500).json({ error: 'Generation failed' });
  }
}

router.post('/page', generateHandler);

export default router;
