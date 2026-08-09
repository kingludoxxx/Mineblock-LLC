// QUOTE VERIFY — the sanity pass over an extracted supplier-quote matrix.
//
// A PORT, not a rewrite, of funnel-os backend/app/services/lb_quote_verify.py
// (2743 L), narrowed to the matrix shape this lane extracts. The reference
// verifies a THREE-BAND TIER GRID (blocks × destination countries × quantity
// columns, with parallel product/shipping/total arrays); this lane extracts a
// FLAT ROW LIST (label, qty_break, unit_cost, shipping_per_unit, line_total).
// Rules that exist only to police the grid's geometry have no referent here
// and are dropped ON PURPOSE, listed by name below so the omission is a
// decision on the record rather than an oversight.
//
// ══ PORTED ═══════════════════════════════════════════════════════════════
//  V3_ARITHMETIC        totals consistency. Per row: unit_cost × qty_break vs
//                       the printed line_total. Per document: Σ line_total vs
//                       header.subtotal, and subtotal + shipping_total vs
//                       grand_total. Tolerance 0.02 (+1e-9 float slack) and
//                       the reference's sign convention, delta = expected −
//                       printed. Severity: error (it is one of the two HARD
//                       rules upstream — the only kind that can VERIFY a cell).
//  CURRENCY_SINGLE      the reference's one currency rule, plus the
//                       single-valued half. header.currency must be a 3-letter
//                       code and every row must carry it. Non-USD fails CLOSED
//                       (the cost engine books USD and performs no FX —
//                       funnelCosts.appendRate refuses it at the write door
//                       too, so this is the early, explainable refusal).
//  QTY_BREAK_MONOTONIC  ported from V7_TIER_SHAPE's S1 (tiers strictly
//                       increasing) and S9 (duplicate rows), applied per label
//                       group: quantity breaks must strictly increase and may
//                       not repeat. Severity: error — a repeated or inverted
//                       break means the reader mis-assigned a price to a tier.
//  UNIT_COST_MONOTONIC  adapted from V2_LINEARITY. The reference DERIVES a
//                       unit from extended totals and checks linearity; our
//                       rows print the unit directly, so the meaningful
//                       residual is direction: a unit cost that RISES with
//                       quantity is a volume discount running backwards.
//                       One-sided slack 0.005, raw compare, no epsilon —
//                       exactly how the reference treats MONOTONIC_SLACK.
//                       Severity: warn (a supplier may legitimately price up).
//  SHIP_MONOTONIC       V4_SHIP_MONOTONIC, direction flipped for our units.
//                       Upstream the shipping cell is an EXTENDED figure that
//                       must not FALL as quantity rises; ours is PER UNIT, so
//                       it must not RISE. Same 0.005 one-sided slack, same
//                       advisory grade, same "worth a look, not a rejection".
//  MODEL_ZERO           the numeric-zero invariant from the extractor's
//                       _parse_cell: a cost that arrives as the number 0 is
//                       demoted to null and flagged, never taken as free. A
//                       zero cost cannot be taken on a model's word. This is
//                       null-vs-0 reaching the extraction boundary.
//  EMPTY_ROW            V6's honesty grade, collapsed: a row that prices
//                       nothing (no unit_cost and no shipping_per_unit)
//                       proposes nothing. Severity: warn, row blocked.
//  INJECTION            V10_INJECTION. Instruction-shaped text in a label,
//                       supplier name or note is QUARANTINED: it is displayed
//                       as data and the row proposes nothing. Severity: error
//                       for the affected row.
//
// ══ DROPPED (and why) ════════════════════════════════════════════════════
//  V1_SEPARATOR         the reference votes on printed GLYPHS ("2,56" vs
//     (evidence vote)   "2.56") because its extractor demands strings. Our
//                       tool schema demands JSON numbers, so there are no
//                       glyph tokens to vote on and detect_separator would
//                       count zero evidence on every document. CONSEQUENCE,
//                       STATED: the decimal-separator decision is made inside
//                       the model where we cannot audit it. Mitigated only by
//                       V3_ARITHMETIC — a comma/dot mix-up is a 100× error and
//                       a 100× error does not reconcile against a printed
//                       total. Re-introducing the glyph channel is the single
//                       highest-value follow-up on this file.
//  _contested_recheck   depends on the glyph channel above.
//  V2_LINEARITY         (leave-one-out unit derivation, _loo_tolerance,
//                       MIN_LINEARITY_POINTS, max_residual) — requires a row
//                       of EXTENDED totals across ≥3 quantity columns to
//                       derive a unit from. Our rows print the unit.
//  V5_BLANK             declared in the reference's RULES enum and never
//                       emitted by it either. Its semantics live in the
//                       blank-vs-unreadable split, which we keep (a null
//                       unit_cost and a 0 unit_cost are different values all
//                       the way through).
//  V6_NO_TOTAL buckets  (no_total_column / tier_skipped_by_total /
//                       structure_unknown) — three ways of saying "nothing
//                       cross-checks this shipping cell", counted separately
//                       upstream because the grid can fail three ways. Ours
//                       collapses to the single `no_cross_check` note on
//                       V3_ARITHMETIC's unavailable outcome.
//  V7 sub-codes S1–S8   array-length parity between tiers/ship_tiers/
//                       total_tiers and each row's three cell arrays. There
//                       are no parallel arrays in a flat row list to
//                       mis-align. S1's strictly-increasing half and S9's
//                       duplicate half ARE ported, as QTY_BREAK_MONOTONIC.
//  V8_SUPPLIER_PARITY   compare product costs across supplier-split rows of
//  V9_COUNTRY_PARITY    the same country / across countries. This lane has no
//                       country dimension (the cost model is single-
//                       destination) and no supplier split inside one quote.
//  pack/tier mapping    parse_pack_size, tier_for_variant, supplier_unit_hint,
//                       suggest_products — replaced by cogsAssistant's own
//                       matcher, whose every result the operator confirms.
//  adapter rules        csv/xlsx/pdf precheck, mixed_adapters,
//                       xlsx_formula_values_missing,
//                       xlsx_mixed_number_conventions — this lane accepts
//                       images and PDF only.
//  agreement passes     the reference reads every block TWICE with two
//                       deliberately different scan strategies and demotes on
//                       disagreement. One pass here. CONSEQUENCE: no
//                       agreement-based demotion; nothing else changes.
//  date rules           none exist upstream to port (no quote expiry, no
//                       staleness window). Any such rule here would be net
//                       new, not a port.

