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
// ── THE INVARIANTS ────────────────────────────────────────────────────────
// Five carried over from the funnel-os reference, three added by review:
//
//  1. THE HALLUCINATION GATE. A variant_id is dropped unless it is a key of
//     the catalog we just loaded. Format validity is NOT enough — a
//     well-formed id for a variant that does not exist would append a rate
//     nothing ever reads, under a green "applied".
//  2. VALIDATE TWICE. Once at propose, once at apply against a FRESHLY read
//     catalog — the proposals have made a round trip through a browser.
//  3. A RATE ROW IS A SNAPSHOT, NOT A PATCH. resolveUnitCogs reads the ONE
//     rate in force for a day; it does not fall back to an earlier row for a
//     null field. So two rows for the same (variant, day) — one setting cost,
//     one setting ship — leave the ship-only row winning and the cost
//     resolving to UNKNOWN. groupWrites() merges same-ref proposals, and
//     carryForward() copies the currently-resolved values a proposal does not
//     mention into the row it will write.
//  4. CARRY-FORWARD RESPECTS cogs_source. If a variant's cost currently comes
//     from its COST GROUP (cogs_source === 'item'), carrying that value into a
//     variant-scoped row FREEZES the variant out of its group. Those stay null.
//  5. MODEL CONFIDENCE MAY DEMOTE, NEVER PROMOTE. Recorded and shown; nothing
//     is auto-applied off it, and a missing confidence stays null.
//
//  6. (review B2) CARRY-FORWARD RUNS AT THE APPLY DOOR, FOR EVERY SOURCE.
//     It used to run only on the chat PROPOSE path, so a quote row whose cost
//     was unreadable — or whose zero MODEL_ZERO had just demoted to null —
//     applied `unit_cogs: null` straight over a real cost and erased it, while
//     the confirm dialog said "nothing is overwritten". A null NEVER overwrites
//     a non-null resolved value now; the only way to clear one is to say so,
//     via explicit_clear, which the plan table renders as its own red row.
//  7. (review B1) APPLY IS ONE TRANSACTION, AND IDEMPOTENT PER BATCH.
//     Rates and the audit row commit together or not at all, and re-applying
//     an op this batch already wrote returns already_applied rather than a
//     second rate row.
//  8. (review M5) AN IDENTICAL ROW IS NOT WRITTEN TWICE. A proposal whose
//     field-set equals the rate already in force is skipped as no_change —
//     appending it would add a duplicate to an append-only ledger.
import { createHash, randomBytes } from 'crypto';
import { pgQuery, client as pgClient } from '../db/pg.js';
import { ensureCogsAssistantTables } from './cogsAssistantSchema.js';
import {
  parseMoneyText, MoneyError, screenInstructionText, verifyMatrix, sanitizeText,
} from './quoteVerify.js';
import {
  CONTEXTS, SHIP_KEYS, CostError, appendRate, listVariants, loadCostIndex,
  resolveUnitShip, variantRow, dayKey,
} from './funnelCosts.js';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const VARIANT_RE = /^[0-9]{6,20}$/;
const ITEM_RE = /^ci_[0-9a-z_-]{2,64}$/i;

// Earlier than any order this business has ever taken — the floor for a
// backdate on a ref with no known first sale (mirrors funnelCosts' EPOCH_DAY).
const EFFECTIVE_FROM_FLOOR = '2000-01-01';

export const MAX_OPS_PER_BATCH = 200;
export const MAX_CATALOG_VARIANTS = 300;
export const MAX_MESSAGE_CHARS = 4000;

// ONE allowlist for the whole lane (review NIT). The chat service, the vision
// extractor and the route all read this; two copies is how an allowlist gets
// widened in one place and not the other.
export const MODEL_ALLOWLIST = Object.freeze(['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5']);
export const DEFAULT_MODEL = 'claude-fable-5';

export const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

