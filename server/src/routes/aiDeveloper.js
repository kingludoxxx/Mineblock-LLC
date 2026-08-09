// AI DEVELOPER — Claude-powered chat that PROPOSES block edits for the page
// builder, plus Higgsfield image/video generation as async jobs.
//
// HARD RULE (spec): this route is READ + PROPOSE ONLY. It loads funnel_pages
// to build context and NEVER writes them — the editor applies returned ops to
// its in-memory state (undo/redo compatible) and the operator persists via
// the existing Save / Re-publish. There is no pgQuery UPDATE/INSERT anywhere
// in this file, by design; keep it that way.
//
// POST /api/v1/ai-developer/chat   → SSE stream: text deltas, job events,
//                                    final {reply, ops, jobs}
// GET  /api/v1/ai-developer/jobs/:id → proxied Higgsfield job status
import { randomBytes, createHmac, timingSafeEqual } from 'crypto';
import { Router } from 'express';
import env from '../config/env.js';
import { pgQuery } from '../db/pg.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { checkRateLimit } from '../middleware/rateLimiter.js';
import { validateBlocks } from './funnels.js';
import { createImageJob, createVideoJob, getJob, isAllowedAssetUrl } from '../services/higgsfield.js';

const router = Router();
router.use(authenticate, requirePermission('funnels', 'access'));

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------
const MODEL_ALLOWLIST = ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5'];
const DEFAULT_MODEL = 'claude-fable-5';
const MAX_MESSAGES = 40; // conversation length cap (client trims too)
const MAX_TEXT_CHARS = 20_000; // per message text
const MAX_IMAGES = 5; // per request
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // decoded bytes per image
const MAX_TOOL_ROUNDS = 6;
const MAX_OPS_PER_CALL = 20;
const CHAT_LIMIT = parseInt(process.env.AI_DEV_CHAT_LIMIT, 10) || 20; // requests…
const CHAT_WINDOW_SEC = 5 * 60; // …per user per 5 minutes

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Op validation — the same defense funnels.js applies on write, applied to
// the SIMULATED result of the proposed ops, plus per-op referential checks
// against the REAL block ids of the current draft.
// ---------------------------------------------------------------------------
const OP_TYPES = new Set(['replace_props', 'insert_block', 'remove_block', 'move_block']);
const genBlockId = () => `blk_ai_${randomBytes(5).toString('hex')}`;

// ---------------------------------------------------------------------------
// Executable-HTML defense (review MAJOR #1). funnelRender emits html-bearing
// props VERBATIM on public pages while the admin canvas previews them in
// sandbox="" — so a prompt-injected model could smuggle a live <script> the
// operator never sees run before publishing. Every op that introduces or
// modifies an HTML-bearing prop (props.html / props.css / props.embed /
// row props.columns[].html) is scanned with LINEAR passes (not one fragile
// regex) and rejected so Claude re-emits cleanly.
// ---------------------------------------------------------------------------
const BANNED_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'base', 'form']);

// Returns a short human description of the first dangerous construct found,
// or null when the string is clean.
export function scanHtmlString(value) {
  const lower = String(value).toLowerCase();
  const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

  // 1. Banned tags — walk each '<', skip whitespace and '/', read the tag
  //    name. Catches any casing and `<  script`/`</script` style tricks.
  for (let i = 0; i < lower.length; i++) {
    if (lower[i] !== '<') continue;
    let j = i + 1;
    while (j < lower.length && (isWs(lower[j]) || lower[j] === '/')) j++;
    let name = '';
    while (j < lower.length && lower[j] >= 'a' && lower[j] <= 'z') { name += lower[j]; j++; }
    if (BANNED_TAGS.has(name)) return `a <${name}> tag`;
  }

  // 2. Event-handler attributes: "on" + letters + optional whitespace + "=",
  //    at a word boundary. Catches onclick=, onerror = , unquoted variants.
  for (let i = 0; i + 2 < lower.length; i++) {
    if (lower[i] !== 'o' || lower[i + 1] !== 'n') continue;
    const prev = i === 0 ? '' : lower[i - 1];
    if (prev && /[a-z0-9_-]/.test(prev)) continue; // inside a word (button, salon…)
    let j = i + 2;
    let letters = 0;
    while (j < lower.length && lower[j] >= 'a' && lower[j] <= 'z') { j++; letters++; }
    if (!letters) continue; // bare "on =" is not an event handler
    let k = j;
    while (k < lower.length && isWs(lower[k])) k++;
    if (lower[k] === '=') return `an ${lower.slice(i, j)}= event handler`;
  }

  // 3. Dangerous URL schemes — scan a copy with browser-ignored whitespace/
  //    control chars stripped so "jav\nascript:" tricks collapse. Covers
  //    href/src/srcset/action AND url(javascript:…) in style/css.
  const compact = lower.replace(/[\s\u0000-\u001f]+/g, '');
  if (compact.includes('javascript:')) return 'a javascript: URL';
  if (compact.includes('data:text/html')) return 'a data:text/html URL';

  return null;
}