// ── shared error type ─────────────────────────────────────────────────────
// Carries an operator-actionable .code. `detail` is for the SERVER LOG only —
// the route never puts it on the wire, because an upstream SDK error message
// can echo request context including the provider key (the reference makes
// the same call and states the same reason).
export class ExtractError extends Error {
  constructor(code, message = '', detail = '') {
    super(message || code);
    this.code = code;
    this.detail = detail;
  }
}

// ── constants (values carried over verbatim from the reference) ───────────
export const TOLERANCE = 0.02;          // absolute residual bound (V3)
export const TOLERANCE_EPSILON = 1e-9;  // float slack on every residual compare
export const MONOTONIC_SLACK = 0.005;   // one-sided, NOT routed through _within
export const BASE_CURRENCY = 'USD';

export const SEVERITIES = Object.freeze(['error', 'warn']);
export const RULES = Object.freeze([
  'V3_ARITHMETIC', 'CURRENCY_SINGLE', 'QTY_BREAK_MONOTONIC',
  'UNIT_COST_MONOTONIC', 'SHIP_MONOTONIC', 'MODEL_ZERO', 'EMPTY_ROW', 'INJECTION',
]);

// abs(delta) <= tol + epsilon; false for NaN/Infinity/uncastable — the
// reference's _within, including its refusal to pass a non-finite residual.
export function within(delta, tol = TOLERANCE) {
  const d = Number(delta);
  if (!Number.isFinite(d)) return false;
  return Math.abs(d) <= tol + TOLERANCE_EPSILON;
}

const isNum = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
const n2 = (v) => Math.round(Number(v) * 100) / 100;

// ── injection quarantine (V10) ────────────────────────────────────────────
// Text on a supplier's document is DATA. A line that reads like an
// instruction is transcribed, flagged, and its row proposes nothing.
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous\s+|prior\s+)?instructions?/i,
  /disregard\s+(the\s+|all\s+|your\s+)?\w*\s*(instructions?|rules?|above)/i,
  /set\s+(every|all|each)\b.{0,40}?\bto\b/i,
  /apply\s+(all|every)\b/i,
  /you\s+are\s+now\b/i,
  /^\s*system\s*:/im,
  /<\|.{0,40}?\|>/,
];

export function sanitizeText(value, maxLen = 300) {
  let s = String(value == null ? '' : value)
    // control chars, zero-width and bidi overrides (trojan-source) -> space.
    // Written with EXPLICIT escapes: a literal control character inside a
    // character class is invisible in a diff, and one stray hyphen between
    // two of them becomes a range that eats the printable ASCII this rule
    // exists to protect.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > maxLen) s = `${s.slice(0, maxLen - 1)}…`;
  return s;
}