export const newBatchId = () => `cab_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
export const newEventId = () => `evt_${Date.now().toString(36)}_${randomBytes(5).toString('hex')}`;
export const newScanId = () => `qs_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// Money comparison for idempotency. null and 0 are DIFFERENT values here, as
// everywhere else in this lane; the epsilon only absorbs NUMERIC(12,4) round
// trips, never the null/zero distinction.
export function moneyEq(a, b) {
  const x = a === null || a === undefined || a === '' ? null : Number(a);
  const y = b === null || b === undefined || b === '' ? null : Number(b);
  if (x === null || y === null) return x === y;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) < 1e-9;
}

export function sameFieldSet(a, b) {
  if (!moneyEq(a?.unit_cogs, b?.unit_cogs)) return false;
  const sa = isPlainObject(a?.ship) ? a.ship : {};
  const sb = isPlainObject(b?.ship) ? b.ship : {};
  return SHIP_KEYS.every((k) => moneyEq(sa[k], sb[k]));
}

// ---------------------------------------------------------------------------
// Catalog context
// ---------------------------------------------------------------------------
// A COMPACT projection — enough to match "the 3-pack" to a variant id, to
// notice a cost is already set, and to spot a 10x typo. Not the full row.
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
    // The same question PER SHIPPING CONTEXT (seam audit M3). variantRow does
    // not carry it, so membershipFor/loadCatalogContext fill it in; the key
    // exists here so the shape is stable and a missing source is visibly null
    // rather than an absent property.
    ship_source: isPlainObject(row.ship_source) ? row.ship_source : null,
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
    // The backdating floor (review M4) — a model-supplied effective_from
    // earlier than the variant's first sale is a restatement of a period this
    // variant did not exist in.
    first_sold: String(row.first_sold || ''),
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
  // Per-field provenance is not on the grid projection, and carry-forward
  // needs it (M3). Resolve it through the SAME function the apply door uses,
  // so the card can never promise a carry the write then withholds — the two
  // paths agree by construction rather than by matching code.
  if (items.length) {
    const live = await membershipFor(items.map((e) => ({ scope: 'variant', ref: e.variant_id })));
    for (const e of items) {
      const st = live.byId.get(e.variant_id);
      if (st) e.ship_source = st.ship_source;
    }
  }
  // Live cost groups come from lb_cost_items, the same table appendRate
  // validates against (seam audit M4). Deriving them from the variants' column
  // made the propose door blind to a group with no members yet — a supported
  // state the groups lane creates on purpose — so the assistant refused an id
  // the manual rate door accepts. Both doors now read one table.
  const groups = await pgQuery(
    `SELECT cost_item_id FROM lb_cost_items WHERE archived = FALSE`);
  return {
    items,
    byId: new Map(items.map((e) => [e.variant_id, e])),
    itemIds: new Set(groups.map((g) => String(g.cost_item_id)).filter(Boolean)),
    total: out.total,
    truncated: out.total > items.length,
  };
}