// Scan the HTML-bearing props of a props object. Non-HTML props (headline,
// text, items, …) are untouched — the public renderer escapes those.
function scanHtmlProps(props) {
  if (!isPlainObject(props)) return null;
  const check = (val, where) => {
    if (typeof val !== 'string') return null;
    const hit = scanHtmlString(val);
    return hit ? `${where} contains ${hit}` : null;
  };
  let err = check(props.html, 'html') || check(props.css, 'css') || check(props.embed, 'embed');
  if (err) return err;
  if (Array.isArray(props.columns)) {
    for (let c = 0; c < props.columns.length; c++) {
      const col = props.columns[c];
      if (isPlainObject(col)) {
        err = check(col.html, `columns[${c}].html`);
        if (err) return err;
      }
    }
  }
  return null;
}

const htmlRejection = (i, detail) =>
  `ops[${i}]: raw script/event-handler/javascript: content is not allowed (${detail}); re-emit the op without it — no <script>/<iframe>/<object>/<embed>/<base>/<form> tags, no on*= attributes, no javascript: or data:text/html URLs`;

// ---------------------------------------------------------------------------
// Job → user binding (review MINOR #2). Stateless: an HMAC-SHA256 tag over
// jobId + userId, keyed with the server's existing JWT access secret (the
// same secret the auth middleware verifies with). The tag is handed to the
// creating user in the SSE job event and must come back on every poll via
// the X-Job-Token HEADER (never the URL). No DB writes — survives restarts.
// ---------------------------------------------------------------------------
export function jobToken(jobId, userId) {
  return createHmac('sha256', env.JWT_ACCESS_SECRET)
    .update(`${jobId}:${userId}`)
    .digest('hex');
}

function verifyJobToken(jobId, userId, provided) {
  if (typeof provided !== 'string' || !provided) return false;
  const expected = Buffer.from(jobToken(jobId, userId), 'utf8');
  const given = Buffer.from(provided, 'utf8');
  if (given.length !== expected.length) return false;
  return timingSafeEqual(expected, given);
}

// ---------------------------------------------------------------------------
// Wiring floor (review MAJOR #4)
// ---------------------------------------------------------------------------
// `replace_props` is a WHOLESALE overwrite of a block's props. A model asked to
// "rewrite the headline" on a checkout block routinely re-emits the props it
// was thinking about and drops the rest — and the rest is the wiring: the block
// still renders, still looks right in the editor, and no longer charges.
//
// These keys are therefore carried forward from the block's CURRENT props
// whenever an op does not mention them. An op that DOES mention a key wins,
// including setting it to null — clearing wiring on purpose is legal, losing
// it by omission is not.
//
// MIRRORED CLIENT-SIDE in client/src/pages/funnels/builder/builderModel.js
// (WIRING_KEYS / mergeReplaceProps). Both lists must move together: this one
// keeps the ops the model is told it applied honest, the client one keeps the
// draft on the operator's screen honest.
export const WIRING_KEYS = Object.freeze([
  'variant_id',
  'line_items',
  'offer_id',
  'quantity',
  'product_id',
  'price_id',
  'style',
  'mobile_styles',
  'block_name',
]);

export function mergeReplaceProps(prev, next) {
  const p = isPlainObject(prev) ? prev : {};
  const n = isPlainObject(next) ? next : {};
  const out = { ...n };
  for (const k of WIRING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(n, k)) continue; // explicitly set
    if (Object.prototype.hasOwnProperty.call(p, k)) out[k] = p[k];
  }
  return out;
}

