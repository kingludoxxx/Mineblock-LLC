/**
 * briefScore — a brief quality score that actually varies.
 *
 * Every brief ever generated scored 8.4. Not "clustered near" — the same value
 * on all 41 rows in the corpus, because clone mode returned a hardcoded block:
 *
 *   const overall = (7 * 0.15) + (8 * 0.15) + (9 * 0.25) + (8 * 0.15) + (9 * 0.30);
 *
 * novelty always 7, aggression always 8, coherence always 9, verdict always YES.
 * It was introduced as a latency optimisation ("saves 8-20s of blocking") and
 * became permanent, so the operator has been triaging on a constant.
 *
 * This composes a score from signals that genuinely differ between briefs:
 * three already computed by the blend validator and thrown away, and three
 * arithmetic on the finished text. It runs post-insert alongside the blend
 * validation, so it adds nothing to the critical path.
 *
 * DESIGN NOTES (operator decisions, 2026-08-13):
 *  - Proof-stack reuse is REPORTED WITH ZERO WEIGHT. Diversity is a property of
 *    a BATCH, not of one brief: a single script leaning on the whole stack may
 *    well be the best performer, five identical ones is the problem. The
 *    constraint belongs in Autopilot Mode's batch selection, not here. Baking it
 *    into the score would encode an unproven hypothesis into the one number the
 *    operator is meant to trust.
 *  - Weights are CONFIG, not code, so calibration later is a settings change.
 *  - The flags matter more than the number. "7.1" tells you little; "spec hook
 *    in H4, hooks not distinct, 40% shorter than source" tells you what to look
 *    at. The score is for sorting; the flags are for acting.
 *  - If scoring cannot run it records that it did NOT run. It must never fall
 *    back to a plausible-looking constant — that is exactly how 41 briefs went
 *    out unmeasured.
 */

export const DEFAULT_WEIGHTS = {
  hookBlend: 0.20,
  hookDistinctness: 0.20,
  hookIntegrity: 0.25,
  lengthParity: 0.15,
  specificity: 0.20,
  // proofStackReuse intentionally absent — reported, never weighted.
};

// The devices that recur across the Puure corpus. Used ONLY to report reuse.
const PROOF_DEVICES = [
  'collagen', '8mm', 'wavelength', 'scaffold', 'surgeon',
  '$99', '20,000', 'red light', 'three',
];

const clamp10 = n => Math.max(0, Math.min(10, n));
const words = t => String(t || '').trim().split(/\s+/).filter(Boolean);

/**
 * Concrete-detail density. A clone of a direct-response ad should carry hard
 * specifics — a price, an age, a timeframe, a percentage. Vague copy ("expensive",
 * "fast results") is the failure this catches. Counted per 100 words so a long
 * script is not rewarded merely for length.
 */
