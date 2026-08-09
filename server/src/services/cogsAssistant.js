// COGS ASSISTANT — proposal building, validation and application.
//
// PROPOSE / APPLY SEPARATION (the whole point of this file):
//
//   The model NEVER writes. /chat and /quote/scan run the model and return
//   PROPOSALS — plain data, inert, not persisted anywhere a P&L read can see.
//   Only /apply writes, only from a proposal the operator sent back, and only
//   through funnelCosts.appendRate() — the SAME function POST
//   /funnel-costs/rates calls. There is no second writer of lb_cost_rates in
//   this lane, by construction: the only INSERTs in this file target
//   lb_cogs_assistant_audit and lb_quote_scans.
//
// Because appendRate is the write, everything it guarantees is inherited and
// cannot drift: append-only history, effective-dating (a first cost backdates
// to first sale, a later cost starts today), null-vs-0 (blank stays NULL,
// only an explicit 0 is "known free"), USD-only, coverage refresh.
//
// FIVE INVARIANTS carried over from the funnel-os reference, each of which is
// a shipped defect somewhere if you drop it:
//
//  1. THE HALLUCINATION GATE. A variant_id the model emits is dropped unless
//     it is a key of the catalog we just loaded. Format validity is NOT
//     enough — a well-formed id for a variant that does not exist would
//     append a rate nothing ever reads, and the operator would see a green
//     "applied" for a cost that landed nowhere.
//  2. VALIDATE TWICE. Once at propose, once at apply against a FRESHLY read
//     catalog — the proposals have made a round trip through a browser and
//     the sweep may have moved under them.
//  3. A RATE ROW IS A SNAPSHOT, NOT A PATCH. resolveUnitCogs reads the ONE
//     rate in force for a day; it does not fall back to an earlier row for a
//     null field. So two rows for the same (variant, day) — one setting cost,
//     one setting ship — leave the ship-only row winning and the cost
//     resolving to UNKNOWN. groupWrites() merges same-ref proposals before
//     the write, and carryForward() copies the currently-resolved values a
//     proposal does not mention into the row it will write.
//  4. CARRY-FORWARD MUST RESPECT cogs_source. If a variant's cost currently
//     comes from its COST GROUP (cogs_source === 'item'), carrying that value
//     into a variant-scoped row FREEZES the variant out of its group — the
//     group's next cost change would stop reaching it. Those stay null.
//  5. MODEL CONFIDENCE MAY DEMOTE, NEVER PROMOTE. It is recorded and shown;
//     nothing is auto-applied off it, and a missing confidence stays null
//     rather than defaulting to a flattering midpoint.
import { createHash, randomBytes } from 'crypto';
import { pgQuery } from '../db/pg.js';
import { ensureCogsAssistantTables } from './cogsAssistantSchema.js';
import { parseMoneyText, MoneyError, scanInjection } from './quoteVerify.js';
import {
  CONTEXTS, SHIP_KEYS, CostError, appendRate, listVariants, dayKey,
} from './funnelCosts.js';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const VARIANT_RE = /^[0-9]{6,20}$/;
const ITEM_RE = /^ci_[0-9a-z_-]{2,64}$/i;

export const MAX_OPS_PER_BATCH = 200;
export const MAX_CATALOG_VARIANTS = 300;
export const MAX_MESSAGE_CHARS = 4000;

export const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