// Returns { error } or { blocks, ops } where ops is the normalized list and
// blocks is the state after applying them. Pure — never mutates input.
export function applyOps(currentBlocks, rawOps) {
  if (!Array.isArray(rawOps)) return { error: 'ops must be an array' };
  if (!rawOps.length) return { error: 'ops is empty — propose at least one operation' };
  if (rawOps.length > MAX_OPS_PER_CALL) return { error: `at most ${MAX_OPS_PER_CALL} ops per call` };

  let blocks = currentBlocks.map((b) => ({ ...b }));
  const ops = [];

  for (let i = 0; i < rawOps.length; i++) {
    const op = rawOps[i];
    if (!isPlainObject(op) || typeof op.op !== 'string' || !OP_TYPES.has(op.op)) {
      return { error: `ops[${i}]: op must be one of ${[...OP_TYPES].join(', ')}` };
    }
    const idx = blocks.findIndex((b) => b.id === op.block_id);

    if (op.op === 'replace_props') {
      if (idx === -1) return { error: `ops[${i}]: unknown block_id "${op.block_id}" — use an id from the page's block JSON` };
      if (!isPlainObject(op.props)) return { error: `ops[${i}]: props must be a plain object` };
      const htmlErr = scanHtmlProps(op.props);
      if (htmlErr) return { error: htmlRejection(i, htmlErr) };
      // The wiring floor is applied to the NORMALIZED op that goes back to the
      // client as well as to the simulated result — the editor must apply the
      // same props this validator approved, not the model's raw object.
      const merged = mergeReplaceProps(blocks[idx].props, op.props);
      blocks[idx] = { ...blocks[idx], props: merged };
      ops.push({ op: 'replace_props', block_id: op.block_id, props: merged });
    } else if (op.op === 'remove_block') {
      if (idx === -1) return { error: `ops[${i}]: unknown block_id "${op.block_id}"` };
      blocks.splice(idx, 1);
      ops.push({ op: 'remove_block', block_id: op.block_id });
    } else if (op.op === 'move_block') {
      if (idx === -1) return { error: `ops[${i}]: unknown block_id "${op.block_id}"` };
      const to = Number(op.index);
      if (!Number.isInteger(to) || to < 0 || to > blocks.length - 1) {
        return { error: `ops[${i}]: index must be an integer between 0 and ${blocks.length - 1}` };
      }
      const [b] = blocks.splice(idx, 1);
      blocks.splice(to, 0, b);
      ops.push({ op: 'move_block', block_id: op.block_id, index: to });
    } else { // insert_block
      const blk = op.block;
      if (!isPlainObject(blk)) return { error: `ops[${i}]: block must be an object {type, props}` };
      if (typeof blk.type !== 'string' || !blk.type.trim()) {
        return { error: `ops[${i}]: block.type must be a non-empty string` };
      }
      if (blk.props !== undefined && !isPlainObject(blk.props)) {
        return { error: `ops[${i}]: block.props must be a plain object` };
      }
      const htmlErr = scanHtmlProps(blk.props);
      if (htmlErr) return { error: htmlRejection(i, htmlErr) };
      let id = typeof blk.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(blk.id) ? blk.id : genBlockId();
      if (blocks.some((b) => b.id === id)) id = genBlockId();
      const at = op.index === undefined ? blocks.length : Number(op.index);
      if (!Number.isInteger(at) || at < 0 || at > blocks.length) {
        return { error: `ops[${i}]: index must be an integer between 0 and ${blocks.length}` };
      }
      const inserted = { id, type: blk.type.trim(), props: blk.props || {} };
      blocks.splice(at, 0, inserted);
      ops.push({ op: 'insert_block', index: at, block: inserted });
    }
  }

  // Same size / proto / depth / count caps funnels.js enforces on write —
  // an op set that would be rejected at save time is rejected here.
  const validationError = validateBlocks(blocks);
  if (validationError) return { error: `resulting blocks are invalid: ${validationError}` };
  return { blocks, ops };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'propose_block_edits',
    description:
      'Propose edits to the current page draft. Ops apply IN ORDER to the editor\'s in-memory blocks — they are a DRAFT the operator reviews on the canvas; nothing is published. block_id values MUST come from the block JSON in the system prompt (or from ids returned by earlier insert_block ops this conversation). replace_props REPLACES the whole props object, so copy unchanged keys over — except wiring keys (variant_id, line_items, offer_id, quantity, product_id, price_id, style, mobile_styles, block_name), which are carried over from the block\'s current props when omitted.',
    input_schema: {
      type: 'object',
      properties: {
        ops: {
          type: 'array',
          description: 'Ordered list of operations',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['replace_props', 'insert_block', 'remove_block', 'move_block'] },
              block_id: { type: 'string', description: 'Target block id (replace_props / remove_block / move_block)' },
              index: { type: 'integer', description: 'Target position (insert_block / move_block)' },
              props: { type: 'object', description: 'FULL replacement props object (replace_props)' },
              block: { type: 'object', description: 'New block {type, props} (insert_block)' },
            },
            required: ['op'],
          },
        },
      },
      required: ['ops'],
    },
  },
  {
    name: 'generate_image',
    description:
      'Start an ASYNC Higgsfield image generation job. Returns a job id immediately — the asset is NOT ready yet. A job card appears in the chat; when it finishes the operator clicks "Use it" (or asks you) and you swap the resulting URL into the right block with a normal propose_block_edits call. Explain this async flow in your reply.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed image prompt' },
        aspect_ratio: { type: 'string', description: 'e.g. "16:9", "1:1", "9:16"' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'generate_video',
    description:
      'Start an ASYNC Higgsfield video generation job (optionally from a source image URL). Same async flow as generate_image: job id now, asset later, swapped in via propose_block_edits once the operator confirms.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Motion / scene prompt' },
        image_url: { type: 'string', description: 'Optional source image URL (must be a Higgsfield asset)' },
        duration: { type: 'integer', description: 'Seconds (1-15)' },
      },
      required: ['prompt'],
    },
  },
];

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------
function buildSystemPrompt({ page, funnel, blocks, attachment }) {
  const brand = isPlainObject(funnel.settings) ? funnel.settings : {};
  // Only the styling-relevant slice of settings, size-capped — never the
  // funnel-level code fields (2MB escape hatches don't belong in a prompt).
  const brandSlice = {};
  for (const k of ['brand_color', 'accent_color', 'background_color', 'text_color', 'font_family', 'heading_font', 'body_font', 'logo_url', 'colors', 'fonts']) {
    if (brand[k] !== undefined) brandSlice[k] = brand[k];
  }
  let brandJson = JSON.stringify(brandSlice);
  if (brandJson.length > 4000) brandJson = '{}';

  const attachmentLine = attachment
    ? `The operator has ATTACHED a specific block as the target: block_id "${attachment.block_id}" (type "${attachment.block_type || 'unknown'}"). Unless they clearly ask about something else, scope your edits to this block.`
    : 'No block is attached — the whole page is in scope.';

  return `You are the AI Developer inside a funnel page builder. You edit the CURRENT page's blocks on the operator's instruction by calling tools. You never output raw block JSON in prose — all edits go through the propose_block_edits tool.

REQUIRED METHODOLOGY — follow these four steps, in order, in every reply that changes the page:
1. RESTATE — one short sentence restating what the operator asked for.
2. LOCATE — name the exact target block(s) by id AND quote a fragment of their current content so the operator can verify you found the right one.
3. PLAN — one or two sentences on what you will change.
4. EDIT — call propose_block_edits with the ops. Then confirm briefly what changed.

DRAFT SEMANTICS: your edits apply to the editor's in-memory draft only. The operator reviews them on the canvas and publishes with the existing Save & publish. Never claim anything is live.

MEDIA GENERATION: generate_image / generate_video are ASYNC. When you start one, tell the operator the asset is being generated, that a job card will appear in this chat, and that once it's ready they can click "Use it" (or ask you) to have the URL swapped into the block via a normal edit. Do NOT invent asset URLs — only use URLs given to you in the conversation.

PAGE CONTEXT
- Funnel: ${JSON.stringify(String(funnel.name || ''))} (slug ${JSON.stringify(String(funnel.slug || ''))})
- Page: ${JSON.stringify(String(page.title || ''))} — type "${page.type}", slug "${page.slug}", status "${page.status}"
- Brand settings: ${brandJson}
- ${attachmentLine}

CURRENT BLOCKS (the draft, as JSON with ids — these ids are the ONLY valid block_id values):
${JSON.stringify(blocks)}

OUTPUT CONTRACT (strict):
- Edits ONLY via propose_block_edits. Never print ops or block JSON as text.
- replace_props sends the FULL new props object (it replaces, not merges). One exception, applied for you: wiring keys (${WIRING_KEYS.join(', ')}) are carried over from the block's current props when you omit them, so you cannot delete a block's checkout wiring or its style bags by leaving them out. To CHANGE one, set it explicitly.
- Respect the block schema you see: keep the same prop keys/shapes the block already uses; text-bearing props are plain strings; html props are raw HTML.
- Blocks are capped at 500 per page and 2MB total; keep edits lean.
- If the request is ambiguous about which block, say which one you picked in LOCATE and why.
- If asked to do something outside this page's blocks (server code, other pages, checkout pricing), say you can't from here.`;
}