export function specificityScore(body) {
  const w = words(body);
  if (w.length === 0) return null;
  const text = String(body);
  const hits =
    (text.match(/\$\s?\d[\d,.]*/g) || []).length +          // prices
    (text.match(/\b\d+\s?(%|percent)\b/gi) || []).length +   // percentages
    (text.match(/\b(?:at|i'?m|she'?s|he'?s|was)\s+\d{2}\b/gi) || []).length + // ages
    (text.match(/\b\d+\s+(day|days|week|weeks|month|months|year|years|minute|minutes)\b/gi) || []).length +
    (text.match(/\b\d[\d,]{2,}\b/g) || []).length;           // big round numbers
  const per100 = (hits / w.length) * 100;
  // ~2 concrete details per 100 words reads as a well-specified DR script.
  return clamp10(Math.round((per100 / 2) * 10 * 10) / 10);
}

/**
 * Length parity with the source. Clone mode's whole promise is structural
 * fidelity, and length is the cheapest honest proxy for it: a clone half the
 * length of its source dropped beats.
 */
export function lengthParityScore(bodyLen, sourceLen) {
  if (!bodyLen || !sourceLen) return null;
  const ratio = bodyLen / sourceLen;
  // 1.0 is perfect; score falls away symmetrically in log space so 0.5x and 2x
  // are penalised equally.
  const dev = Math.abs(Math.log(ratio));
  return clamp10(Math.round((10 * Math.exp(-dev * 1.6)) * 10) / 10);
}

/** How many of the recurring devices this script leans on. Reported only. */
export function proofStackReuse(body) {
  const lower = String(body || '').toLowerCase();
  const used = PROOF_DEVICES.filter(d => lower.includes(d));
  return { count: used.length, of: PROOF_DEVICES.length, devices: used };
}

/**
 * Hook integrity from the validator's own findings: spec hooks, hooks claiming
 * something the body never says, and duplicates. These are defects, not tastes,
 * so each costs a fixed amount.
 */
export function hookIntegrityScore({ hookCount = 0, specHooks = 0, unsupported = 0, duplicates = 0 } = {}) {
  if (!hookCount) return null;
  const penalty = (specHooks * 3) + (unsupported * 3) + (duplicates * 2);
  return clamp10(10 - penalty);
}

/**
 * Compose the score. Any component that cannot be computed is EXCLUDED and its
 * weight redistributed across the rest, rather than being defaulted to a
 * flattering value — a missing signal must not silently inflate the result.
 */
export function scoreBrief({ body, sourceText, validator = {}, weights = DEFAULT_WEIGHTS } = {}) {
  if (!body || !String(body).trim()) {
    return { scored: false, reason: 'no body to score', overall: null, components: {}, flags: ['UNSCORED'] };
  }

  const hookCount = Number(validator.hookCount) || 0;
  const components = {
    hookBlend: typeof validator.blendScore === 'number' ? clamp10(validator.blendScore) : null,
    hookDistinctness: typeof validator.distinctness === 'number' ? clamp10(validator.distinctness) : null,
    hookIntegrity: hookIntegrityScore({
      hookCount,
      specHooks: Number(validator.specHooks) || 0,
      unsupported: Number(validator.unsupported) || 0,
      duplicates: Number(validator.duplicates) || 0,
    }),
    lengthParity: lengthParityScore(String(body).length, sourceText ? String(sourceText).length : null),
    specificity: specificityScore(body),
  };

  const present = Object.entries(components).filter(([, v]) => typeof v === 'number');
  if (present.length === 0) {
    return { scored: false, reason: 'no component could be computed', overall: null, components, flags: ['UNSCORED'] };
  }
  const totalWeight = present.reduce((s, [k]) => s + (weights[k] ?? 0), 0);
  if (totalWeight <= 0) {
    return { scored: false, reason: 'all present components have zero weight', overall: null, components, flags: ['UNSCORED'] };
  }
  const overall = present.reduce((s, [k, v]) => s + v * ((weights[k] ?? 0) / totalWeight), 0);

  // Flags — what the operator should actually look at.
  const flags = [];
  if (Number(validator.specHooks) > 0)   flags.push(`SPEC_HOOK x${validator.specHooks}`);
  if (Number(validator.unsupported) > 0) flags.push(`UNSUPPORTED_HOOK x${validator.unsupported}`);
  if (Number(validator.duplicates) > 0)  flags.push(`DUPLICATE_HOOK x${validator.duplicates}`);
  if (components.hookDistinctness !== null && components.hookDistinctness < 7) flags.push('HOOKS_ALIKE');
  if (components.lengthParity !== null && components.lengthParity < 6) {
    const pct = Math.round((String(body).length / String(sourceText).length) * 100);
    flags.push(`LENGTH_${pct}PCT_OF_SOURCE`);
  }
  if (components.specificity !== null && components.specificity < 5) flags.push('LOW_SPECIFICITY');
  if (hookCount && hookCount < 3) flags.push(`ONLY_${hookCount}_HOOKS`);
  if (present.length < Object.keys(components).length) {
    flags.push(`PARTIAL(${present.length}/${Object.keys(components).length})`);
  }

  return {
    scored: true,
    overall: Math.round(overall * 10) / 10,
    components,
    reuse: proofStackReuse(body),   // reported, zero weight — see header
    flags,
    weights,
  };
}