// ---------------------------------------------------------------------------
// membershipFor — the apply-time catalog read
// ---------------------------------------------------------------------------
// Membership for exactly the refs in the request, NOT the whole grid: reading
// the grid again clamps at the same cap and would reject a legitimate proposal
// for the 301st-by-revenue variant.
//
// It returns the RESOLVED state (unit_cogs, cogs_source, ship, ship_source),
// not just the catalog columns. The first cut selected none of it, so
// carryForward had nothing to carry and silently carried nothing. The
// resolution goes through funnelCosts.variantRow, the same projection the grid
// renders, so it cannot drift from what the operator saw.
//
// THE INDEX IS loadCostIndex, NOT buildRateIndex(loadRates()) (seam audit M2).
// Rates and MEMBERSHIPS are two halves of one index: loading only the rates
// silently reverts group resolution to "as of now", which is the restatement
// bug lb_cost_item_members exists to prevent. funnelCosts says out loud that
// no call site may take only half — this one was taking half.
export async function membershipFor(refs, { exec = pgQuery } = {}) {
  const variantIds = [...new Set(refs.filter((r) => r.scope === 'variant').map((r) => r.ref).filter(Boolean))];
  const itemIds = [...new Set(refs.filter((r) => r.scope === 'item').map((r) => r.ref).filter(Boolean))];
  const byId = new Map();
  const items = new Map();
  if (!variantIds.length && !itemIds.length) return { byId, items, itemIds: new Set() };

  const costIndex = await loadCostIndex(exec);
  const today = dayKey();

  if (variantIds.length) {
    const rows = await exec(`SELECT * FROM lb_variant_costs WHERE variant_id = ANY($1)`, [variantIds]);
    for (const vc of rows) {
      const entry = catalogEntry(variantRow(vc, costIndex, today));
      entry.ship_source = shipSourcesFor(vc, costIndex, today);
      byId.set(String(vc.variant_id), entry);
    }
  }
  if (itemIds.length) {
    // EXISTENCE IS lb_cost_items, NOT the lb_variant_costs column (seam audit
    // M4). A group with no members yet is an explicitly supported state — the
    // groups lane lets an operator create one and price it before binding a
    // single variant — and resolving membership from the column made the
    // assistant answer unknown_cost_item for a group the manual rate door
    // prices happily. The two doors now ask the same table appendRate does.
    const rows = await exec(
      `SELECT cost_item_id, archived FROM lb_cost_items WHERE cost_item_id = ANY($1)`, [itemIds]);
    for (const r of rows) {
      const id = String(r.cost_item_id || '');
      // An archived group is refused at the write door too — offering it here
      // would only produce a rate that reaches no variant.
      if (!id || r.archived) continue;
      const rate = costIndex.lookup('item', id, today);
      const ship = rate && isPlainObject(rate.ship) ? rate.ship : {};
      const shipMap = {
        default: ship.default ?? null,
        main: ship.main ?? null,
        upsell: ship.upsell ?? null,
        addon: ship.addon ?? null,
        bump: ship.bump ?? null,
      };
      const shipSource = {};
      for (const ctx of CONTEXTS) {
        shipSource[ctx] = resolveShipFor(shipMap, ctx) === null ? null : 'item';
      }
      items.set(id, {
        cost_item_id: id,
        unit_cogs: rate && rate.unit_cogs !== null && rate.unit_cogs !== undefined
          ? Number(rate.unit_cogs) : null,
        cogs_source: rate ? 'item' : null,
        ship: shipMap,
        // An item-scoped proposal carries from the ITEM, so this being 'item'
        // is not a reason to withhold — carryForward's guard is scope-aware.
        ship_source: shipSource,
        first_sold: '',
      });
    }
  }
  return { byId, items, itemIds: new Set(items.keys()) };
}