// ---------------------------------------------------------------------------
// Request validation helpers
// ---------------------------------------------------------------------------
function validateChatBody(body) {
  if (!isPlainObject(body)) return { error: 'body must be an object' };
  const pageId = typeof body.page_id === 'string' ? body.page_id : '';
  const funnelId = typeof body.funnel_id === 'string' ? body.funnel_id : '';
  if (!pageId || !funnelId) return { error: 'page_id and funnel_id are required' };

  const model = body.model === undefined ? DEFAULT_MODEL : String(body.model);
  if (!MODEL_ALLOWLIST.includes(model)) {
    return { error: `model must be one of: ${MODEL_ALLOWLIST.join(', ')}` };
  }

  if (!Array.isArray(body.messages) || !body.messages.length) {
    return { error: 'messages must be a non-empty array' };
  }
  if (body.messages.length > MAX_MESSAGES) {
    return { error: `conversation too long — at most ${MAX_MESSAGES} messages` };
  }
  const messages = [];
  for (let i = 0; i < body.messages.length; i++) {
    const m = body.messages[i];
    if (!isPlainObject(m) || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string') {
      return { error: `messages[${i}] must be {role: user|assistant, content: string}` };
    }
    if (m.content.length > MAX_TEXT_CHARS) {
      return { error: `messages[${i}] exceeds ${MAX_TEXT_CHARS} characters` };
    }
    messages.push({ role: m.role, content: m.content });
  }
  if (messages[messages.length - 1].role !== 'user') {
    return { error: 'the last message must be from the user' };
  }

  // Pasted / dropped screenshots → vision blocks on the LAST user message.
  const images = [];
  if (body.images !== undefined) {
    if (!Array.isArray(body.images)) return { error: 'images must be an array' };
    if (body.images.length > MAX_IMAGES) return { error: `at most ${MAX_IMAGES} images per message` };
    for (let i = 0; i < body.images.length; i++) {
      const img = body.images[i];
      const str = typeof img === 'string' ? img : (isPlainObject(img) ? String(img.data || '') : '');
      const mtMatch = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(str);
      const mediaType = mtMatch ? mtMatch[1] : (isPlainObject(img) && typeof img.media_type === 'string' ? img.media_type : 'image/png');
      const b64 = mtMatch ? mtMatch[2] : str;
      if (!b64 || !/^[A-Za-z0-9+/=\r\n]+$/.test(b64)) return { error: `images[${i}] must be base64 (or a data: URL)` };
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType)) {
        return { error: `images[${i}] has an unsupported media type` };
      }
      const bytes = Math.floor((b64.replace(/[\r\n=]/g, '').length * 3) / 4);
      if (bytes > MAX_IMAGE_BYTES) return { error: `images[${i}] exceeds 2MB` };
      images.push({ media_type: mediaType, data: b64.replace(/[\r\n]/g, '') });
    }
  }

  // Optional attachment (context targeting).
  let attachment = null;
  if (body.attachment !== undefined && body.attachment !== null) {
    if (!isPlainObject(body.attachment)) return { error: 'attachment must be an object' };
    const bid = typeof body.attachment.block_id === 'string' ? body.attachment.block_id.slice(0, 128) : '';
    if (bid) {
      attachment = {
        block_id: bid,
        block_type: typeof body.attachment.kind === 'string' ? body.attachment.kind.slice(0, 64)
          : (typeof body.attachment.block_type === 'string' ? body.attachment.block_type.slice(0, 64) : ''),
        block_path: typeof body.attachment.block_path === 'string' ? body.attachment.block_path.slice(0, 128) : '',
      };
    }
  }

  // Optional: the editor's CURRENT in-memory draft blocks. If valid, they are
  // the context (draft > DB row); otherwise we fall back to the stored row.
  let draftBlocks = null;
  if (Array.isArray(body.blocks)) {
    const err = validateBlocks(body.blocks);
    const allHaveIds = body.blocks.every((b) => isPlainObject(b) && typeof b.id === 'string' && b.id.length <= 128);
    if (!err && allHaveIds) draftBlocks = body.blocks;
  }

  return { pageId, funnelId, model, messages, images, attachment, draftBlocks };
}

