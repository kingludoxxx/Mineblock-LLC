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
//      (inline styles allowed, NO <script> — any that appear are stripped
//      server-side with the same posture as pageClone's cleaner).
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
// Script stripping — same posture as pageClone's cleanHtml (steps 2): whole
// <script>…</script> blocks, stray self-closing opens, and (belt) any bare
// unclosed <script …> open tag. Exported for the harness.
// ---------------------------------------------------------------------------
export function stripScripts(html) {
  let out = String(html);
  let removed = 0;
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, () => {
    removed += 1;
    return '';
  });
  out = out.replace(/<script\b[^>]*\/\s*>/gi, () => {
    removed += 1;
    return '';
  });
  // A truncated/unclosed <script …> open tag would swallow the rest of the
  // document in a browser — drop the tag itself (and its orphan close).
  out = out.replace(/<script\b[^>]*>/gi, () => {
    removed += 1;
    return '';
  });
  out = out.replace(/<\/script\s*>/gi, '');
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

    let aborted = false;
    req.on('close', () => {
      aborted = true;
    });

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
      });
      const block = (msg.content || []).find(
        (b) => b.type === 'tool_use' && b.name === 'emit_page_architecture'
      );
      arch = block?.input;
    } catch (err) {
      console.error('[ai-generate] architecture call failed:', err?.message || err);
      return fail('The model could not design the page architecture — try again.');
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
        });
        raw = (msg.content || [])
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('');
      } catch (err) {
        console.error(`[ai-generate] section ${i + 1} failed:`, err?.message || err);
        return fail(
          `Section ${i + 1} ("${sections[i].name}") failed mid-build — the ${emitted} finished section${emitted === 1 ? '' : 's'} above are still usable.`
        );
      }

      const { html } = stripScripts(unfence(raw));
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
