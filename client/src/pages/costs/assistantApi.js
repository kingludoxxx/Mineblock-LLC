// assistantApi — the ONE place the COGS-assistant surface names a backend
// route (NEW FILE, costs lane).
//
// Same envelope discipline as costsApi.js: every endpoint answers
// `{success:true, data:<payload>}` and `unwrap` peels that exactly once, here.
// Errors are `{success:false, error:{code, message?}}` — `assistantError`
// maps the code to prose, and NEVER puts a raw machine code on screen.
//
// ── Routes (payloads = the `data` member) ────────────────────────────────
//   POST /cogs-assistant/chat        {message, images?, model?}
//        -> { proposals[], dropped[], unmatched[], questions[], summary,
//             source, catalog_count, catalog_truncated, model, usage, batch_id }
//   POST /cogs-assistant/apply       {proposals[], kind, batch_id?, model?,
//                                     source_text?, quote_scan_id?, note?}
//        -> { batch_id, applied[], failed[], applied_count, failed_count,
//             audit_id, summary, dropped[] }
//   GET  /cogs-assistant/audit       ?kind&batch_id&limit&offset
//        -> { items[], total, limit, offset }
//   POST /cogs-assistant/quote/scan  {file (base64/data-url), filename?, model?}
//        -> { scan_id, content_hash, header, rows[], unreadable[], verify,
//             model, prior_scans[], batch_id }
//   GET  /cogs-assistant/quote/:id   -> the stored scan row
//   GET  /cogs-assistant/limits      -> { max_upload_bytes, models, … }
//
// PROPOSALS ARE INERT. Nothing this module fetches has changed a cost. Only
// `applyProposals` writes, and only from a list the operator confirmed.
// Explicit .js extension so a node harness can import this module directly;
// Vite resolves it identically.
import api from '../../services/api.js';

export const unwrap = (res) => res.data?.data ?? res.data;

export const ASSISTANT_BASE = '/cogs-assistant';

export const ASSISTANT_ROUTES = {
  chat: `${ASSISTANT_BASE}/chat`,
  apply: `${ASSISTANT_BASE}/apply`,
  audit: `${ASSISTANT_BASE}/audit`,
  quoteScan: `${ASSISTANT_BASE}/quote/scan`,
  quote: (id) => `${ASSISTANT_BASE}/quote/${encodeURIComponent(id)}`,
  limits: `${ASSISTANT_BASE}/limits`,
};