// ---------------------------------------------------------------------------
// SSE plumbing
// ---------------------------------------------------------------------------
function sseStart(res) {
  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
}
function sseSend(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // client went away — the loop checks res.writableEnded and stops
  }
}

// ---------------------------------------------------------------------------
// POST /chat
// ---------------------------------------------------------------------------
router.post('/chat', async (req, res) => {
  try {
    // Modest per-user rate limit (repo limiter pattern; fail-open like it does)
    const rl = await checkRateLimit(`ai-dev:${req.user?.id || req.ip}`, CHAT_LIMIT, CHAT_WINDOW_SEC).catch(() => ({ allowed: true }));
    if (!rl.allowed) {
      res.set('Retry-After', String(rl.retryAfter || CHAT_WINDOW_SEC));
      return res.status(429).json({ error: 'Too many AI requests — try again in a few minutes' });
    }

    const parsed = validateChatBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { pageId, funnelId, model, messages, images, attachment, draftBlocks } = parsed;

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'AI Developer is not configured (ANTHROPIC_API_KEY missing)' });
    }

    // READ-ONLY context load. This route never writes funnels/funnel_pages.
    const pages = await pgQuery(
      `SELECT id, funnel_id, slug, type, title, status, blocks FROM funnel_pages
       WHERE id = $1 AND funnel_id = $2 AND archived = FALSE`,
      [pageId, funnelId]
    );
    if (!pages.length) return res.status(404).json({ error: 'Page not found' });
    const page = pages[0];
    const funnels = await pgQuery(
      `SELECT id, name, slug, settings FROM funnels WHERE id = $1 AND archived = FALSE`,
      [funnelId]
    );
    if (!funnels.length) return res.status(404).json({ error: 'Funnel not found' });
    const funnel = funnels[0];

    // Context blocks: the editor's draft if it sent one, else the stored row.
    // Stored rows can predate the builder (no ids) — assign stable ids so the
    // model always has a valid id to target; the client applies ops by id
    // against ITS copy, so ids must come from the client whenever possible.
    let contextBlocks;
    if (draftBlocks) {
      contextBlocks = draftBlocks;
    } else {
      const stored = Array.isArray(page.blocks) ? page.blocks : [];
      contextBlocks = stored.map((b, i) =>
        isPlainObject(b) && typeof b.id === 'string' ? b : { id: `blk_srv_${i}`, ...(isPlainObject(b) ? b : {}) }
      );
    }
    if (attachment && !contextBlocks.some((b) => b.id === attachment.block_id)) {
      return res.status(400).json({ error: 'attachment.block_id does not reference a block of this page' });
    }

    const system = buildSystemPrompt({ page, funnel, blocks: contextBlocks, attachment });

    // Anthropic conversation: prior turns as plain text, last user turn gets
    // the pasted screenshots as vision blocks.
    const convo = messages.map((m, i) => {
      if (i === messages.length - 1 && images.length) {
        return {
          role: 'user',
          content: [
            ...images.map((img) => ({
              type: 'image',
              source: { type: 'base64', media_type: img.media_type, data: img.data },
            })),
            { type: 'text', text: m.content },
          ],
        };
      }
      return { role: m.role, content: m.content };
    });

    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    // baseURL override (ANTHROPIC_BASE_URL) is honored by the SDK itself; we
    // pass it explicitly too so the test harness can point at a mock.
    const client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
    });

    sseStart(res);

    let workingBlocks = contextBlocks;
    const allOps = [];
    const jobs = [];
    let replyParts = [];
    let stopReason = null;

    for (let round = 0; round < MAX_TOOL_ROUNDS && !res.writableEnded; round++) {
      const stream = client.messages.stream({
        model,
        max_tokens: 16000,
        system,
        tools: TOOLS,
        messages: convo,
      });
      stream.on('text', (delta) => sseSend(res, 'text', { text: delta }));
      const message = await stream.finalMessage();
      stopReason = message.stop_reason;

      const textParts = message.content.filter((b) => b.type === 'text').map((b) => b.text);
      replyParts.push(...textParts);

      if (message.stop_reason !== 'tool_use') break;

      const toolUses = message.content.filter((b) => b.type === 'tool_use');
      const toolResults = [];
      for (const tu of toolUses) {
        let resultText;
        let isError = false;
        if (tu.name === 'propose_block_edits') {
          const applied = applyOps(workingBlocks, tu.input?.ops);
          if (applied.error) {
            resultText = `REJECTED: ${applied.error}`;
            isError = true;
          } else {
            workingBlocks = applied.blocks;
            allOps.push(...applied.ops);
            sseSend(res, 'ops', { count: applied.ops.length });
            resultText = `Applied ${applied.ops.length} op(s) to the draft. The canvas now reflects them. Current block count: ${workingBlocks.length}.`;
          }
        } else if (tu.name === 'generate_image' || tu.name === 'generate_video') {
          const fn = tu.name === 'generate_image' ? createImageJob : createVideoJob;
          const job = await fn(tu.input || {});
          if (!job.ok) {
            resultText = `Generation failed to start: ${job.error}`;
            isError = true;
          } else {
            const jobEntry = {
              id: job.id,
              kind: job.kind,
              prompt: String(tu.input?.prompt || '').slice(0, 300),
              // Poll credential — binds this job to the creating user.
              token: jobToken(job.id, req.user.id),
            };
            jobs.push(jobEntry);
            sseSend(res, 'job', jobEntry);
            resultText = `Job ${job.id} started (${job.kind}). It is ASYNC — the asset is not ready yet. A job card is now visible in the chat; once it finishes the operator can click "Use it" (or ask you) and you will receive the asset URL to swap into the block via propose_block_edits. Tell the operator this in your reply.`;
          }
        } else {
          resultText = `Unknown tool: ${tu.name}`;
          isError = true;
        }
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: resultText, is_error: isError });
      }

      convo.push({ role: 'assistant', content: message.content });
      convo.push({ role: 'user', content: toolResults });
    }

    let reply = replyParts.join('\n').trim();
    if (stopReason === 'refusal') {
      reply = reply || 'I can\'t help with that request.';
    }
    if (!reply) reply = allOps.length ? 'Done — the draft on the canvas reflects the changes.' : 'I wasn\'t able to produce a change for that — try rephrasing.';

    sseSend(res, 'done', { reply, ops: allOps, jobs, stop_reason: stopReason });
    res.end();
  } catch (err) {
    console.error('[ai-developer] chat failed:', err?.message || err);
    if (res.headersSent) {
      sseSend(res, 'error', { error: 'AI request failed — please try again' });
      res.end();
    } else {
      const status = err?.status === 429 ? 429 : 500;
      res.status(status).json({ error: status === 429 ? 'Claude is rate-limited right now — try again shortly' : 'AI request failed' });
    }
  }
});