// PER-CONTEXT ship provenance (seam audit M3). variantRow reports cogs_source
// but discards the source resolveUnitShip returns, and carryForward needs it:
// a variant whose shipping currently comes from its cost GROUP must not have
// that figure frozen into a variant-scoped rate. Different contexts can
// legitimately resolve from different places (a variant rate that sets
// ship.main but not ship.upsell falls through to the group for upsell only),
// so this is a map, never one value.
export function shipSourcesFor(vc, costIndex, today) {
  const out = {};
  for (const ctx of CONTEXTS) {
    const [, src] = resolveUnitShip(vc, costIndex, today, ctx);
    out[ctx] = src;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deterministic label → variant matching
// ---------------------------------------------------------------------------
// Used to SEED matches on quote rows and to sanity-check the model in chat.
// Intentionally dumb and explainable: a clever fuzzy matcher is one whose
// mistakes cannot be explained, and this one's output becomes a cost. Nothing
// it returns is ever auto-applied.
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
// effective_from bounds (review M4)
// ---------------------------------------------------------------------------
// A model-supplied date is a restatement of already-reported profit. Two
// bounds, both named refusals rather than a clamp — silently moving an
// operator's date is how a backdate becomes a surprise.
//   floor   the ref's first sale (nothing sold before it can have had a cost),
//           or the epoch floor when there is no known first sale
//   ceiling today, in the REPORT timezone (the one the engine buckets in) —
//           a future-dated rate is in force for nothing and resolves to
//           nothing, so it reads as "the cost did not save"
export function effectiveFromBounds(state) {
  const fs = String(state?.first_sold || '');
  return {
    floor: DAY_RE.test(fs) ? fs : EFFECTIVE_FROM_FLOOR,
    ceiling: dayKey(),
  };
}

export function effectiveFromError(day, state) {
  if (!DAY_RE.test(day)) return 'bad_effective_from';
  const { floor, ceiling } = effectiveFromBounds(state);
  if (day > ceiling) return 'effective_from_in_future';
  if (day < floor) return 'effective_from_before_first_sale';
  return null;
}

// ---------------------------------------------------------------------------
// cleanProposals — the gate
// ---------------------------------------------------------------------------
// Returns { proposals, dropped }. NOTHING THROWS: a malformed proposal is a
// normal outcome of asking a language model for structured data, and the rest
// of the batch must still reach the operator. Every refusal is REPORTED —
// silence would read as "it wasn't on the sheet".
export const DROP_REASONS = Object.freeze([
  'not_an_object', 'bad_scope', 'unknown_variant', 'unknown_cost_item',
  'duplicate_ref', 'bad_amount', 'empty_rate', 'bad_effective_from',
  'effective_from_in_future', 'effective_from_before_first_sale',
  'bad_only_from_today', 'currency_not_convertible', 'injected_text',
  'row_id_required', 'verify_blocked',
]);

// `dedupe` is TRUE at propose time and FALSE at apply time, and the asymmetry
// is load-bearing. At propose time two entries for one variant are a model
// mistake — rule 9 tells it not to, and showing two cards for one variant when
// only one can win is worse than dropping one. At APPLY time the list was
// assembled by a browser, possibly across several turns, and two entries for
// one variant are a legitimate "set the cost, and also the ship". Dropping the
// second there would silently discard half the operator's work; groupWrites()
// merges them into the one row instead.
//
// `carry` is TRUE on BOTH doors now (review B2). It was false at apply, which
// is how a quote row with a null cost erased a real one.
export function cleanProposals(rawList, {
  byId, itemIds, items = null, source = 'chat', carry = true, dedupe = true,
  verifyBlocked = null,
} = {}) {
  const proposals = [];
  const dropped = [];
  const seen = new Set();
  const list = Array.isArray(rawList) ? rawList.slice(0, MAX_OPS_PER_BATCH) : [];
  const itemState = items instanceof Map ? items : new Map();
  const knownItems = itemIds instanceof Set ? itemIds : new Set(itemIds || []);

  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    const drop = (reason, extra = {}) => dropped.push({ index: i, reason, ...extra });

    if (!isPlainObject(raw)) { drop('not_an_object'); continue; }

    const scope = raw.scope === undefined ? 'variant' : String(raw.scope);
    if (scope !== 'variant' && scope !== 'item') { drop('bad_scope', { scope }); continue; }

    const ref = String((scope === 'variant' ? raw.variant_id : raw.cost_item_id) || '').trim();
    if (scope === 'variant') {
      if (!VARIANT_RE.test(ref) || !byId.has(ref)) { drop('unknown_variant', { ref }); continue; }
    } else if (!ITEM_RE.test(ref) || !knownItems.has(ref)) {
      drop('unknown_cost_item', { ref }); continue;
    }

    const key = `${scope}|${ref}`;
    if (dedupe && seen.has(key)) { drop('duplicate_ref', { ref, scope }); continue; }

    // THE VERIFIER'S VERDICT IS SERVER-SIDE (review M3). For a quote-sourced
    // op the row_id is mandatory, and a row the verifier blocked cannot be
    // applied however the client feels about it.
    let rowId = null;
    if (verifyBlocked) {
      rowId = String(raw.row_id || '').slice(0, 32);
      if (!rowId) { drop('row_id_required', { ref, scope }); continue; }
      const rules = verifyBlocked.get(rowId);
      if (rules) { drop('verify_blocked', { ref, scope, row_id: rowId, rules }); continue; }
    }

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

    // A boolean, not a truthy value: "only_from_today": "no" would otherwise
    // pin a backdate to today and quietly lose the historical restatement.
    if (raw.only_from_today !== undefined && typeof raw.only_from_today !== 'boolean') {
      drop('bad_only_from_today', { ref, scope }); continue;
    }

    const state = scope === 'variant' ? byId.get(ref) : (itemState.get(ref) || null);

    let effectiveFrom = null;
    if (raw.effective_from !== undefined && raw.effective_from !== null && raw.effective_from !== '') {
      effectiveFrom = String(raw.effective_from);
      const efErr = effectiveFromError(effectiveFrom, state);
      if (efErr) {
        const { floor, ceiling } = effectiveFromBounds(state);
        drop(efErr, { ref, scope, effective_from: effectiveFrom, floor, ceiling });
        continue;
      }
    }

    const currency = String(raw.currency || 'USD').toUpperCase();
    if (currency !== 'USD') { drop('currency_not_convertible', { ref, scope, currency }); continue; }

    // Instruction-shaped text in a model-authored note is screened out: it is
    // about to be stored on a rate row an operator reads later. See the note
    // on screenInstructionText — this is a tripwire, not a boundary.
    // sanitizeText, not a bare slice: a NUL or a bidi override in a
    // model-authored note is a 500 at the INSERT (Postgres refuses 0x00 in
    // text) and a spoofed line in the audit trail. Both are cheap to remove
    // here and expensive to meet at the write door.
    const note = sanitizeText(raw.note || '', 500);
    const reason = sanitizeText(raw.reason || '', 300);
    if (screenInstructionText(note).length || screenInstructionText(reason).length) {
      drop('injected_text', { ref, scope }); continue;
    }

    // The operator saying "clear this" is the ONLY thing that lets a null pass
    // carry-forward. Anything not in this list is a field the proposal simply
    // did not mention.
    const explicitClear = Array.isArray(raw.explicit_clear)
      ? raw.explicit_clear.map((s) => String(s)).filter((s) => s === 'unit_cogs' || s === 'ship')
      : [];

    seen.add(key);
    const p = {
      index: i,
      row_id: rowId,
      scope,
      variant_id: scope === 'variant' ? ref : null,
      cost_item_id: scope === 'item' ? ref : null,
      unit_cogs: unitCogs,
      ship,
      effective_from: effectiveFrom,
      only_from_today: raw.only_from_today === true,
      currency: 'USD',
      source,
      confidence: cleanConfidence(raw.confidence),
      explicit_clear: explicitClear,
      reason,
      note,
      // Display-only, so review shows before → after without a second round
      // trip. NEVER trusted on apply (the apply door rebuilds them).
      product_title: state?.product_title || '',
      variant_title: state?.variant_title || '',
      price: state?.price ?? null,
      coverage: state?.coverage ?? null,
      current_unit_cogs: state?.unit_cogs ?? null,
      current_ship: state?.ship || {},
    };
    proposals.push(carry && state ? carryForward(p, state) : p);
  }
  return { proposals, dropped };
}

// ---------------------------------------------------------------------------
// carryForward — invariants 3, 4 and 6
// ---------------------------------------------------------------------------
// A rate row REPLACES what is in force from its effective day. A proposal that
// sets only shipping would therefore ERASE the ref's cost from that day
// forward. Copy the currently-resolved values the proposal does not mention
// into the row that will be written, and RECORD which ones were carried so the
// operator sees it on the card rather than discovering it in the P&L.
//
// TWO EXCEPTIONS, and only two:
//  · explicit_clear — the operator said "clear this". The null is written and
//    the plan table renders the row in red, because clearing a cost withholds
//    profit for every leg that used it.
//  · a VARIANT-scoped proposal never carries a GROUP-sourced cost
//    (cogs_source === 'item'). Freezing the group's current number onto the
//    variant would detach it from the group without saying so. An item-scoped
//    proposal carries from the item's own rate, where that concern does not
//    arise.
export function carryForward(proposal, state) {
  const out = { ...proposal, ship: { ...proposal.ship } };
  const clear = new Set(proposal.explicit_clear || []);
  const carriedShip = [];
  let carriedCogs = false;

  // The guard is PER FIELD, and shipping needs it just as much as COGS (seam
  // audit M3). It was only applied to COGS, so a variant-scoped proposal on a
  // variant whose freight comes from its cost group copied the group's figure
  // into a variant rate — silently detaching that variant's shipping from the
  // group, on all four legs, the exact failure invariant 4 exists to prevent.
  // An ITEM-scoped proposal is exempt: the rate it is carrying from IS the
  // group's own.
  const fromGroup = (source) => proposal.scope !== 'item' && source === 'item';

  if (out.unit_cogs === null && !clear.has('unit_cogs') && state.unit_cogs !== null
    && !fromGroup(state.cogs_source)) {
    out.unit_cogs = state.unit_cogs;
    carriedCogs = true;
  }
  if (!clear.has('ship')) {
    for (const ctx of CONTEXTS) {
      if (resolveShipFor(out.ship, ctx) !== null) continue;
      const current = resolveShipFor(state.ship, ctx);
      if (current === null) continue;
      // No source recorded means the state was built by a caller that does not
      // track provenance. Withhold rather than guess: a carry that should not
      // have happened is a silent detachment, a carry that did not happen is a
      // visible blank the operator can fill in.
      if (fromGroup(state.ship_source?.[ctx] ?? 'item')) continue;
      out.ship[ctx] = current;
      carriedShip.push({ context: ctx, value: current });
    }
  }

  out.carried_cogs = carriedCogs;
  out.carried_ship = carriedShip;
  out.clears_cogs = clear.has('unit_cogs') && state.unit_cogs !== null;
  out.clears_ship = clear.has('ship')
    && CONTEXTS.some((c) => resolveShipFor(state.ship, c) !== null)
    && CONTEXTS.every((c) => resolveShipFor(out.ship, c) === null);
  // A proposal whose values equal what is already in force appends a duplicate
  // row to an append-only ledger — legal and useless. Flagged here for the UI;
  // the apply door refuses it outright (invariant 8).
  const sameCogs = moneyEq(out.unit_cogs, state.unit_cogs);
  const sameShip = CONTEXTS.every((c) => moneyEq(resolveShipFor(out.ship, c), resolveShipFor(state.ship, c)));
  out.no_change = sameCogs && sameShip;
  return out;
}

// ---------------------------------------------------------------------------
// groupWrites — invariant 3
// ---------------------------------------------------------------------------
// Merge proposals that would write the SAME (scope, ref, effective_from,
// only_from_today) into one row. Within a group: the last non-null unit_cogs
// wins; each non-null ship key overwrites; notes and reasons are joined.
// `index` keeps the FIRST member's position so a failure maps back onto the
// card the operator is looking at.
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
        row_ids: p.row_id ? [p.row_id] : [],
      });
      continue;
    }
    const g = groups.get(key);
    if (p.unit_cogs !== null) g.unit_cogs = p.unit_cogs;
    for (const k of SHIP_KEYS) if (p.ship[k] !== null) g.ship[k] = p.ship[k];
    if (p.note) g.notes.push(p.note);
    if (p.reason) g.reasons.push(p.reason);
    g.members.push(p.index);
    if (p.row_id) g.row_ids.push(p.row_id);
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

