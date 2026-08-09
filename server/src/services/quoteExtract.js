// SUPPLIER QUOTE SCAN — upload → Claude vision → cost matrix.
//
// WHAT LEAVES THIS FILE IS DATA THE MODEL READ OFF THE DOCUMENT, OR AN ERROR.
// There is no fallback matrix, no "best effort" row, no default currency when
// the document doesn't state one. If the model refuses, returns no tool call,
// or the API is unreachable, the caller gets a refusal/failure and the
// operator gets prose — never a plausible-looking table nobody can source.
//
// THE FILE IS NEVER PERSISTED. Bytes are decoded in memory, size-capped,
// magic-byte sniffed, sent to the API, and dropped when the request ends.
// What lands in Postgres is the extracted matrix plus a sha256 of the bytes
// (lb_quote_scans) — enough to recognise a re-upload, not enough to be a file
// store, and not enough to leak a supplier's paper if the DB walks.
//
// TRANSPORT: base64 JSON, same idiom as routes/media.js and pageClone's
// file_base64 — this repo carries no multipart parser and a supplier quote is
// not the place to add one to the money-path service.
import { ExtractError } from './quoteVerify.js';
// ONE allowlist for the lane (review NIT) — re-exported here so existing
// importers of this module keep working, but there is only one definition.
import { MODEL_ALLOWLIST, DEFAULT_MODEL } from './cogsAssistant.js';

export { MODEL_ALLOWLIST, DEFAULT_MODEL };

// ── limits ────────────────────────────────────────────────────────────────
// 10 MB DECODED, per the work order. Checked against the base64 LENGTH first
// so an oversize payload is refused without ever being decoded (the media
// route's trick — decoding a 60 MB base64 blob to then reject it is the
// denial of service you were trying to prevent).
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_BASE64_CHARS = Math.ceil((MAX_UPLOAD_BYTES / 3) * 4) + 4096;

export const ALLOWED_IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const ALLOWED_TYPES = Object.freeze([...ALLOWED_IMAGE_TYPES, 'application/pdf']);

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// CONTENT-TYPE SNIFF — the declared type is a hint, the bytes are the fact.
// A client that labels a .exe "image/png" gets refused here, not at the API.
// Returns the sniffed type or null when the bytes are not something we send.
export function sniffContentType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(PNG_SIG)) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF'
    && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

// Accepts a bare base64 string or a data: URL. Returns { buf, contentType } or
// throws ExtractError with an operator-actionable code.
export function decodeUpload({ data, filename = '' }) {
  const raw = typeof data === 'string' ? data.trim() : '';
  if (!raw) throw new ExtractError('file_required', 'attach a quote image or PDF');

  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.*)$/is.exec(raw);
  const b64 = (m ? m[2] : raw).replace(/[\r\n]/g, '');
  if (!b64) throw new ExtractError('file_required', 'attach a quote image or PDF');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    throw new ExtractError('bad_encoding', 'file must be base64 or a data: URL');
  }
  // LENGTH check before decode.
  if (b64.length > MAX_BASE64_CHARS) {
    throw new ExtractError('file_too_large', `file exceeds ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB`);
  }
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw new ExtractError('bad_encoding', 'file decoded to zero bytes');
  if (buf.length > MAX_UPLOAD_BYTES) {
    throw new ExtractError('file_too_large', `file exceeds ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB`);
  }

  const sniffed = sniffContentType(buf);
  if (!sniffed) {
    throw new ExtractError(
      'unsupported_type',
      'file must be a PNG, JPEG, WebP, GIF or PDF (the bytes did not look like one)'
    );
  }
  if (!ALLOWED_TYPES.includes(sniffed)) {
    throw new ExtractError('unsupported_type', `${sniffed} is not accepted`);
  }
  return { buf, contentType: sniffed, filename: String(filename || '').slice(0, 200) };
}

