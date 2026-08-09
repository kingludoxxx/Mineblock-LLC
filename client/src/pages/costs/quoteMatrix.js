// quoteMatrix — pure client model for the assistant's two surfaces (NEW FILE,
// costs lane). No DOM, no network: everything here is a function of the
// server's payload plus the operator's edits, so it is testable on its own.
//
// THREE RULES IT EXISTS TO ENFORCE
//
//  1. A BLANK IS NOT A ZERO. Every editable money field carries a string
//     draft; '' means UNKNOWN and reaches the wire as null. A real $0.00 is
//     only ever produced by the explicit "known free" toggle, exactly like
//     RateDrawer. `parseMoneyDraft` refuses a typed 0 for the same reason.
//  2. A "12,50" IS REFUSED, NOT GUESSED. The two readings are a factor of 100
//     apart. The server refuses it at the door; refusing it here too means the
//     operator finds out while they are still looking at the sheet.
//  3. A ROW THE VERIFY PASS BLOCKED CANNOT BE TICKED. `rowState` folds the
//     server's findings into the row, and the table disables the checkbox —
//     the checkbox is disabled rather than silently ignored, because a
//     disabled box with a reason beside it is the only honest version.
import { EM_DASH, formatCost, variantLabel } from './costTargets';

export const SHIP_KEYS = ['default', 'main', 'upsell', 'addon', 'bump'];
export const CONTEXT_KEYS = ['main', 'upsell', 'addon', 'bump'];

/** Rule names the server can report, with the prose the operator reads. The
 *  server sends a full sentence in `message`; this is the short label. */
export const RULE_LABELS = {
  V3_ARITHMETIC: 'Totals do not add up',
  CURRENCY_SINGLE: 'Currency',
  QTY_BREAK_MONOTONIC: 'Quantity breaks',
  UNIT_COST_MONOTONIC: 'Unit cost direction',
  SHIP_MONOTONIC: 'Shipping direction',
  MODEL_ZERO: 'A zero cost',
  EMPTY_ROW: 'Nothing priced',
  // "Screened", not "quarantined": the check is a keyword tripwire, not a
  // boundary. It is a prompt to read the line, and the label should not
  // promise the operator more than that.
  INJECTION: 'Screened text',
};

export const MATCH_LABELS = {
  exact: 'exact match',
  high: 'likely match',
  low: 'weak match — check it',
  none: 'no match — pick one',
};

/**
 * Parse an operator-typed money field.
 *   ''            → { value: null }  (UNKNOWN — the field was cleared)
 *   '0' / '0.00'  → error `zero_requires_known_free`
 *   '12,50'       → error `ambiguous_decimal_comma`
 *   '1,250.00'    → 1250 (grouped thousands are unambiguous)
 * Mirrors the server's parseMoneyText so the two cannot disagree about what a
 * comma means.
 */