export const MODELS = [
  { value: 'claude-fable-5', label: 'Fable 5 (default)' },
  { value: 'claude-opus-5', label: 'Opus 5' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
];

/** Mirrors the server's decoded cap. The client checks first so a 10 MB
 *  upload is refused before it is base64-encoded and put on the wire. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

// ── error prose ────────────────────────────────────────────────────────────
// A machine code must never reach the operator. Anything unmapped falls back
// to generic prose plus whatever prose the server chose to send.
const ERRORS = {
  ai_unconfigured: 'The assistant is not configured on this server — an API key is missing. Nothing was changed.',
  ai_unavailable: 'Claude could not be reached. Nothing was extracted and nothing was changed — try again in a moment.',
  assistant_truncated: 'The reply was cut off before it finished. Ask about fewer variants at once.',
  extraction_refused: 'Claude would not read this file as a supplier quote.',
  empty_request: 'Type something, or attach a photo of the price list.',
  message_too_long: 'That message is too long — trim it and send again.',
  bad_model: 'That model is not available here.',
  file_required: 'Choose a quote image or PDF first.',
  bad_encoding: 'That file could not be read.',
  unsupported_type: 'That file is not a PNG, JPEG, WebP, GIF or PDF.',
  file_too_large: 'That file is over 10 MB. Photograph the sheet at a lower resolution, or split the PDF.',
  image_too_large: 'That image is over 4 MB.',
  image_bytes_mismatch: 'That attachment is not an image, whatever its name says.',
  bad_image_encoding: 'That image could not be read.',
  too_many_images: 'At most 4 images per message.',
  empty_image: 'That image is empty.',
  proposals_required: 'Tick at least one row first.',
  too_many_proposals: 'Too many rows in one batch — apply them in smaller groups.',
  nothing_applicable: 'None of those rows could be applied. See the reasons listed against them.',
  unknown_quote_scan: 'That scan is no longer available — re-scan the document.',
  quote_scan_id_required: 'That scan is no longer open — re-scan the document before applying.',
  bad_batch_id: 'That batch id is not valid.',
  bad_kind: 'Unknown tab.',
  rate_limited: 'Too many AI requests in a short time — wait a few minutes.',
  internal_error: 'Something went wrong on the server. Nothing was changed.',
};

/** Per-rate refusals raised by the cost engine at the write door. */
const APPLY_FAILURES = {
  bad_amount: 'that amount could not be read as money',
  negative_amount: 'a cost cannot be negative',
  empty_rate: 'that row sets neither a cost nor a shipping figure',
  usd_only: 'the engine books USD only',
  bad_variant_id: 'that variant id is not valid',
  bad_effective_from: 'that date is not YYYY-MM-DD',
  bad_scope: 'unknown scope',
};

/** Why a proposal never made it to the write door. */
export const DROP_REASONS = {
  not_an_object: 'the model returned something that was not a proposal',
  bad_scope: 'unknown scope',
  unknown_variant: 'that variant is not in your catalog — the model may have invented the id',
  unknown_cost_item: 'that cost group does not exist',
  duplicate_ref: 'a second proposal for the same variant in one turn — only the first was kept',
  bad_amount: 'the amount could not be read as money (a "12,50" is refused rather than guessed)',
  empty_rate: 'it set neither a cost nor a shipping figure',
  bad_effective_from: 'the date was not YYYY-MM-DD',
  effective_from_in_future: 'it was dated in the future — a cost cannot start applying before it exists',
  effective_from_before_first_sale: 'it was dated before this variant ever sold, which would restate a period it did not exist in',
  bad_only_from_today: '"only from today" was not a yes/no value',
  currency_not_convertible:
    'it was quoted in another currency — convert it to USD before applying, as automatic conversion is not built',
  injected_text: 'its note read like an instruction rather than a note, so it was screened out',
  row_id_required: 'it could not be traced back to a line on the scanned sheet, so it could not be re-checked',
  verify_blocked: 'the checks on the scanned sheet failed for that line',
};

/** Why an op was deliberately NOT written. Not a failure — an outcome. */
export const SKIP_REASONS = {
  already_applied: 'already applied — this exact change is in the history from an earlier click',
  no_change: 'already the cost in force — writing it again would only add a duplicate row',
};

export const skipReason = (code) => SKIP_REASONS[code] || 'it was already up to date';

export function assistantError(err) {
  const data = err?.response?.data;
  const code = data?.error?.code;
  const message = data?.error?.message;
  if (err?.response?.status === 403) {
    return 'You do not have permission to change costs.';
  }
  if (code && ERRORS[code]) return message && code !== 'internal_error' ? `${ERRORS[code]}` : ERRORS[code];
  if (message) return String(message);
  return 'Something went wrong. Nothing was changed.';
}

export const dropReason = (code) => DROP_REASONS[code] || 'it was refused';
export const applyFailure = (code) => APPLY_FAILURES[code] || 'the cost engine refused it';

// ── calls ──────────────────────────────────────────────────────────────────
export function postChat(body) {
  return api.post(ASSISTANT_ROUTES.chat, body).then(unwrap);
}

/**
 * The ONLY write. `proposals` must be the list the operator confirmed —
 * the server re-validates every one against a freshly read catalog and
 * writes through the same append-only door the manual rate form uses.
 */
export function applyProposals(body) {
  return api.post(ASSISTANT_ROUTES.apply, body).then(unwrap);
}

export function fetchAudit(params = {}) {
  return api.get(ASSISTANT_ROUTES.audit, { params }).then(unwrap);
}

export function postQuoteScan(body) {
  return api.post(ASSISTANT_ROUTES.quoteScan, body).then(unwrap);
}

// NOTE: GET /quote/:id and GET /limits exist on the server (and are covered by
// the harness) but have NO client caller yet — re-opening a stored scan and
// reading the caps back are follow-ups. Their paths stay in ASSISTANT_ROUTES
// above so this module remains the one place the surface is named; no unused
// fetch wrapper is kept for them.

// ── file → wire ────────────────────────────────────────────────────────────
/** Reads a File into a base64 data URL. Rejects oversize BEFORE reading, so a
 *  60 MB drop never gets buffered into memory just to be refused. */
export function fileToBase64(file, maxBytes = MAX_UPLOAD_BYTES) {
  return new Promise((resolve, reject) => {
    if (!file) { reject(new Error('no file')); return; }
    if (file.size > maxBytes) {
      reject(new Error(`${file.name} is ${(file.size / 1048576).toFixed(1)} MB — the limit is ${maxBytes / 1048576} MB`));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`${file.name} could not be read`));
    reader.onload = () => resolve({ data: String(reader.result), name: file.name, size: file.size });
    reader.readAsDataURL(file);
  });
}