// ── the extraction tool ───────────────────────────────────────────────────
// A forced tool call, not free text. The schema is the contract; anything the
// model wants to say about uncertainty goes in `notes`, never into a number.
//
// EVERY numeric field is nullable and the description says what null MEANS.
// This is the null-vs-0 rule reaching the model: a quote that doesn't print a
// shipping line must come back with shipping null, not 0, or the assistant
// would silently claim free freight.
export const EXTRACT_TOOL = {
  name: 'emit_quote_matrix',
  description:
    'Emit the cost matrix you actually read off this supplier quote/invoice. '
    + 'Report ONLY what is printed. If a field is not on the document, use null — '
    + 'null means "the document does not say", which is a valid and useful answer. '
    + 'NEVER infer, average, convert currency, or carry a number over from another row.',
  input_schema: {
    type: 'object',
    properties: {
      header: {
        type: 'object',
        properties: {
          supplier: { type: 'string', description: 'Supplier/vendor name as printed, or "" if absent' },
          quote_ref: { type: 'string', description: 'Quote/invoice number as printed, or ""' },
          quote_date: { type: 'string', description: 'ISO YYYY-MM-DD if a date is printed, else ""' },
          currency: { type: 'string', description: 'ISO 4217 code printed on the document (USD, CNY, EUR…), or "" if the document never states one' },
          incoterm: { type: 'string', description: 'FOB / EXW / DDP / CIF as printed, or ""' },
          subtotal: { type: ['number', 'null'], description: 'Printed subtotal, or null' },
          shipping_total: { type: ['number', 'null'], description: 'Printed freight/shipping total, or null' },
          grand_total: { type: ['number', 'null'], description: 'Printed grand total, or null' },
        },
        required: ['supplier', 'currency'],
      },
      rows: {
        type: 'array',
        description: 'One entry per priced line. A tiered quote (100pc @ $4.60, 500pc @ $4.20) is MULTIPLE rows sharing a label, one per tier.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'The product/SKU description exactly as printed' },
            supplier_sku: { type: 'string', description: 'Supplier part number as printed, or ""' },
            qty_break: { type: ['number', 'null'], description: 'Minimum order quantity this price applies from, or null if the quote states no tier' },
            unit_cost: { type: ['number', 'null'], description: 'Per-unit cost at this tier, in the header currency. null if not printed' },
            shipping_per_unit: { type: ['number', 'null'], description: 'Per-unit freight if the quote prints one. null if the quote is silent — do NOT put 0 here for a silent quote' },
            line_total: { type: ['number', 'null'], description: 'Printed extended/line total, or null' },
            notes: { type: 'string', description: 'Anything qualifying this row (lead time, MOQ text, "price on request"), or ""' },
          },
          required: ['label'],
        },
      },
      unreadable: {
        type: 'array',
        description: 'Regions/lines you could see but could not read confidently. Empty array when the document was clean.',
        items: { type: 'string' },
      },
    },
    required: ['header', 'rows'],
  },
};

export function buildExtractSystemPrompt(catalog) {
  const lines = (catalog?.items || []).slice(0, 200).map((e) => (
    `${e.variant_id} | ${e.product_title} | ${e.variant_title} | units_per ${e.units_per}`
      + `${e.unit_cogs === null ? '' : ` | current COGS $${e.unit_cogs}`}`
  ));
  return `You read supplier quotes and invoices for an e-commerce operator and turn them into a cost matrix.

HARD RULES
- Report ONLY what is printed on the document. You are a transcriber with arithmetic, not an estimator.
- A field the document does not state is null. null is a correct answer and the operator's software treats it as "unknown" — a 0 you invented would be read as "known free" and would corrupt their gross profit.
- Do NOT convert currency. Emit the currency the document is written in, in header.currency, and leave every number in it.
- A tiered price list is several rows sharing a label, one per quantity break.
- If the document is not a supplier quote or invoice, or is too degraded to read, say so in plain words and do NOT call the tool.
- If you can read part of it, emit the rows you can read and list what you could not in "unreadable".

VARIANT CATALOG (for the label field only — you are NOT asked to match; the operator's software does the matching and will show them your raw labels):
${lines.length ? lines.join('\n') : '(catalog is empty)'}

Call emit_quote_matrix exactly once when you can read the document.`;
}

// ── normalization ─────────────────────────────────────────────────────────
// The model's tool input is UNTRUSTED SHAPE. Everything below coerces it into
// the matrix contract without inventing values: a number that is not finite
// becomes null (unknown), never 0; a missing string becomes ''.
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : null;
};
const str = (v, cap = 200) => String(v == null ? '' : v).slice(0, cap);

export const MAX_MATRIX_ROWS = 200;

