// AI DEVELOPER — Claude-powered chat that PROPOSES block edits for the page
// builder, plus Higgsfield image/video generation as async jobs.
//
// HARD RULE (spec): this route is READ + PROPOSE ONLY. It loads funnel_pages
// to build context and NEVER writes them — the editor applies returned ops to
// its in-memory state (undo/redo compatible) and the operator persists via
// the existing Save / Re-publish. There is no pgQuery UPDATE/INSERT anywhere
// in this file, by design; keep it that way.
//
// POST   /api/v1/ai-developer/chat   → SSE stream: text deltas, job events,
//                                      final {reply, ops, jobs}
// GET    /api/v1/ai-developer/chat   → the persisted thread for a page
// DELETE /api/v1/ai-developer/chat   → clear that thread
// GET    /api/v1/ai-developer/models → the server's model allowlist
// GET    /api/v1/ai-developer/jobs/:id → proxied Higgsfield job status
import { randomBytes, createHmac, timingSafeEqual } from 'crypto';
import { Router } from 'express';
import env from '../config/env.js';
import { pgQuery } from '../db/pg.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { checkRateLimit } from '../middleware/rateLimiter.js';
import { validateBlocks } from './funnels.js';
import { createImageJob, createVideoJob, getJob, isAllowedAssetUrl } from '../services/higgsfield.js';
import {
  THREAD_LIMIT, appendThread, clearThread, ensureAiDevChatTables, openThreadEpoch, readThread,
} from '../services/aiDeveloperSchema.js';

const router = Router();
router.use(authenticate, requirePermission('funnels', 'access'));