// ---------------------------------------------------------------------------
// GET /jobs/:id — proxied job status. Asset URLs must be https and on a
// higgsfield-owned host or they are refused (never forwarded to the client).
// ---------------------------------------------------------------------------
router.get('/jobs/:id', async (req, res) => {
  try {
    // Job → user binding: the poller must present the HMAC tag issued to the
    // creating user (X-Job-Token header). Anyone else — wrong user, missing
    // or garbage tag — gets an indistinguishable 404, never the asset URL.
    if (!verifyJobToken(req.params.id, req.user.id, req.get('x-job-token'))) {
      return res.status(404).json({ error: 'Job not found' });
    }
    const job = await getJob(req.params.id);
    if (!job.ok) return res.status(502).json({ error: job.error });
    let url = null;
    let blocked = false;
    if (job.status === 'completed' && job.url) {
      if (isAllowedAssetUrl(job.url)) url = job.url;
      else blocked = true;
    }
    res.json({
      success: true,
      data: {
        id: job.id,
        status: blocked ? 'failed' : job.status,
        url,
        ...(blocked ? { error: 'asset URL rejected: not a higgsfield-owned https host' } : {}),
      },
    });
  } catch (err) {
    console.error('[ai-developer] job status failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to fetch job status' });
  }
});

export default router;