// The rate rows and the audit row commit TOGETHER (review B1). Before this,
// the audit insert ran after the writes and collided on a UNIQUE batch_id the
// second time an operator applied a card from the same chat turn: the rate
// landed, the request 500'd, the card said "Not applied", and there was no
// audit row to find the orphan by.
//
// Inside the transaction, ops are still applied INDEPENDENTLY of one another:
// a CostError is a pure-JS refusal raised before any statement is issued, so
// it cannot poison the transaction, and refusing to record the four costs that
// were fine because the fifth had a typo is worse than the alternative. A
// non-CostError IS a real fault — it rolls the whole thing back and 500s,
// because a half-written batch with a lying audit row is the failure mode this
// transaction exists to remove.
export async function applyProposals({
  proposals, kind = 'chat', model = '', sourceText = '', quoteScanId = null,
  createdBy = '', batchId = null, note = '',
}) {
  await ensureCogsAssistantTables();
  const batch = String(batchId || newBatchId()).slice(0, 64);
  const eventId = newEventId();
  const writes = groupWrites(proposals);

  const applied = [];
  const failed = [];
  const skipped = [];

  await pgClient.begin(async (tx) => {
    const exec = (text, params) => tx.unsafe(text, params);

    // Everything this batch has ALREADY written, read once inside the
    // transaction. This is the idempotency ledger: the assistant does not need
    // its own, because every rate it writes carries the batch id.
    const priorByRef = new Map();
    const priorRows = await exec(
      `SELECT id, scope, variant_id, cost_item_id, unit_cogs, ship,
              to_char(effective_from, 'YYYY-MM-DD') AS effective_from
       FROM lb_cost_rates WHERE batch_id = $1`, [batch]);
    for (const r of priorRows) {
      const key = `${r.scope}|${r.scope === 'variant' ? r.variant_id : r.cost_item_id}`;
      if (!priorByRef.has(key)) priorByRef.set(key, []);
      priorByRef.get(key).push(r);
    }

    for (const w of writes) {
      const ref = w.scope === 'variant' ? w.variant_id : w.cost_item_id;
      const key = `${w.scope}|${ref}`;

      // ── already_applied: this exact field-set, from this batch ──────────
      const dupe = (priorByRef.get(key) || []).find((r) => sameFieldSet(
        { unit_cogs: r.unit_cogs, ship: r.ship }, { unit_cogs: w.unit_cogs, ship: w.ship }));
      if (dupe) {
        skipped.push({
          index: w.index, members: w.members, ref, scope: w.scope,
          reason: 'already_applied', rate_id: Number(dupe.id),
          effective_from: dupe.effective_from,
        });
        continue;
      }

      // ── no_change: identical to the rate already in force ───────────────
      // Only when the proposal does not backdate past that rate — an earlier
      // effective_from with the same numbers DOES change history, by covering
      // days the current row does not reach.
      const [inForce] = await exec(
        `SELECT id, unit_cogs, ship, to_char(effective_from, 'YYYY-MM-DD') AS effective_from
         FROM lb_cost_rates
         WHERE scope = $1 AND ${w.scope === 'variant' ? 'variant_id' : 'cost_item_id'} = $2
         ORDER BY effective_from DESC, created_at DESC, id DESC LIMIT 1`,
        [w.scope, ref]);
      if (inForce
        && sameFieldSet({ unit_cogs: inForce.unit_cogs, ship: inForce.ship }, { unit_cogs: w.unit_cogs, ship: w.ship })
        && (!w.effective_from || w.effective_from >= inForce.effective_from)) {
        skipped.push({
          index: w.index, members: w.members, ref, scope: w.scope,
          reason: 'no_change', rate_id: Number(inForce.id),
          effective_from: inForce.effective_from,
        });
        continue;
      }

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
          exec,
        });
        const entry = {
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
        };
        applied.push(entry);
        // Later writes in THIS call must see it too, or a list carrying the
        // same op twice would write it twice.
        if (!priorByRef.has(key)) priorByRef.set(key, []);
        priorByRef.get(key).push({
          id: row.id, scope: row.scope, variant_id: row.variant_id,
          cost_item_id: row.cost_item_id, unit_cogs: row.unit_cogs, ship: row.ship,
          effective_from: row.effective_from,
        });
      } catch (err) {
        if (!(err instanceof CostError)) throw err;
        failed.push({ index: w.index, members: w.members, ref, code: err.code, error: err.message });
      }
    }

    await exec(
      `INSERT INTO lb_cogs_assistant_audit
         (event_id, batch_id, kind, model, source_text, quote_scan_id, proposal,
          applied, skipped, applied_count, rejected_count, skipped_count, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        eventId,
        batch,
        kind === 'quote' ? 'quote' : 'chat',
        String(model || '').slice(0, 64),
        String(sourceText || '').slice(0, 4000),
        quoteScanId ? String(quoteScanId).slice(0, 64) : null,
        // Raw JS values — postgres.js encodes jsonb. A PRE-STRINGIFIED object
        // lands as a jsonb STRING and every later ->> read returns nothing.
        // (Verified by execution: B9 asserts these read back as ARRAYS.)
        proposals,
        applied,
        skipped,
        applied.length,
        failed.length,
        skipped.length,
      String(createdBy || '').slice(0, 128),
      ]
    );
  });

  const [audit] = await pgQuery(
    `SELECT id FROM lb_cogs_assistant_audit WHERE event_id = $1`, [eventId]);

  const parts = [`Applied ${applied.length} change(s)`];
  if (skipped.length) parts.push(`${skipped.length} already up to date`);
  if (failed.length) parts.push(`${failed.length} failed`);

  return {
    event_id: eventId,
    batch_id: batch,
    applied,
    failed,
    skipped,
    applied_count: applied.length,
    failed_count: failed.length,
    skipped_count: skipped.length,
    audit_id: audit ? Number(audit.id) : null,
    summary: parts.join(' · '),
  };
}

// ---------------------------------------------------------------------------
// The quote verifier gate (review M3)
// ---------------------------------------------------------------------------
// Re-run at the APPLY door, over the matrix the SERVER persisted — never over
// anything the client sent. Its blocked set is unioned with the one recorded
// at scan time, so neither a client edit nor a change in the rules between the
// two moments can widen what is applicable.
export function quoteBlockedRows(scan) {
  const blocked = new Map();
  const add = (rowId, rule) => {
    if (!rowId) return;
    const cur = blocked.get(rowId) || [];
    if (!cur.includes(rule)) cur.push(rule);
    blocked.set(rowId, cur);
  };

  const stored = scan && isPlainObject(scan.verify) ? scan.verify : {};
  const rows = Array.isArray(scan?.matrix) ? scan.matrix : [];
  for (const f of Array.isArray(stored.findings) ? stored.findings : []) {
    if (f && f.severity === 'error' && f.row_id) add(f.row_id, f.rule || 'ERROR');
  }
  for (const id of Array.isArray(stored.blocked_row_ids) ? stored.blocked_row_ids : []) {
    add(id, 'BLOCKED_AT_SCAN');
  }
  // The re-run. Document-scope errors (no currency, non-USD, injected header)
  // block every row, exactly as they did at scan time.
  const fresh = verifyMatrix({ header: scan?.header || {}, rows });
  for (const f of fresh.findings) {
    if (f.severity !== 'error') continue;
    if (f.row_id) add(f.row_id, f.rule);
    else for (const r of rows) add(r.row_id, f.rule);
  }
  for (const id of fresh.blocked_row_ids) add(id, 'BLOCKED_ON_REVERIFY');
  return blocked;
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
    `SELECT id, event_id, batch_id, kind, model, source_text, quote_scan_id, proposal,
            applied, skipped, applied_count, rejected_count, skipped_count,
            created_by, created_at
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