export const newBatchId = () => `cab_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
export const newScanId = () => `qs_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ---------------------------------------------------------------------------
// Catalog context
// ---------------------------------------------------------------------------
// A COMPACT projection — enough to match "the 3-pack" to a variant id, to
// notice a cost is already set, and to spot a 10x typo. Not the full row: the
// per-funnel revenue splits and detection timestamps would burn context and
// hand the model numbers it has no business restating as fact.
export function catalogEntry(row) {
  const ship = isPlainObject(row.ship) ? row.ship : {};
  return {
    variant_id: String(row.variant_id || ''),
    product_title: String(row.product_title || ''),
    variant_title: String(row.variant_title || ''),
    price: row.price === null || row.price === undefined ? null : Number(row.price),
    coverage: String(row.coverage || ''),
    unit_cogs: row.unit_cogs === null || row.unit_cogs === undefined ? null : Number(row.unit_cogs),
    // WHICH rate answered. 'item' means the cost comes from the variant's cost
    // group — invariant 4 reads this and it must survive the projection.
    cogs_source: row.cogs_source ?? null,
    ship: {
      default: ship.default ?? null,
      main: ship.main ?? null,
      upsell: ship.upsell ?? null,
      addon: ship.addon ?? null,
      bump: ship.bump ?? null,
    },
    pays_shipping: row.pays_shipping === undefined ? true : Boolean(row.pays_shipping),
    units_per: Number(row.units_per || 1),
    cost_item_id: row.cost_item_id ?? null,
    contexts: Array.isArray(row.contexts) ? row.contexts : [],
  };
}

// Sorted by 30d revenue desc by listVariants itself — when the catalog is
// bigger than the cap, the variants truncated away are the ones nobody is
// selling. Truncation is REPORTED, never hidden.
export async function loadCatalogContext({ limit = MAX_CATALOG_VARIANTS } = {}) {
  const cap = Math.max(1, Math.min(parseInt(limit, 10) || MAX_CATALOG_VARIANTS, 500));
  const out = await listVariants({ limit: cap, offset: 0 });
  const items = out.items.map(catalogEntry);
  return {
    items,
    byId: new Map(items.map((e) => [e.variant_id, e])),
    itemIds: new Set(items.map((e) => e.cost_item_id).filter(Boolean).map(String)),
    total: out.total,
    truncated: out.total > items.length,
  };
}

// Membership for a SPECIFIC set of refs — the apply-time re-check. Reading
// the whole grid again would clamp at the same cap and reject a legitimate
// proposal for the 301st-by-revenue variant (the reference hit exactly this).
export async function membershipFor(refs) {
  const variantIds = [...new Set(refs.filter((r) => r.scope === 'variant').map((r) => r.ref))];
  const itemIds = [...new Set(refs.filter((r) => r.scope === 'item').map((r) => r.ref))];
  const byId = new Map();
  const items = new Set();
  if (variantIds.length) {
    const rows = await pgQuery(
      `SELECT variant_id, product_title, variant_title, price, coverage, cost_item_id,
              units_per, pays_shipping, contexts
       FROM lb_variant_costs WHERE variant_id = ANY($1)`, [variantIds]);
    for (const r of rows) byId.set(String(r.variant_id), r);
  }
  if (itemIds.length) {
    const rows = await pgQuery(
      `SELECT DISTINCT cost_item_id FROM lb_variant_costs
       WHERE cost_item_id = ANY($1)`, [itemIds]);
    for (const r of rows) if (r.cost_item_id) items.add(String(r.cost_item_id));
  }
  return { byId, items };
}

// ---------------------------------------------------------------------------
// Deterministic label → variant matching
// ---------------------------------------------------------------------------
// Used to SEED matches on quote rows (where the model is asked to transcribe,
// not to match) and to sanity-check the model in chat. Intentionally dumb and
// explainable: normalize, then score token overlap. A clever fuzzy matcher is
// one whose mistakes cannot be explained, and this one's output becomes a
// cost. Nothing it returns is ever auto-applied.
const STOP_TOKENS = new Set(['the', 'a', 'an', 'of', 'and', 'with', 'for', 'pack', 'packs', 'x', 'set', 'kit']);