export function normalizeMatrix(input) {
  const h = input && typeof input === 'object' && input.header && typeof input.header === 'object'
    ? input.header : {};
  const header = {
    supplier: str(h.supplier, 120),
    quote_ref: str(h.quote_ref, 80),
    quote_date: /^\d{4}-\d{2}-\d{2}$/.test(String(h.quote_date || '')) ? String(h.quote_date) : '',
    currency: /^[A-Za-z]{3}$/.test(String(h.currency || '')) ? String(h.currency).toUpperCase() : '',
    incoterm: str(h.incoterm, 16).toUpperCase(),
    subtotal: num(h.subtotal),
    shipping_total: num(h.shipping_total),
    grand_total: num(h.grand_total),
  };
  const rawRows = Array.isArray(input?.rows) ? input.rows.slice(0, MAX_MATRIX_ROWS) : [];
  const rows = rawRows.map((r, i) => {
    const o = r && typeof r === 'object' ? r : {};
    return {
      row_id: `r${i + 1}`,
      label: str(o.label, 200),
      supplier_sku: str(o.supplier_sku, 80),
      qty_break: (() => {
        const q = num(o.qty_break);
        return q === null || q <= 0 ? null : Math.round(q);
      })(),
      unit_cost: num(o.unit_cost),
      shipping_per_unit: num(o.shipping_per_unit),
      line_total: num(o.line_total),
      currency: header.currency,
      notes: str(o.notes, 300),
      // Filled by the matcher, not by the model.
      variant_id: null,
      match_confidence: 'none',
      match_reason: '',
      selected: false,
    };
  });
  const unreadable = Array.isArray(input?.unreadable)
    ? input.unreadable.slice(0, 40).map((u) => str(u, 200)).filter(Boolean) : [];
  return { header, rows, unreadable };
}

// ── the API call ──────────────────────────────────────────────────────────
// PDFs ride a `document` content block, images an `image` block. Both are
// base64 — the same bytes we sniffed, never a URL the API would have to fetch.
export function contentBlockFor(buf, contentType) {
  if (contentType === 'application/pdf') {
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') },
    };
  }
  return {
    type: 'image',
    source: { type: 'base64', media_type: contentType, data: buf.toString('base64') },
  };
}

// Returns { header, rows, unreadable, model, stop_reason }.
// Throws ExtractError:
//   ai_unconfigured  — no key (503)
//   ai_unavailable   — transport/API failure (503)
//   extraction_refused — the model declined or emitted no tool call (422),
//                        carrying the model's own prose in .detail
export async function extractQuoteMatrix({ buf, contentType, model, catalog, clientFactory = null }) {
  if (!MODEL_ALLOWLIST.includes(model)) {
    throw new ExtractError('bad_model', `model must be one of: ${MODEL_ALLOWLIST.join(', ')}`);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new ExtractError('ai_unconfigured', 'Quote scan is not configured (ANTHROPIC_API_KEY missing)');
  }

  let client;
  if (clientFactory) {
    client = clientFactory();
  } else {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
    });
  }

  let message;
  try {
    message = await client.messages.create({
      model,
      max_tokens: 8000,
      system: buildExtractSystemPrompt(catalog),
      tools: [EXTRACT_TOOL],
      messages: [{
        role: 'user',
        content: [
          contentBlockFor(buf, contentType),
          {
            type: 'text',
            text: 'Read this supplier quote/invoice and emit its cost matrix. Only what is printed — null for anything the document does not state.',
          },
        ],
      }],
    });
  } catch (err) {
    // The upstream failed. Say so. Do NOT return an empty matrix — an empty
    // matrix is indistinguishable from "the quote had no rows".
    throw new ExtractError('ai_unavailable', 'Claude could not be reached for this scan', err?.message || String(err));
  }

  const toolUse = (message?.content || []).find((b) => b && b.type === 'tool_use' && b.name === EXTRACT_TOOL.name);
  const prose = (message?.content || [])
    .filter((b) => b && b.type === 'text').map((b) => b.text).join('\n').trim();

  if (!toolUse) {
    throw new ExtractError(
      'extraction_refused',
      prose || 'Claude did not extract a cost matrix from this file.',
      message?.stop_reason || ''
    );
  }

  const normalized = normalizeMatrix(toolUse.input);
  return { ...normalized, model, prose, stop_reason: message?.stop_reason || null };
}