export function scanInjection(value) {
  const s = String(value == null ? '' : value);
  const hits = [];
  for (const re of INJECTION_PATTERNS) {
    const m = re.exec(s);
    if (m && m[0]) {
      const frag = sanitizeText(m[0], 120);
      if (frag && !hits.includes(frag)) hits.push(frag);
    }
  }
  return hits;
}

// ── money parsing for OPERATOR TEXT (the assistant path) ──────────────────
// Ported from the reference's _money. The load-bearing clause is the comma:
// a grouped-thousands string ("1,250.00") is de-grouped, and the
// decimal-comma form ("12,50") is REFUSED rather than stripped — stripping
// turns 12,50 into 1250, a 100× error, silently.
export class MoneyError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

export function parseMoneyText(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') throw new MoneyError('bad_amount', 'a boolean is not an amount');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new MoneyError('bad_amount', 'amount is not a finite number');
    if (value < 0) throw new MoneyError('negative_money', 'an amount reads as negative');
    return Math.round(value * 10000) / 10000;
  }
  let s = String(value)
    .replace(/[−–—]/g, '-')
    // Currency marks, every unicode space \s covers, plus the word joiner
    // (U+2060) and typographic apostrophes, which \s does not.
    .replace(/[\u0024\u00a2-\u00a5\u20a0-\u20bf\s\u2060'\u2019]/g, '')
    .trim();
  if (!s) return null;
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('-') || /^\(.*\)$/.test(s)) {
    throw new MoneyError('negative_money', `"${value}" reads as a negative cost`);
  }
  if (s.includes(',')) {
    if (!/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) {
      throw new MoneyError(
        'ambiguous_decimal_comma',
        `"${value}" could mean ${s.replace(',', '.')} or ${s.replace(',', '')} — write it with a dot decimal`
      );
    }
    s = s.replace(/,/g, '');
  }
  if (!/^\d+(\.\d+)?$/.test(s)) throw new MoneyError('bad_amount', `"${value}" is not a number`);
  const f = Number(s);
  if (!Number.isFinite(f)) throw new MoneyError('bad_amount', `"${value}" is not a finite number`);
  return Math.round(f * 10000) / 10000;
}