export function normalizeLabel(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function labelTokens(s) {
  const norm = normalizeLabel(s);
  if (!norm) return [];
  return norm.split(' ').filter((t) => t && !STOP_TOKENS.has(t));
}

// "3-pack", "3 pack", "pack of 3", "3x" → 3. null means THE LABEL DID NOT SAY
// — which is not the same as 1, and must not collapse into it.
export function packSizeOf(label) {
  const norm = normalizeLabel(label);
  let m = /(?:^|\s)(\d{1,3})\s*(?:pack|packs|pk|ct|count|x)(?:\s|$)/.exec(norm);
  if (m) return Number(m[1]);
  m = /(?:pack|packs|pk|set|box)\s+of\s+(\d{1,3})(?:\s|$)/.exec(norm);
  if (m) return Number(m[1]);
  return null;
}

// Token overlap in [0,1], with a hard bonus when pack size agrees and a hard
// penalty when it disagrees. A "3-pack" cost landing on the 1-pack is the
// expensive mistake this matcher exists to avoid, so disagreement outweighs
// every word the two labels share.
export function scoreMatch(label, entry) {
  const wanted = labelTokens(label);
  if (!wanted.length) return 0;
  const have = new Set(labelTokens(`${entry.product_title} ${entry.variant_title}`));
  if (!have.size) return 0;
  let hit = 0;
  for (const t of wanted) if (have.has(t)) hit += 1;
  let score = hit / wanted.length;

  const wantPack = packSizeOf(label);
  const havePack = packSizeOf(`${entry.variant_title} ${entry.product_title}`)
    ?? (entry.units_per > 1 ? entry.units_per : null);
  if (wantPack !== null && havePack !== null) {
    if (wantPack === havePack) score = Math.min(1, score + 0.35);
    else score = Math.max(0, score - 0.6);
  }
  return Math.round(score * 1000) / 1000;
}

// confidence is derived from the score AND the gap to the runner-up: a 0.9
// match with a 0.89 runner-up is AMBIGUOUS, not high.
export function matchVariant(label, catalogItems) {
  const scored = (catalogItems || [])
    .map((e) => ({ entry: e, score: scoreMatch(label, e) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) {
    return {
      variant_id: null, confidence: 'none', score: 0, alternatives: [],
      reason: 'no catalog variant shares a word with this label',
    };
  }
  const best = scored[0];
  const runnerUp = scored[1] ? scored[1].score : 0;
  let confidence = 'low';
  if (best.score >= 0.999 && best.score - runnerUp >= 0.15) confidence = 'exact';
  else if (best.score >= 0.6 && best.score - runnerUp >= 0.15) confidence = 'high';
  return {
    variant_id: best.entry.variant_id,
    confidence,
    score: best.score,
    reason: `"${label}" → ${best.entry.product_title} / ${best.entry.variant_title} (score ${best.score}${runnerUp ? `, runner-up ${runnerUp}` : ''})`,
    alternatives: scored.slice(1, 4).map((s) => ({
      variant_id: s.entry.variant_id, score: s.score,
      label: `${s.entry.product_title} / ${s.entry.variant_title}`,
    })),
  };
}

// ---------------------------------------------------------------------------
// Money + ship normalization for MODEL OUTPUT
// ---------------------------------------------------------------------------
// parseMoneyText is the reference's _money: it refuses the decimal-comma form
// ("12,50") instead of stripping it, because stripping turns 12,50 into 1250
// — a 100x error, silently. Grouped thousands ("1,250.00") are accepted.
function moneyOrThrow(v, field) {
  try {
    return parseMoneyText(v);
  } catch (err) {
    if (err instanceof MoneyError) throw new CostError('bad_amount', `${field}: ${err.message}`);
    throw err;
  }
}

// A full five-key ship map; missing keys are null (unknown), NEVER 0.
export function normalizeShipInput(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const out = {};
  for (const k of SHIP_KEYS) out[k] = moneyOrThrow(src[k], `ship.${k}`);
  return out;
}

// Clamp to [0,1], 3dp. MISSING STAYS MISSING — never a midpoint (invariant 5).
export function cleanConfidence(v) {
  if (v === null || v === undefined || v === '') return null;
  const f = Number(v);
  if (!Number.isFinite(f)) return null;
  return Math.round(Math.min(1, Math.max(0, f)) * 1000) / 1000;
}

// The ship value in force for a context, following the same chain
// resolveUnitShip uses inside a single rate: ship[ctx] ?? ship.default.
// An explicit 0 is a real answer and STOPS the chain.
export function resolveShipFor(ship, ctx) {
  const s = isPlainObject(ship) ? ship : {};
  const v = s[ctx];
  if (v !== null && v !== undefined) return Number(v);
  const d = s.default;
  return d === null || d === undefined ? null : Number(d);
}

// ---------------------------------------------------------------------------
// cleanProposals — the gate
// ---------------------------------------------------------------------------
// Returns { proposals, dropped }. NOTHING THROWS: a malformed proposal is a
// normal outcome of asking a language model for structured data, and the rest
// of the batch must still reach the operator. Every refusal is REPORTED —
// silence would read as "it wasn't on the sheet".
//
// Drop reasons, in evaluation order (the reference's order, kept so the two
// implementations stay comparable):
//   not_an_object · bad_scope · unknown_variant · unknown_cost_item ·
//   duplicate_ref · bad_amount · empty_rate · bad_effective_from ·
//   currency_not_convertible · injected_text
export const DROP_REASONS = Object.freeze([
  'not_an_object', 'bad_scope', 'unknown_variant', 'unknown_cost_item',
  'duplicate_ref', 'bad_amount', 'empty_rate', 'bad_effective_from',
  'currency_not_convertible', 'injected_text',
]);

// `dedupe` is TRUE at propose time and FALSE at apply time, and the asymmetry
// is load-bearing. At propose time two entries for one variant are a model
// mistake — rule 9 tells it not to, and showing the operator two cards for the
// same variant when only one can win is worse than dropping one. At APPLY time
// the list was assembled by a browser, possibly across several turns, and two
// entries for one variant are a legitimate "set the cost, and also the ship".
// Dropping the second there would silently discard half the operator's work;
// groupWrites() merges them into the one row instead.
export function cleanProposals(rawList, { byId, itemIds, source = 'chat', carry = true, dedupe = true } = {}) {
  const proposals = [];
  const dropped = [];
  const seen = new Set();
  const list = Array.isArray(rawList) ? rawList.slice(0, MAX_OPS_PER_BATCH) : [];

  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    const drop = (reason, extra = {}) => dropped.push({ index: i, reason, ...extra });

    if (!isPlainObject(raw)) { drop('not_an_object'); continue; }

    const scope = raw.scope === undefined ? 'variant' : String(raw.scope);
    if (scope !== 'variant' && scope !== 'item') { drop('bad_scope', { scope }); continue; }

    const ref = String((scope === 'variant' ? raw.variant_id : raw.cost_item_id) || '').trim();
    if (scope === 'variant') {
      if (!VARIANT_RE.test(ref) || !byId.has(ref)) { drop('unknown_variant', { ref }); continue; }
    } else if (!ITEM_RE.test(ref) || !itemIds.has(ref)) {
      drop('unknown_cost_item', { ref }); continue;
    }

    const key = `${scope}|${ref}`;
    if (dedupe && seen.has(key)) { drop('duplicate_ref', { ref, scope }); continue; }

    let unitCogs;
    let ship;
    try {
      unitCogs = moneyOrThrow(raw.unit_cogs, 'unit_cogs');
      ship = normalizeShipInput(raw.ship);
    } catch (err) {
      if (err instanceof CostError) { drop('bad_amount', { ref, scope, detail: err.message }); continue; }
      throw err;
    }
    if (unitCogs === null && SHIP_KEYS.every((k) => ship[k] === null)) {
      drop('empty_rate', { ref, scope }); continue;
    }

    let effectiveFrom = null;
    if (raw.effective_from !== undefined && raw.effective_from !== null && raw.effective_from !== '') {
      effectiveFrom = String(raw.effective_from);
      if (!DAY_RE.test(effectiveFrom)) { drop('bad_effective_from', { ref, scope }); continue; }
    }

    const currency = String(raw.currency || 'USD').toUpperCase();
    if (currency !== 'USD') { drop('currency_not_convertible', { ref, scope, currency }); continue; }

    // Instruction-shaped text in a model-authored note is quarantined: it is
    // about to be stored on a rate row an operator reads later.
    const note = String(raw.note || '').slice(0, 500);
    const reason = String(raw.reason || '').slice(0, 300);
    if (scanInjection(note).length || scanInjection(reason).length) {
      drop('injected_text', { ref, scope }); continue;
    }

    seen.add(key);
    const entry = scope === 'variant' ? byId.get(ref) : null;
    const p = {
      index: i,
      scope,
      variant_id: scope === 'variant' ? ref : null,
      cost_item_id: scope === 'item' ? ref : null,
      unit_cogs: unitCogs,
      ship,
      effective_from: effectiveFrom,
      only_from_today: Boolean(raw.only_from_today),
      currency: 'USD',
      source,
      confidence: cleanConfidence(raw.confidence),
      reason,
      note,
      // Display-only, so review shows before → after without a second round
      // trip. NEVER sent back on apply (the apply door rebuilds them).
      product_title: entry ? entry.product_title : '',
      variant_title: entry ? entry.variant_title : '',
      price: entry ? entry.price : null,
      coverage: entry ? entry.coverage : null,
      current_unit_cogs: entry ? entry.unit_cogs : null,
      current_ship: entry ? entry.ship : {},
    };
    proposals.push(carry && entry ? carryForward(p, entry) : p);
  }
  return { proposals, dropped };
}

// ---------------------------------------------------------------------------
// carryForward — invariant 3 + invariant 4
// ---------------------------------------------------------------------------
// A rate row REPLACES what is in force from its effective day. A proposal that
// sets only shipping would therefore erase the variant's cost from that day
// forward. Copy the currently-resolved values the proposal does not mention
// into the row that will be written, and RECORD which ones were carried so
// the operator sees it on the card rather than discovering it in the P&L.
//
// COGS is carried ONLY when it is variant-sourced. A group-sourced cost stays
// null so the cost group keeps answering through fall-through — freezing the
// group's current number onto the variant would silently detach it.
export function carryForward(proposal, entry) {
  const out = { ...proposal, ship: { ...proposal.ship } };
  const carriedShip = [];
  let carriedCogs = false;

  if (out.unit_cogs === null && entry.unit_cogs !== null && entry.cogs_source !== 'item') {
    out.unit_cogs = entry.unit_cogs;
    carriedCogs = true;
  }
  for (const ctx of CONTEXTS) {
    if (resolveShipFor(out.ship, ctx) !== null) continue;
    const current = resolveShipFor(entry.ship, ctx);
    if (current === null) continue;
    out.ship[ctx] = current;
    carriedShip.push({ context: ctx, value: current });
  }

  out.carried_cogs = carriedCogs;
  out.carried_ship = carriedShip;
  // A proposal whose values equal what is already in force appends a duplicate
  // row to an append-only ledger — legal and useless. Flagged, not blocked.
  const sameCogs = out.unit_cogs === entry.unit_cogs;
  const sameShip = CONTEXTS.every((c) => resolveShipFor(out.ship, c) === resolveShipFor(entry.ship, c));
  out.no_change = sameCogs && sameShip;
  return out;
}

// ---------------------------------------------------------------------------
// groupWrites — invariant 3
// ---------------------------------------------------------------------------
// Merge proposals that would write the SAME (scope, ref, effective_from,
// only_from_today) into one row. Within a group: the last non-null unit_cogs
// wins; each non-null ship key overwrites; notes and reasons are joined.
// `index` keeps the FIRST member's position so a failure can be mapped back
// onto the card the operator is looking at.
export function groupWrites(proposals) {
  const groups = new Map();
  for (const p of proposals) {
    const ref = p.scope === 'variant' ? p.variant_id : p.cost_item_id;
    const key = `${p.scope}|${ref}|${p.effective_from || ''}|${p.only_from_today ? 1 : 0}|${p.currency}`;
    if (!groups.has(key)) {
      groups.set(key, {
        ...p,
        ship: { ...p.ship },
        notes: p.note ? [p.note] : [],
        reasons: p.reason ? [p.reason] : [],
        members: [p.index],
      });
      continue;
    }
    const g = groups.get(key);
    if (p.unit_cogs !== null) g.unit_cogs = p.unit_cogs;
    for (const k of SHIP_KEYS) if (p.ship[k] !== null) g.ship[k] = p.ship[k];
    if (p.note) g.notes.push(p.note);
    if (p.reason) g.reasons.push(p.reason);
    g.members.push(p.index);
  }
  return [...groups.values()].map((g) => ({
    ...g,
    note: g.notes.join(' | ').slice(0, 500),
    reason: g.reasons.join(' | ').slice(0, 300),
  }));
}

// ---------------------------------------------------------------------------
// APPLY — the only write
// ---------------------------------------------------------------------------
// source: 'import'. The source column answers "where did this number come
// from" a month later, and the honest answer for an assistant/quote-driven
// rate is not 'manual'. The operator's confirmation is recorded as WHO, in
// created_by and in the audit row — not by relabelling the provenance.
export const APPLY_SOURCE = 'import';

// Ops are applied INDEPENDENTLY, not in one transaction: an append-only
// ledger has no partial state to roll back to, and refusing to record the
// four costs that were fine because the fifth had a typo is worse than the
// alternative. Partial success is a first-class outcome and the audit row
// records both sides.
export async function applyProposals({
  proposals, kind = 'chat', model = '', sourceText = '', quoteScanId = null,
  createdBy = '', batchId = null, note = '',
}) {
  await ensureCogsAssistantTables();
  const batch = String(batchId || newBatchId()).slice(0, 64);
  const writes = groupWrites(proposals);

  const applied = [];
  const failed = [];
  for (const w of writes) {
    const ref = w.scope === 'variant' ? w.variant_id : w.cost_item_id;
    try {
      const row = await appendRate({
        scope: w.scope,
        refId: ref,
        unitCogs: w.unit_cogs,
        ship: w.ship,
        effectiveFrom: w.effective_from,
        onlyFromToday: w.only_from_today,
        currency: 'USD',
        source: APPLY_SOURCE,
        batchId: batch,
        note: (w.note || note || '').slice(0, 500),
        createdBy,
      });
      applied.push({
        index: w.index,
        members: w.members,
        rate_id: Number(row.id),
        scope: row.scope,
        variant_id: row.variant_id,
        cost_item_id: row.cost_item_id,
        effective_from: row.effective_from,
        unit_cogs: row.unit_cogs === null ? null : Number(row.unit_cogs),
        ship: row.ship,
        created_at: row.created_at,
      });
    } catch (err) {
      // A CostError is an operator-actionable refusal. Anything else is a
      // real fault and must NOT be laundered into a per-op note — rethrow so
      // the route 500s honestly.
      if (!(err instanceof CostError)) throw err;
      failed.push({ index: w.index, members: w.members, ref, code: err.code, error: err.message });
    }
  }

  const [audit] = await pgQuery(
    `INSERT INTO lb_cogs_assistant_audit
       (batch_id, kind, model, source_text, quote_scan_id, proposal, applied,
        applied_count, rejected_count, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, batch_id, kind, model, source_text, quote_scan_id, proposal,
               applied, applied_count, rejected_count, created_by, created_at`,
    [
      batch,
      kind === 'quote' ? 'quote' : 'chat',
      String(model || '').slice(0, 64),
      String(sourceText || '').slice(0, 4000),
      quoteScanId ? String(quoteScanId).slice(0, 64) : null,
      // Raw JS values — postgres.js encodes jsonb. A PRE-STRINGIFIED object
      // lands as a jsonb STRING and every later ->> read returns nothing.
      proposals,
      applied,
      applied.length,
      failed.length,
      String(createdBy || '').slice(0, 128),
    ]
  );

  return {
    batch_id: batch,
    applied,
    failed,
    applied_count: applied.length,
    failed_count: failed.length,
    audit_id: Number(audit.id),
    summary: `Applied ${applied.length} change(s)${failed.length ? ` · ${failed.length} failed` : ''}`,
  };
}

// ---------------------------------------------------------------------------
// Audit read
// ---------------------------------------------------------------------------
export async function listAudit({ limit = 50, offset = 0, kind = null, batchId = null } = {}) {
  await ensureCogsAssistantTables();
  const where = [];
  const params = [];
  if (kind) {
    if (kind !== 'chat' && kind !== 'quote') throw new CostError('bad_kind', 'kind must be chat or quote');
    params.push(kind);
    where.push(`kind = $${params.length}`);
  }
  if (batchId) {
    const b = String(batchId).slice(0, 64);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(b)) throw new CostError('bad_batch_id', 'batch_id is not a batch id');
    params.push(b);
    where.push(`batch_id = $${params.length}`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const lim = Math.max(1, Math.min(parseInt(limit, 10) || 50, 200));
  const off = Math.max(0, parseInt(offset, 10) || 0);
  const [{ count }] = await pgQuery(
    `SELECT COUNT(*)::int AS count FROM lb_cogs_assistant_audit ${clause}`, params);
  const rows = await pgQuery(
    `SELECT id, batch_id, kind, model, source_text, quote_scan_id, proposal, applied,
            applied_count, rejected_count, created_by, created_at
     FROM lb_cogs_assistant_audit ${clause}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, lim, off]
  );
  return { items: rows, total: count, limit: lim, offset: off };
}

// ---------------------------------------------------------------------------
// Quote scan persistence — the matrix and a hash, never the file
// ---------------------------------------------------------------------------
export async function saveQuoteScan({
  contentHash, contentType, byteSize, filename, model, header, matrix, verify, createdBy,
}) {
  await ensureCogsAssistantTables();
  const id = newScanId();
  const [row] = await pgQuery(
    `INSERT INTO lb_quote_scans
       (id, content_hash, content_type, byte_size, filename, model, header, matrix, verify, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, content_hash, content_type, byte_size, filename, model, header,
               matrix, verify, created_by, created_at`,
    [
      id,
      String(contentHash).slice(0, 64),
      String(contentType || '').slice(0, 64),
      Number(byteSize) || 0,
      String(filename || '').slice(0, 200),
      String(model || '').slice(0, 64),
      header || {},
      matrix || [],
      verify || {},
      String(createdBy || '').slice(0, 128),
    ]
  );
  return row;
}

export async function getQuoteScan(id) {
  await ensureCogsAssistantTables();
  const [row] = await pgQuery(
    `SELECT id, content_hash, content_type, byte_size, filename, model, header,
            matrix, verify, created_by, created_at
     FROM lb_quote_scans WHERE id = $1`, [String(id || '').slice(0, 64)]);
  return row || null;
}

// Prior scans of the SAME bytes — "you scanned this on the 3rd" without
// keeping the document.
export async function priorScansOf(contentHash) {
  await ensureCogsAssistantTables();
  return pgQuery(
    `SELECT id, filename, created_by, created_at FROM lb_quote_scans
     WHERE content_hash = $1 ORDER BY created_at DESC LIMIT 5`,
    [String(contentHash).slice(0, 64)]
  );
}

export { CONTEXTS, SHIP_KEYS, dayKey, CostError };