// ---------------------------------------------------------------------------
// Model allowlist
// ---------------------------------------------------------------------------
// The SERVER owns this list. It is exposed read-only via GET /models so the
// picker in the panel is populated from it rather than from a hardcoded client
// copy that can drift — but the enforcement is the check in validateChatBody,
// NOT the dropdown. A body naming any other model is a 400, whatever the UI
// offered. Labels ride along so the panel has nothing to invent.
export const MODELS = Object.freeze([
  Object.freeze({ id: 'claude-fable-5', label: 'Fable 5 · frontier' }),
  Object.freeze({ id: 'claude-opus-5', label: 'Opus 5' }),
  Object.freeze({ id: 'claude-sonnet-5', label: 'Sonnet 5' }),
]);
export const MODEL_ALLOWLIST = Object.freeze(MODELS.map((m) => m.id));
export const DEFAULT_MODEL = 'claude-fable-5';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------
const MAX_MESSAGES = 40; // conversation length cap (client trims too)
const MAX_TEXT_CHARS = 20_000; // per message text
// Screenshot caps, matched to the reference tool: 2 per message, 4MB DECODED
// each. Per-image ceiling is UP from 2MB, per-message count is DOWN from 5.
//
// The cap is on DECODED bytes, so the worst-case DECODED image payload is 8MB
// (2 x 4MB) — down from the previous 10MB (5 x 2MB). The worst-case REQUEST is
// larger than that and always was: base64 inflates by 4/3, so 8MB decoded is
// ~10.7MB on the wire, and the body as a whole is bounded by the app's 50mb
// express limit, not by this constant. An earlier version of this comment
// claimed the accepted payload "falls from 10MB to 8MB" full stop, which
// conflated decoded bytes with request bytes.
export const MAX_IMAGES = 2;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // decoded bytes per image
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
// Image content-type SNIFF.
//
// A pasted screenshot arrives as `data:<media_type>;base64,…`, and the
// media_type is whatever the CLIENT said it is. That string is forwarded to
// Anthropic as the image block's media_type, so a mismatch is not cosmetic: a
// caller could label an arbitrary blob `image/png` and have the server relay it
// as an image. The declared type is therefore CHECKED AGAINST THE BYTES, and
// anything whose magic number is not a supported image is refused before any
// network call.
//
// Only the first bytes are decoded — the whole payload is never materialised
// just to look at its header.
export const ALLOWED_MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const MAGIC = [
  { type: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { type: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF87a / GIF89a
];

/**
 * @param {Buffer} buf — at least the first 16 bytes of the decoded image
 * @returns {string|null} the sniffed media type, or null when unrecognised
 */
export function sniffImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  for (const { type, bytes } of MAGIC) {
    if (buf.length < bytes.length) continue;
    let hit = true;
    for (let i = 0; i < bytes.length; i++) {
      if (buf[i] !== bytes[i]) { hit = false; break; }
    }
    if (hit) return type;
  }
  // WEBP is a RIFF container: "RIFF" <4-byte size> "WEBP". Both markers must be
  // present — "RIFF" alone is also WAV/AVI and is NOT an image.
  if (buf.length >= 12
    && buf.toString('latin1', 0, 4) === 'RIFF'
    && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Decode just enough of a base64 payload to sniff it. `head` must be a multiple
 * of 4 base64 chars so the decode lands on a byte boundary.
 * @param {string} b64 — whitespace already stripped
 */
export function sniffBase64Image(b64) {
  if (typeof b64 !== 'string' || b64.length < 8) return null;
  const head = b64.slice(0, 32); // 32 base64 chars → 24 bytes
  let buf;
  try {
    buf = Buffer.from(head, 'base64');
  } catch {
    return null;
  }
  return sniffImageType(buf);
}

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
//
// ---------------------------------------------------------------------------
// THE SECOND WAVE (seam audit B3). The original nine covered the checkout
// blocks that existed when the floor was written. Every block type added since
// carries load-bearing props that were NOT covered, and a routine "reword this"
// batch blanked all of them — reproduced through the real applyOps +
// renderBlock, with the canvas still looking correct:
//
//   sticky_cta.href      → safeHref(p.href || '#')      the money link becomes '#'
//   product_grid.items   → (Array.isArray(p.items)…)    the grid renders empty
//   countdown.deadline   → data-deadline=''             the clock never starts
//   embed/custom_html.html → p.html || ''               the widget is erased
//   table.rows           → <tbody></tbody>              the table empties
//   order_bump.checked   → p.checked === true           a pre-ticked bump unticks
//   hero.cta_href        → safeHref(p.cta_href || '#')  the hero CTA goes nowhere
//
// DECISION — items/rows/html ARE content the model legitimately rewrites, and
// they belong here anyway. The floor's contract is not "these keys are
// read-only"; it is "silence does not delete". An op that ACTUALLY emits
// `items` still wins (including an explicit null, which is an intentional
// clear). So "rewrite the product cards" works exactly as before, while
// "reword the heading" can no longer take the cards with it. Both directions
// are asserted per key in server/tests/builder/ai-ops-wiring.mjs.
//
// `url` is included defensively: no renderer reads a prop named `url` today
// (it is a field KIND in blockRegistry, not a prop key), so unlike the others
// it fixes no currently-reachable break — it is here so the next link-bearing
// block does not have to rediscover this bug.
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
  // seam audit B3 — the second wave
  'href',
  'cta_href',
  'url',
  'deadline',
  'html',
  'items',
  'rows',
  'checked',
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

// ---------------------------------------------------------------------------
// Link-host change flagging (seam audit M15)
// ---------------------------------------------------------------------------
// applyOps will happily re-point a money link at any host. That is a legal edit
// — an operator CAN ask for it — but it must never pass unremarked, because it
// is indistinguishable on the canvas from a copy tweak: the button still says
// "Buy Now" and still looks right, it just now pays someone else.
//
// This does NOT block the op (per M15: flag, do not refuse). It produces an
// advisory the operator review surface renders as an amber row naming old → new
// host, so the change is a decision they make rather than one they miss.
//
// DECISION — flagged on ANY block that carries a link prop, not on an allowlist
// of block types. An allowlist is precisely the shape that produced B3: it was
// correct when written and silently wrong for every block type added after.
// Over-flagging costs an amber row the operator can read and dismiss;
// under-flagging costs a redirected checkout.
export const LINK_PROP_KEYS = Object.freeze(['href', 'cta_href', 'url']);

/**
 * The host a link prop points at, or null when it has none (in-page anchors,
 * root-relative paths, query-only links, mailto:, unparseable junk). Total —
 * never throws on operator- or model-supplied text.
 */
export function linkHost(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  // Relative and in-page targets stay on the current host by definition.
  if (s.startsWith('#') || s.startsWith('/') || s.startsWith('?')) return null;
  try {
    const host = new URL(s).host.toLowerCase();
    return host || null; // mailto:/tel:/javascript: parse but carry no host
  } catch {
    return null;
  }
}

// One advisory. `from`/`to` are hosts (null = same-site/relative).
const linkWarning = (block, key, fromVal, toVal) => ({
  block_id: block.id,
  block_type: typeof block.type === 'string' ? block.type : '',
  key,
  from: linkHost(fromVal),
  to: linkHost(toVal),
  from_url: typeof fromVal === 'string' ? fromVal.slice(0, 300) : null,
  to_url: typeof toVal === 'string' ? toVal.slice(0, 300) : null,
});

/**
 * Compare a block's CURRENT props against the props an op would leave behind
 * and report every link whose HOST moves. Covers both top-level link props and
 * the per-item links inside a product_grid / storefront_grid (`items[i].href`),
 * which is where a product grid's money links actually live.
 *
 * A host change to OR from null is reported too: an absolute checkout URL
 * replaced by '#' is the money link dying, which is exactly what the operator
 * needs to see.
 *
 * @returns {Array<object>} possibly empty, never null
 */
export function detectLinkHostChanges(prevProps, nextProps, block) {
  const out = [];
  const p = isPlainObject(prevProps) ? prevProps : {};
  const n = isPlainObject(nextProps) ? nextProps : {};

  for (const key of LINK_PROP_KEYS) {
    const before = p[key];
    const after = n[key];
    if (before === after) continue;
    const fromHost = linkHost(before);
    const toHost = linkHost(after);
    // Only a HOST move is interesting. Editing a path or a query string on the
    // same host is a normal copy edit and must not cry wolf.
    if (fromHost === toHost) continue;
    if (fromHost === null && toHost === null) continue;
    out.push(linkWarning(block, key, before, after));
  }

  // Per-item links (product_grid, storefront_grid, and anything else that
  // stores an array of cards). Compared BY INDEX, which is how the renderer
  // reads them.
  if (Array.isArray(p.items) && Array.isArray(n.items)) {
    const len = Math.max(p.items.length, n.items.length);
    for (let i = 0; i < len; i++) {
      const bi = p.items[i];
      const ai = n.items[i];
      if (!isPlainObject(bi) || !isPlainObject(ai)) continue;
      for (const key of LINK_PROP_KEYS) {
        const fromHost = linkHost(bi[key]);
        const toHost = linkHost(ai[key]);
        if (fromHost === toHost) continue;
        if (fromHost === null && toHost === null) continue;
        out.push(linkWarning(block, `items[${i}].${key}`, bi[key], ai[key]));
      }
    }
  }

  return out;
}

// Returns { error } or { blocks, ops, warnings } where ops is the normalized
// list, blocks is the state after applying them, and warnings is the (possibly
// empty) list of link-host advisories. Pure — never mutates input.
export function applyOps(currentBlocks, rawOps) {
  if (!Array.isArray(rawOps)) return { error: 'ops must be an array' };
  if (!rawOps.length) return { error: 'ops is empty — propose at least one operation' };
  if (rawOps.length > MAX_OPS_PER_CALL) return { error: `at most ${MAX_OPS_PER_CALL} ops per call` };

  let blocks = currentBlocks.map((b) => ({ ...b }));
  const ops = [];
  const warnings = [];

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
      // Compared against the MERGED result, not the model's raw props — the
      // floor runs first, so a link the op was silent about has already been
      // carried forward and must not be reported as a change.
      warnings.push(...detectLinkHostChanges(blocks[idx].props, merged, blocks[idx]));
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
  return { blocks, ops, warnings };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'propose_block_edits',
    description:
      // The floor is INTERPOLATED, never spelled out. This description used to
      // carry its own hardcoded copy of the nine original keys, which is
      // exactly how the model ends up being told a floor that no longer matches
      // the one the validator applies.
      `Propose edits to the current page draft. Ops apply IN ORDER to the editor's in-memory blocks — they are a DRAFT the operator reviews on the canvas; nothing is published. block_id values MUST come from the block JSON in the system prompt (or from ids returned by earlier insert_block ops this conversation). replace_props REPLACES the whole props object, so copy unchanged keys over — except wiring keys (${WIRING_KEYS.join(', ')}), which are carried over from the block's current props when omitted. That carry-forward is a SAFETY NET, not permission to be sloppy: if you are rewriting a block's items/rows/html, emit them.`,
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
    ? `The operator has ATTACHED a specific block as the target: block_id "${attachment.block_id}" (type "${attachment.block_type || 'unknown'}"${attachment.excerpt ? `, currently reading ${JSON.stringify(attachment.excerpt)}` : ''}). Unless they clearly ask about something else, scope your edits to this block.`
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
- replace_props sends the FULL new props object (it replaces, not merges). One exception, applied for you: wiring keys (${WIRING_KEYS.join(', ')}) are carried over from the block's current props when you omit them, so you cannot delete a block's checkout wiring, its links, its countdown deadline, its embedded HTML, its grid/table contents or its style bags by leaving them out. To CHANGE one, set it explicitly — an explicit value always wins, including null, which clears it on purpose.
- The carry-forward is a SAFETY NET for props you were not thinking about. It is NOT a reason to omit content you ARE rewriting: if the operator asks you to change the product cards, the table rows or the embedded HTML, emit items/rows/html in full.
- CHANGING A LINK IS A MONEY DECISION. href, cta_href and url on CTA, button, product-grid and checkout-adjacent blocks point at a paid destination. Only change one when the operator explicitly asked you to, and say so plainly in your reply — a link edit to a different domain is surfaced to the operator for review.
- Respect the block schema you see: keep the same prop keys/shapes the block already uses; text-bearing props are plain strings; html props are raw HTML.
- Blocks are capped at 500 per page and 2MB total; keep edits lean.
- If the request is ambiguous about which block, say which one you picked in LOCATE and why.
- If asked to do something outside this page's blocks (server code, other pages, checkout pricing), say you can't from here.`;
}

// ---------------------------------------------------------------------------
// Request validation helpers
// ---------------------------------------------------------------------------
export function validateChatBody(body) {
  if (!isPlainObject(body)) return { error: 'body must be an object' };
  const pageId = typeof body.page_id === 'string' ? body.page_id : '';
  const funnelId = typeof body.funnel_id === 'string' ? body.funnel_id : '';
  if (!pageId || !funnelId) return { error: 'page_id and funnel_id are required' };

  // The allowlist check must run on a STRING, never on String(anything).
  // `String(['claude-fable-5'])` is 'claude-fable-5', and so is the output of
  // an object with a hand-written toString — coercing first would let either
  // one satisfy `includes()` and pick a model the caller never legally named.
  const model = body.model === undefined ? DEFAULT_MODEL : body.model;
  if (typeof model !== 'string' || !MODEL_ALLOWLIST.includes(model)) {
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
    // A whitespace-only USER turn is refused. Anthropic rejects an empty text
    // block outright, so this would have burned a request to earn a 400 from
    // the vendor — and, worse, an empty turn that DID get through would be
    // persisted, leaving a blank bubble in the thread forever. Assistant turns
    // are deliberately NOT held to this: a rehydrated thread that happens to
    // carry an empty reply must not wedge the panel out of sending anything.
    if (m.role === 'user' && !m.content.trim()) {
      return { error: `messages[${i}] is empty — say what you want changed` };
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
      // DECLARED is null when the caller said nothing about the type — bare
      // base64 with no data: prefix and no media_type field. That is NOT the
      // same as declaring image/png, which is what the previous default made it:
      // a bare JPEG was refused as "declared image/png but its bytes are
      // image/jpeg", blaming the caller for a claim the SERVER invented.
      const declared = mtMatch
        ? mtMatch[1]
        : (isPlainObject(img) && typeof img.media_type === 'string' ? img.media_type : null);
      const b64 = mtMatch ? mtMatch[2] : str;
      if (!b64) return { error: `images[${i}] must be base64 (or a data: URL)` };

      // Strip the line breaks a MIME-wrapped payload legally carries, THEN
      // validate the charset. '=' is base64 PADDING: it is legal only as the
      // last one or two characters. Admitting it anywhere (the old
      // `[A-Za-z0-9+/=\r\n]+`) is what let the size check be defeated below.
      const clean = b64.replace(/[\r\n]/g, '');
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) {
        return { error: `images[${i}] must be base64 (or a data: URL)` };
      }

      // SIZE. Measured by DECODING, not by arithmetic on the string length.
      //
      // The arithmetic form this replaces stripped '=' GLOBALLY before
      // measuring — `(clean.replace(/=/g,'').length * 3) / 4`. Combined with a
      // charset check that admitted '=' anywhere, a 32-char PNG header followed
      // by 20 million '=' characters measured as 24 BYTES and sailed past the
      // 4MB cap, relaying ~21MB of payload to Anthropic (reproduced end to end;
      // the only real ceiling was the app's 50mb express limit). The trailing-
      // padding charset fix above kills that input, and byteLength makes the
      // measurement independent of the charset check rather than dependent on
      // it — two independent defenses, not one.
      const bytes = Buffer.byteLength(clean, 'base64');
      if (bytes > MAX_IMAGE_BYTES) return { error: `images[${i}] exceeds 4MB` };

      // The declared type is a CLIENT claim. Check it against the magic number
      // and refuse a mismatch — the media_type is relayed to Anthropic, so a
      // blob labelled image/png must actually be a PNG. When nothing was
      // declared, ADOPT what the bytes say.
      const sniffed = sniffBase64Image(clean);
      if (!sniffed) return { error: `images[${i}] is not a recognized image (png, jpeg, webp or gif)` };
      if (declared !== null && !ALLOWED_MEDIA_TYPES.includes(declared)) {
        return { error: `images[${i}] has an unsupported media type` };
      }
      if (declared !== null && sniffed !== declared) {
        return { error: `images[${i}] is declared ${declared} but its bytes are ${sniffed}` };
      }
      images.push({ media_type: sniffed, data: clean });
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
// Attached-context resolution
// ---------------------------------------------------------------------------
// The chip in the panel must describe the block the conversation is ACTUALLY
// anchored to, not the label the client happened to send. Given the page's real
// blocks, the target's type and a short content excerpt are read off the BLOCK,
// so a stale or spoofed `kind` cannot make the chip lie about what is in scope.
const EXCERPT_PROPS = ['headline', 'title', 'text', 'label', 'block_name', 'subheadline', 'body'];
const EXCERPT_MAX = 60;

export function resolveAttachment(attachment, blocks) {
  if (!isPlainObject(attachment) || !attachment.block_id) return null;
  const blk = (Array.isArray(blocks) ? blocks : []).find((b) => isPlainObject(b) && b.id === attachment.block_id);
  if (!blk) return null;
  let excerpt = '';
  const props = isPlainObject(blk.props) ? blk.props : {};
  for (const key of EXCERPT_PROPS) {
    if (typeof props[key] === 'string' && props[key].trim()) {
      excerpt = props[key].trim().replace(/\s+/g, ' ').slice(0, EXCERPT_MAX);
      break;
    }
  }
  return {
    block_id: blk.id,
    // The BLOCK's type wins over whatever the client called it.
    block_type: typeof blk.type === 'string' ? blk.type : (attachment.block_type || ''),
    block_path: attachment.block_path || '',
    excerpt,
  };
}

// ---------------------------------------------------------------------------
// Thread endpoints — page resolution
// ---------------------------------------------------------------------------
// Every thread verb resolves (page_id, funnel_id) against a LIVE page first, so
// a thread can never be read or cleared for a page the caller cannot see, and a
// guessed page id under the wrong funnel is a 404 rather than an empty thread
// that reads as "this page has no conversation".
async function resolvePageOr404(req, res) {
  const pageId = typeof req.query.page_id === 'string' ? req.query.page_id : '';
  const funnelId = typeof req.query.funnel_id === 'string' ? req.query.funnel_id : '';
  if (!pageId || !funnelId) {
    res.status(400).json({ error: 'page_id and funnel_id are required' });
    return null;
  }
  const rows = await pgQuery(
    `SELECT id FROM funnel_pages WHERE id = $1 AND funnel_id = $2 AND archived = FALSE`,
    [pageId, funnelId]
  );
  if (!rows.length) {
    res.status(404).json({ error: 'Page not found' });
    return null;
  }
  return { pageId, funnelId };
}

// ---------------------------------------------------------------------------
// GET /models — the server's allowlist, read-only.
//
// This is a CONVENIENCE for the picker, never the gate. The gate is
// validateChatBody: a model the client was never offered is refused there.
// ---------------------------------------------------------------------------
router.get('/models', (req, res) => {
  res.json({ success: true, data: { models: MODELS, default: DEFAULT_MODEL } });
});

// ---------------------------------------------------------------------------
// GET /chat — the persisted thread for a page (oldest first, bounded).
// ---------------------------------------------------------------------------
router.get('/chat', async (req, res) => {
  try {
    const scope = await resolvePageOr404(req, res);
    if (!scope) return undefined;
    await ensureAiDevChatTables();
    const messages = await readThread(scope.pageId, scope.funnelId);
    return res.json({ success: true, data: { messages, limit: THREAD_LIMIT } });
  } catch (err) {
    console.error('[ai-developer] thread read failed:', err?.message || err);
    return res.status(500).json({ error: 'Failed to load the conversation' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /chat — clear the thread for a page.
// ---------------------------------------------------------------------------
router.delete('/chat', async (req, res) => {
  try {
    const scope = await resolvePageOr404(req, res);
    if (!scope) return undefined;
    await ensureAiDevChatTables();
    const cleared = await clearThread(scope.pageId, scope.funnelId);
    return res.json({ success: true, data: { cleared } });
  } catch (err) {
    console.error('[ai-developer] thread clear failed:', err?.message || err);
    return res.status(500).json({ error: 'Failed to clear the conversation' });
  }
});

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
    // The chip's truth is derived from the page's REAL blocks, not from the
    // label the client sent. A block_id that is not on this page is refused.
    let resolvedAttachment = null;
    if (attachment) {
      resolvedAttachment = resolveAttachment(attachment, contextBlocks);
      if (!resolvedAttachment) {
        return res.status(400).json({ error: 'attachment.block_id does not reference a block of this page' });
      }
    }

    const system = buildSystemPrompt({ page, funnel, blocks: contextBlocks, attachment: resolvedAttachment });

    // OPEN THE THREAD EPOCH *BEFORE* the model runs. This is the value the
    // persist below is checked against: if the operator clears the conversation
    // while this turn is streaming, the epoch moves and the persist stands down
    // rather than repopulating the thread they just emptied. Opening it also
    // guarantees the row exists, so the persist's FOR UPDATE has a real row to
    // lock. Best-effort — a turn must not be lost to a bookkeeping failure.
    // KNOWN DEGRADATION (reviewed, accepted): this open rides pgQuery's circuit
    // breaker while the persist uses sharedClient directly — during a breaker-
    // open window turnEpoch is undefined and the clear-beats-in-flight-turn
    // guard reverts to append-unconditionally (DELETE 500s in that window too,
    // so the race needs a DB incident + a turn spanning the breaker reset).
    let turnEpoch;
    try {
      await ensureAiDevChatTables();
      turnEpoch = await openThreadEpoch(pageId, funnelId);
    } catch (epochErr) {
      console.error('[ai-developer] thread epoch open failed:', epochErr?.message || epochErr);
    }

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
    const allWarnings = [];
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
            const warns = applied.warnings || [];
            allWarnings.push(...warns);
            sseSend(res, 'ops', { count: applied.ops.length, warnings: warns });
            resultText = `Applied ${applied.ops.length} op(s) to the draft. The canvas now reflects them. Current block count: ${workingBlocks.length}.`;
            if (warns.length) {
              // Tell the MODEL too. If it re-pointed a link it did not mean to,
              // this is its chance to correct itself in the same turn — and if
              // it did mean to, it should say so plainly in its reply.
              const list = warns
                .map((w) => `${w.block_id}.${w.key}: ${w.from || '(same-site)'} → ${w.to || '(same-site)'}`)
                .join('; ');
              resultText += ` NOTE — ${warns.length} link destination(s) changed host and are flagged for the operator to review: ${list}. If that was not intended, correct it now; if it was, say so explicitly in your reply.`;
            }
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

    // PERSIST the turn: the operator's message and Claude's reply, appended to
    // this page's rolling thread and pruned back to THREAD_LIMIT.
    //
    // GUARDED BY turnEpoch — if the operator cleared the conversation while this
    // was streaming, the epoch has moved and appendThread writes NOTHING. A
    // clear must win over a turn already in flight; the previous version
    // repopulated the thread the operator had just emptied.
    //
    // BEST-EFFORT, and after the answer is computed — the transcript is a
    // convenience, and a database blip must never cost the operator a turn they
    // already paid for. A failure is logged and the `done` frame still ships.
    //
    // ⛔ Image BYTES are not written. Only how many rode along.
    try {
      await ensureAiDevChatTables();
      await appendThread(pageId, funnelId, [
        {
          role: 'user',
          content: messages[messages.length - 1].content,
          image_count: images.length,
          attachment: resolvedAttachment,
          model,
        },
        { role: 'assistant', content: reply, ops_count: allOps.length, model },
      ], { createdBy: req.user?.id || null, expectEpoch: turnEpoch });
    } catch (persistErr) {
      console.error('[ai-developer] thread persist failed:', persistErr?.message || persistErr);
    }

    sseSend(res, 'done', {
      reply, ops: allOps, jobs, stop_reason: stopReason, attachment: resolvedAttachment,
      // Link-host advisories (seam audit M15) — the panel renders one amber row
      // per entry. Advisory only: the ops are already applied.
      warnings: allWarnings,
    });
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