// ── the verify pass ───────────────────────────────────────────────────────
// PURE. Takes { header, rows } and returns findings + the rows it blocked.
// It never mutates the input and never invents a value: a rule that cannot
// run reports `unavailable`, it does not pass.
//
// Returns:
//   { ok, findings:[{rule, severity, scope, row_id, message, delta?, expected?}],
//     counts:{error,warn}, blocked_row_ids:[], currency, applicable_rows }
export function verifyMatrix(input) {
  const header = (input && input.header) || {};
  const rows = Array.isArray(input && input.rows) ? input.rows : [];
  const findings = [];
  const blocked = new Set();

  const add = (rule, severity, scope, rowId, message, extra = {}) => {
    findings.push({
      rule, severity, scope,
      row_id: rowId || null,
      message: sanitizeText(message, 300),
      ...(extra.delta === undefined ? {} : { delta: Math.round(extra.delta * 10000) / 10000 }),
      ...(extra.expected === undefined ? {} : { expected: Math.round(extra.expected * 10000) / 10000 }),
    });
    if (severity === 'error' && rowId) blocked.add(rowId);
  };

  // ═══ CURRENCY_SINGLE ════════════════════════════════════════════════════
  const currency = String(header.currency || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    add('CURRENCY_SINGLE', 'error', 'document', null,
      'This document does not state a currency. Every cost on it is unusable until you say which currency it is in — the engine books USD and performs no conversion.');
    for (const r of rows) blocked.add(r.row_id);
  } else {
    for (const r of rows) {
      const rc = String(r.currency || '').toUpperCase();
      if (rc && rc !== currency) {
        add('CURRENCY_SINGLE', 'error', 'row', r.row_id,
          `Row "${r.label}" is priced in ${rc} but the document header says ${currency}. A quote with two currencies cannot be read as one cost matrix.`);
      }
    }
    if (currency !== BASE_CURRENCY) {
      add('CURRENCY_SINGLE', 'error', 'document', null,
        `This sheet is quoted in ${currency}. The cost engine books ${BASE_CURRENCY} only and performs no conversion, so nothing can be applied from it.`);
      for (const r of rows) blocked.add(r.row_id);
    }
  }

  // ═══ INJECTION (V10) ════════════════════════════════════════════════════
  for (const field of ['supplier', 'quote_ref', 'incoterm']) {
    const hits = scanInjection(header[field]);
    if (hits.length) {
      add('INJECTION', 'error', 'document', null,
        `The document header contains text that reads like an instruction ("${hits[0]}"). It is data and was not acted on; nothing can be applied from this scan until you review it.`);
      for (const r of rows) blocked.add(r.row_id);
    }
  }
  for (const r of rows) {
    const hits = [...scanInjection(r.label), ...scanInjection(r.notes), ...scanInjection(r.supplier_sku)];
    if (hits.length) {
      add('INJECTION', 'error', 'row', r.row_id,
        `Row "${sanitizeText(r.label, 80)}" carries instruction-like text ("${hits[0]}"). It is quarantined and proposes nothing.`);
    }
  }

  // ═══ MODEL_ZERO ═════════════════════════════════════════════════════════
  // A zero cost cannot be taken on a model's word. The caller demotes the
  // value to null on the strength of this finding — never to "known free".
  for (const r of rows) {
    if (Number(r.unit_cost) === 0 && r.unit_cost !== null && r.unit_cost !== undefined) {
      add('MODEL_ZERO', 'warn', 'row', r.row_id,
        `Row "${sanitizeText(r.label, 80)}" came back with a unit cost of exactly 0. A zero cost is recorded as UNKNOWN, not as free — check it against the sheet and enter it by hand if the goods really are free.`);
    }
    if (Number(r.shipping_per_unit) === 0 && r.shipping_per_unit !== null && r.shipping_per_unit !== undefined) {
      add('MODEL_ZERO', 'warn', 'row', r.row_id,
        `Row "${sanitizeText(r.label, 80)}" came back with shipping of exactly 0. Recorded as UNKNOWN, not as free shipping.`);
    }
  }

  // ═══ EMPTY_ROW ══════════════════════════════════════════════════════════
  for (const r of rows) {
    if (!isNum(r.unit_cost) && !isNum(r.shipping_per_unit)) {
      add('EMPTY_ROW', 'warn', 'row', r.row_id,
        `Row "${sanitizeText(r.label, 80)}" prices nothing that was readable — no unit cost and no shipping. It proposes nothing.`);
      blocked.add(r.row_id);
    }
  }

  // ═══ V3_ARITHMETIC — per row ════════════════════════════════════════════
  // expected = unit_cost × qty_break ; delta = expected − printed line_total.
  for (const r of rows) {
    if (!isNum(r.line_total)) continue; // unavailable: nothing to add up against
    if (!isNum(r.unit_cost) || !isNum(r.qty_break)) continue;
    const expected = Number(r.unit_cost) * Number(r.qty_break);
    const delta = expected - Number(r.line_total);
    if (!within(delta)) {
      add('V3_ARITHMETIC', 'error', 'row', r.row_id,
        `Row "${sanitizeText(r.label, 80)}": ${Number(r.unit_cost)} × ${Number(r.qty_break)} = ${n2(expected)}, but the printed line total is ${n2(r.line_total)} (off by ${n2(Math.abs(delta))}). One of the three is misread.`,
        { delta, expected });
    }
  }

  // ═══ V3_ARITHMETIC — document ═══════════════════════════════════════════
  const lineTotals = rows.filter((r) => isNum(r.line_total)).map((r) => Number(r.line_total));
  if (isNum(header.subtotal) && lineTotals.length) {
    const expected = lineTotals.reduce((a, b) => a + b, 0);
    const delta = expected - Number(header.subtotal);
    if (!within(delta)) {
      add('V3_ARITHMETIC', 'error', 'document', null,
        `The line totals add up to ${n2(expected)} but the printed subtotal is ${n2(header.subtotal)} (off by ${n2(Math.abs(delta))}). A line was misread or one is missing.`,
        { delta, expected });
    }
  }
  if (isNum(header.grand_total) && isNum(header.subtotal)) {
    const ship = isNum(header.shipping_total) ? Number(header.shipping_total) : 0;
    const expected = Number(header.subtotal) + ship;
    const delta = expected - Number(header.grand_total);
    if (!within(delta)) {
      add('V3_ARITHMETIC', 'error', 'document', null,
        `Subtotal ${n2(header.subtotal)}${isNum(header.shipping_total) ? ` + shipping ${n2(header.shipping_total)}` : ''} = ${n2(expected)}, but the printed grand total is ${n2(header.grand_total)} (off by ${n2(Math.abs(delta))}).`,
        { delta, expected });
    }
  }

  // ═══ per-label groups: QTY_BREAK_MONOTONIC / UNIT_COST / SHIP ═══════════
  // Grouped on the normalized label, because a tiered quote prints one label
  // and several quantity rows under it. Rows keep their DOCUMENT ORDER inside
  // a group — the order the sheet prints is the order the checks read, so an
  // inverted break is reported rather than sorted away.
  const groups = new Map();
  for (const r of rows) {
    const key = String(r.label || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() || `#${r.row_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  for (const [, grp] of groups) {
    if (grp.length < 2) continue;

    // QTY_BREAK_MONOTONIC — strictly increasing (S1) and no repeats (S9).
    let prevQty = null;
    let prevRow = null;
    for (const r of grp) {
      if (!isNum(r.qty_break)) continue;
      const q = Number(r.qty_break);
      if (prevQty !== null) {
        if (q === prevQty) {
          add('QTY_BREAK_MONOTONIC', 'error', 'row', r.row_id,
            `Two rows of "${sanitizeText(r.label, 80)}" both quote quantity ${q}. One of them belongs to a different break — the tier a price sits under cannot be guessed.`);
        } else if (q < prevQty) {
          add('QTY_BREAK_MONOTONIC', 'error', 'row', r.row_id,
            `Quantity breaks for "${sanitizeText(r.label, 80)}" go ${prevQty} then ${q} — they are not increasing, so a price has been read against the wrong tier.`);
        }
      }
      prevQty = q;
      prevRow = r;
    }
    void prevRow;

    // UNIT_COST_MONOTONIC — a unit cost that RISES with quantity. Advisory.
    let lastUnit = null;
    let lastUnitQty = null;
    for (const r of grp) {
      if (!isNum(r.unit_cost) || !isNum(r.qty_break)) continue;
      const v = Number(r.unit_cost);
      const q = Number(r.qty_break);
      if (lastUnit !== null && q > lastUnitQty) {
        const delta = v - lastUnit;
        if (delta > MONOTONIC_SLACK) {
          add('UNIT_COST_MONOTONIC', 'warn', 'row', r.row_id,
            `Unit cost for "${sanitizeText(r.label, 80)}" RISES from ${n2(lastUnit)} at qty ${lastUnitQty} to ${n2(v)} at qty ${q} — a volume discount running backwards. Worth a look, not a rejection.`,
            { delta });
        }
      }
      lastUnit = v;
      lastUnitQty = q;
    }

    // SHIP_MONOTONIC — per-unit freight that RISES with quantity. Advisory.
    let lastShip = null;
    let lastShipQty = null;
    for (const r of grp) {
      if (!isNum(r.shipping_per_unit) || !isNum(r.qty_break)) continue;
      const v = Number(r.shipping_per_unit);
      const q = Number(r.qty_break);
      if (lastShip !== null && q > lastShipQty) {
        const delta = v - lastShip;
        if (delta > MONOTONIC_SLACK) {
          add('SHIP_MONOTONIC', 'warn', 'row', r.row_id,
            `Per-unit shipping for "${sanitizeText(r.label, 80)}" rises from ${n2(lastShip)} at qty ${lastShipQty} to ${n2(v)} at qty ${q} — worth a look, not a rejection.`,
            { delta });
        }
      }
      lastShip = v;
      lastShipQty = q;
    }
  }

  const counts = {
    error: findings.filter((f) => f.severity === 'error').length,
    warn: findings.filter((f) => f.severity === 'warn').length,
  };
  return {
    ok: counts.error === 0,
    findings,
    counts,
    currency,
    blocked_row_ids: [...blocked].filter(Boolean),
    applicable_rows: rows.filter((r) => !blocked.has(r.row_id)).length,
  };
}

// Apply the MODEL_ZERO demotion to a matrix: an exact 0 that the model
// reported becomes null (unknown). Pure — returns new rows. Called by the
// route AFTER verifyMatrix, so the finding is still reported to the operator.
export function demoteModelZeros(rows) {
  return (rows || []).map((r) => {
    const out = { ...r };
    if (out.unit_cost !== null && out.unit_cost !== undefined && Number(out.unit_cost) === 0) {
      out.unit_cost = null;
      out.unit_cost_demoted = true;
    }
    if (out.shipping_per_unit !== null && out.shipping_per_unit !== undefined && Number(out.shipping_per_unit) === 0) {
      out.shipping_per_unit = null;
      out.shipping_demoted = true;
    }
    return out;
  });
}

export default { verifyMatrix, demoteModelZeros, parseMoneyText, scanInjection, within, ExtractError };