export function parseMoneyDraft(raw, { knownFree = false } = {}) {
  if (knownFree) return { value: 0, error: null };
  const s = raw === null || raw === undefined ? '' : String(raw).trim();
  if (s === '') return { value: null, error: null };
  let t = s.replace(/[$€£¥\s]/g, '');
  if (t.startsWith('-') || /^\(.*\)$/.test(t)) return { value: null, error: 'negative' };
  if (t.includes(',')) {
    if (!/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return { value: null, error: 'ambiguous_decimal_comma' };
    t = t.replace(/,/g, '');
  }
  if (!/^\d+(\.\d+)?$/.test(t)) return { value: null, error: 'not_a_number' };
  const n = Number(t);
  if (!Number.isFinite(n)) return { value: null, error: 'not_a_number' };
  if (n === 0) return { value: null, error: 'zero_requires_known_free' };
  return { value: Math.round(n * 10000) / 10000, error: null };
}

export function moneyDraftError(code) {
  return {
    negative: 'A cost cannot be negative.',
    not_a_number: 'Enter a number, or clear the field to leave it unknown.',
    zero_requires_known_free:
      'Tick "known free" to record a real $0.00 — a blank field means unknown, and the two are not the same downstream.',
    ambiguous_decimal_comma:
      'Write that with a dot decimal. "12,50" could mean 12.50 or 1250, and the two are a factor of 100 apart.',
  }[code] || 'Invalid value.';
}

/** '' for null, otherwise the number as typed. Never '0' for an unknown. */
export const moneyToDraft = (v) => (v === null || v === undefined ? '' : String(v));

// ── findings ───────────────────────────────────────────────────────────────
export const findingsFor = (verify, rowId) =>
  (verify?.findings || []).filter((f) => f.row_id === rowId);

export const documentFindings = (verify) =>
  (verify?.findings || []).filter((f) => f.scope === 'document');

/**
 * One row's verdict. `blocked` is the SERVER's word (it owns the rules); the
 * client never widens it and never narrows it — a client that could overrule
 * the verifier is a client that can apply an unverified cost.
 */
export function rowState(row, verify) {
  const findings = findingsFor(verify, row.row_id);
  const errors = findings.filter((f) => f.severity === 'error');
  const warns = findings.filter((f) => f.severity === 'warn');
  const blocked = Boolean(row.blocked) || errors.length > 0;
  const reasons = [];
  if (blocked) reasons.push(...errors.map((f) => f.message));
  if (!row.variant_id) reasons.push('No catalog variant is chosen for this line.');
  return {
    findings,
    errors,
    warns,
    blocked,
    needsVariant: !row.variant_id,
    selectable: !blocked && Boolean(row.variant_id),
    reasons,
  };
}

// ── the editable draft ─────────────────────────────────────────────────────
/**
 * Server row → editable draft. Extraction values are the SEED, not the truth:
 * the operator can retype any of them, and what gets applied is the draft.
 */
export function toDraft(row) {
  return {
    row_id: row.row_id,
    label: row.label || '',
    supplier_sku: row.supplier_sku || '',
    qty_break: row.qty_break ?? null,
    variant_id: row.variant_id || '',
    match_confidence: row.match_confidence || 'none',
    match_reason: row.match_reason || '',
    match_alternatives: Array.isArray(row.match_alternatives) ? row.match_alternatives : [],
    unit_cost: moneyToDraft(row.unit_cost),
    shipping: moneyToDraft(row.shipping_per_unit),
    unitKnownFree: false,
    shipKnownFree: false,
    // A blank field means UNKNOWN, and the server carries the value already in
    // force rather than erasing it. These two say "no, actually remove it" —
    // the only thing that lets a null overwrite a real cost, and the reason
    // the plan table renders such a row in red.
    clearUnit: false,
    clearShip: false,
    notes: row.notes || '',
    // Extraction facts kept beside the draft so the table can show what the
    // model said next to what the operator changed it to.
    extracted_unit_cost: row.unit_cost ?? null,
    extracted_shipping: row.shipping_per_unit ?? null,
    unit_cost_demoted: Boolean(row.unit_cost_demoted),
    shipping_demoted: Boolean(row.shipping_demoted),
    blocked: Boolean(row.blocked),
    selected: false,
  };
}

export const toDrafts = (rows) => (rows || []).map(toDraft);

/** Has the operator changed a value the model extracted? */
export function isEdited(draft) {
  const u = parseMoneyDraft(draft.unit_cost, { knownFree: draft.unitKnownFree });
  const s = parseMoneyDraft(draft.shipping, { knownFree: draft.shipKnownFree });
  return u.value !== (draft.extracted_unit_cost ?? null)
    || s.value !== (draft.extracted_shipping ?? null);
}

/** Every draft error on the sheet, keyed by row — the Apply button reads it. */
export function draftErrors(drafts) {
  const out = {};
  for (const d of drafts) {
    const u = parseMoneyDraft(d.unit_cost, { knownFree: d.unitKnownFree });
    const s = parseMoneyDraft(d.shipping, { knownFree: d.shipKnownFree });
    const errs = [];
    if (u.error) errs.push({ field: 'unit_cost', code: u.error });
    if (s.error) errs.push({ field: 'shipping', code: s.error });
    if (errs.length) out[d.row_id] = errs;
  }
  return out;
}

/**
 * Draft → wire proposal. `unit_cogs: null` MUST reach the wire as null; this
 * function never coerces it, and the shipping figure is written into
 * `ship.default` (the quote prices one freight number, not a per-context map
 * — the server's contexts resolve through default).
 */
export function draftToProposal(draft, { scanId } = {}) {
  const u = parseMoneyDraft(draft.unit_cost, { knownFree: draft.unitKnownFree });
  const s = parseMoneyDraft(draft.shipping, { knownFree: draft.shipKnownFree });
  const clear = [];
  if (draft.clearUnit) clear.push('unit_cogs');
  if (draft.clearShip) clear.push('ship');
  return {
    scope: 'variant',
    // MANDATORY on a quote apply: it is what the server's re-run of the
    // verifier keys its refusal on. A row the verifier blocked stays blocked
    // however this table feels about it.
    row_id: draft.row_id,
    variant_id: draft.variant_id,
    unit_cogs: u.value,
    ship: { default: s.value },
    explicit_clear: clear,
    currency: 'USD',
    note: [
      scanId ? `quote ${scanId}` : 'quote scan',
      draft.label ? `"${String(draft.label).slice(0, 80)}"` : '',
      draft.qty_break ? `qty ${draft.qty_break}` : '',
      isEdited(draft) ? 'operator-edited' : '',
    ].filter(Boolean).join(' · ').slice(0, 500),
  };
}

/** The rows the operator ticked, in document order, as wire proposals. */
export function selectedProposals(drafts, { scanId } = {}) {
  return drafts.filter((d) => d.selected).map((d) => draftToProposal(d, { scanId }));
}

/**
 * The confirm table. "Apply 12 proposals?" is not a confirm — this spells out
 * every rate row that will be written, with the variant it lands on and what
 * happens to each field.
 *
 * THREE OUTCOMES PER FIELD, and the table must not blur them:
 *   set     — a value is being written
 *   kept    — the field is blank, so the value already in force is CARRIED
 *             onto the new row (a rate row replaces, it does not patch)
 *   cleared — the operator ticked "remove", so a null IS written and the
 *             field becomes unknown. Rendered red, because clearing a cost
 *             withholds profit for every leg that used it.
 */
export function fieldOutcome({ value, cleared, current }) {
  if (cleared && current !== null && current !== undefined) return 'cleared';
  if (value !== null && value !== undefined) return 'set';
  if (current !== null && current !== undefined) return 'kept';
  return 'unknown';
}

export function applyPlan(drafts, catalogById, { scanId } = {}) {
  return drafts.filter((d) => d.selected).map((d) => {
    const entry = catalogById?.get?.(d.variant_id) || null;
    const u = parseMoneyDraft(d.unit_cost, { knownFree: d.unitKnownFree });
    const s = parseMoneyDraft(d.shipping, { knownFree: d.shipKnownFree });
    const currentCogs = entry ? entry.unit_cogs ?? null : null;
    const currentShip = entry ? (entry.ship?.default ?? entry.ship?.main ?? null) : null;
    const cogsOutcome = fieldOutcome({ value: u.value, cleared: d.clearUnit, current: currentCogs });
    const shipOutcome = fieldOutcome({ value: s.value, cleared: d.clearShip, current: currentShip });
    return {
      row_id: d.row_id,
      variant_id: d.variant_id,
      label: entry ? variantLabel(entry) : d.variant_id || EM_DASH,
      quote_label: d.label,
      qty_break: d.qty_break,
      unit_cogs: u.value,
      unit_text: formatCost(u.value).text,
      ship: s.value,
      ship_text: formatCost(s.value).text,
      current_unit_cogs: currentCogs,
      current_ship: currentShip,
      cogs_outcome: cogsOutcome,
      ship_outcome: shipOutcome,
      destructive: cogsOutcome === 'cleared' || shipOutcome === 'cleared',
      edited: isEdited(d),
      note: draftToProposal(d, { scanId }).note,
    };
  });
}

/**
 * The same plan, built from CHAT proposals so the Apply-all confirm reads
 * identically to the quote one (review M10). The server has already run
 * carry-forward on these, so `carried_cogs` / `carried_ship` tell us a field
 * was kept rather than set, without re-deriving it here.
 */
export function chatApplyPlan(proposals) {
  return proposals.map((p) => {
    const currentShip = p.current_ship?.default ?? p.current_ship?.main ?? null;
    const nextShip = p.ship?.default ?? p.ship?.main ?? null;
    return {
      row_id: p.variant_id || p.cost_item_id,
      variant_id: p.variant_id,
      label: [p.product_title, p.variant_title].filter(Boolean).join(' — ')
        || p.variant_id || p.cost_item_id || EM_DASH,
      quote_label: p.reason || '',
      qty_break: null,
      unit_cogs: p.unit_cogs,
      unit_text: formatCost(p.unit_cogs).text,
      ship: nextShip,
      ship_text: formatCost(nextShip).text,
      current_unit_cogs: p.current_unit_cogs ?? null,
      current_ship: currentShip,
      cogs_outcome: p.clears_cogs ? 'cleared' : p.carried_cogs ? 'kept'
        : (p.unit_cogs === null ? 'unknown' : 'set'),
      ship_outcome: p.clears_ship ? 'cleared' : (p.carried_ship || []).length ? 'kept'
        : (nextShip === null ? 'unknown' : 'set'),
      destructive: Boolean(p.clears_cogs || p.clears_ship),
      edited: false,
      note: p.note || '',
    };
  });
}

// ── chat proposals ─────────────────────────────────────────────────────────
/**
 * A chat proposal → the narrower object the apply door accepts. Display
 * fields (`product_title`, `current_unit_cogs`, `no_change`, …) are
 * DELIBERATELY not sent: the server rebuilds them from its own catalog, so a
 * stale display value on a browser tab left open overnight can never become
 * part of a write.
 *
 * `effective_from` is omitted unless the model pinned one — the server dates
 * it correctly, and a client-supplied "today" would stop a first cost from
 * backdating to first sale (which is what keeps historical margins honest).
 */
export function chatProposalToWire(p) {
  const out = {
    scope: p.scope || 'variant',
    variant_id: p.variant_id || null,
    cost_item_id: p.cost_item_id || null,
    unit_cogs: p.unit_cogs === undefined ? null : p.unit_cogs,
    ship: p.ship || {},
    // A real boolean: the server refuses a truthy string rather than reading
    // "no" as yes and quietly losing a backdate.
    only_from_today: p.only_from_today === true,
    explicit_clear: Array.isArray(p.explicit_clear) ? p.explicit_clear : [],
    currency: 'USD',
    note: String(p.note || '').slice(0, 500),
    reason: String(p.reason || '').slice(0, 300),
  };
  if (p.effective_from) out.effective_from = p.effective_from;
  return out;
}

/** What changes if this proposal is applied — before → after, per field. */
export function proposalChanges(p) {
  const rows = [];
  const before = p.current_unit_cogs ?? null;
  if (before !== p.unit_cogs) {
    rows.push({ field: 'COGS', before: formatCost(before).text, after: formatCost(p.unit_cogs).text });
  }
  const cur = p.current_ship || {};
  const next = p.ship || {};
  const shipOf = (m, ctx) => {
    const v = m[ctx];
    if (v !== null && v !== undefined) return Number(v);
    const d = m.default;
    return d === null || d === undefined ? null : Number(d);
  };
  const allSame = CONTEXT_KEYS.every((c) => shipOf(next, c) === shipOf(next, 'main'));
  if (allSame) {
    const b = shipOf(cur, 'main');
    const a = shipOf(next, 'main');
    if (b !== a) rows.push({ field: 'Shipping (all legs)', before: formatCost(b).text, after: formatCost(a).text });
  } else {
    for (const c of CONTEXT_KEYS) {
      const b = shipOf(cur, c);
      const a = shipOf(next, c);
      if (b !== a) rows.push({ field: `Shipping (${c})`, before: formatCost(b).text, after: formatCost(a).text });
    }
  }
  return rows;
}

export const confidenceText = (c) => (
  c === null || c === undefined ? 'no stated confidence' : `${Math.round(Number(c) * 100)}% confident`
);
