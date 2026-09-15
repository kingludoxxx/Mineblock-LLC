// PRODUCT PACK COPY GUARD: a check on adapted_text before the image is rendered, for products with an approved
// product pack only (product._bible.copy.curated). Everything else passes through untouched.
//
// Found live 2026-09-16 (Test 1): a promo reference with a "$69 struck through, $32" sticker and 3 icon bullets came
// back with a spec bullet ("3 INTENSITY LEVELS FOR YOUR COMFORT"), a tired phrase the pack bans ("NO MASK + NO HOSE"),
// and the image model drew OUR $149 struck through. The prompt rules say all of this; this module makes it checkable:
//   (a) banned claims + tired words of the pack core and the chosen angle's banned phrases (phrase match)
//   (b) at least one of the chosen angle's required elements is reflected, and no bullet is a bare spec line
//       (judged by a small model: the elements are ideas like "One program-urgency line", which no keyword list
//       can recognise, and a spec bullet is a judgement too)
//   (c) our own price described as struck through or as an old price
// On a failure the analysis model is asked ONCE to rewrite adapted_text only. Never a loop.
// Nothing here names a product, market, store or brand (R15).

const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);
const TEXT_SCALARS = ['headline', 'subheadline', 'body', 'cta'];
const TEXT_ARRAYS = ['bullets', 'badges'];

// ── Bans ─────────────────────────────────────────────────────────────────────

function splitItems(line) {
  const out = []; let cur = ''; let quoted = false;
  for (const ch of line) {
    if (ch === '"' || ch === '\u201C' || ch === '\u201D') { quoted = !quoted; cur += '"'; continue; }
    if (!quoted && (ch === ';' || ch === ',')) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Literal phrases from one ban item: quoted text is literal; "FDA approved or cleared" gives both forms. */
function phrasesOf(item) {
  const quoted = [...item.matchAll(/"([^"]+)"/g)].map((m) => m[1].trim()).filter(Boolean);
  if (quoted.length) return quoted;
  const bare = item.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim();
  if (!bare) return [];
  const or = bare.match(/^(.+)\s+or\s+(\S+)$/i);
  if (or && or[1].split(' ').length >= 2) {
    const head = or[1].split(' ');
    return [or[1], [...head.slice(0, -1), or[2]].join(' ')];
  }
  return [bare];
}

/** Parse a pack core's "WHAT WE NEVER SAY" block into literal phrases. Lines "Tired...: a, b" go to `tired`. */
export function parseNeverSay(core) {
  const out = { claims: [], tired: [], emDashBanned: false };
  if (typeof core !== 'string') return out;
  const lines = core.split('\n');
  const at = lines.findIndex((l) => /^\s*WHAT WE NEVER SAY\s*$/i.test(l));
  if (at < 0) return out;
  for (const line of lines.slice(at + 1)) {
    if (!line.trim() || /^[A-Z][A-Z0-9 ()/&,'-]+$/.test(line.trim())) break;
    const m = line.match(/^\s*([^:]{1,60}):\s*(.+)$/);
    if (!m) continue;
    const bucket = /tired/i.test(m[1]) ? out.tired : out.claims;
    for (const item of splitItems(m[2])) {
      if (/^em[\s-]?dash(es)?\.?$/i.test(item)) { out.emDashBanned = true; continue; }
      for (const p of phrasesOf(item)) if (!bucket.includes(p)) bucket.push(p);
    }
  }
  return out;
}

/** The rules the check reads, from an approved pack { core, angles, banned_phrases? }. */
export function packCopyRules({ core = '', angles = [], banned_phrases = [] } = {}) {
  const parsed = parseNeverSay(core);
  return {
    claims: [...parsed.claims, ...list(banned_phrases).filter((p) => !parsed.claims.includes(p))],
    tired: parsed.tired,
    emDashBanned: parsed.emDashBanned,
    angles: (Array.isArray(angles) ? angles : []).filter((a) => a && a.name).map((a) => ({
      name: String(a.name),
      required_elements: list(a.required_elements),
      banned_phrases: list(a.banned_phrases).flatMap(phrasesOf),
      copy_directives: typeof a.copy_directives === 'string' ? a.copy_directives : '',
    })),
  };
}

const key = (s) => String(s || '').trim().toLowerCase();

/** The angle the copy was written for: the operator's pick, else the model's chosen_angle in AUTO. Null when unknown. */
export function resolveCheckedAngle(claudeResult, bible) {
  const angles = bible?.copyRules?.angles || [];
  const picked = bible?.angleDef?.name;
  const name = picked && picked !== 'AUTO' ? picked : claudeResult?.chosen_angle;
  if (!name) return null;
  return angles.find((a) => key(a.name) === key(name)) || null;
}

const norm = (s) => ` ${String(s || '').toLowerCase().replace(/%/g, ' % ').replace(/[^a-z0-9%]+/g, ' ').trim()} `;

function textFields(adapted) {
  const out = [];
  if (!adapted || typeof adapted !== 'object') return out;
  for (const f of TEXT_SCALARS) if (typeof adapted[f] === 'string' && adapted[f].trim()) out.push([f, adapted[f]]);
  for (const f of TEXT_ARRAYS) (Array.isArray(adapted[f]) ? adapted[f] : []).forEach((v, i) => { if (typeof v === 'string' && v.trim()) out.push([`${f}[${i}]`, v]); });
  return out;
}

/** Banned claims, tired words and the angle's banned phrases found in adapted_text: [{ field, phrase, source }]. */
export function findBannedPhrases(adapted, rules, angle) {
  const phrases = [];
  const seen = new Set();
  const add = (p, source) => { const n = norm(p); if (n.trim() && !seen.has(n)) { seen.add(n); phrases.push({ p, n, source }); } };
  for (const p of rules?.claims || []) add(p, 'banned claim');
  for (const p of rules?.tired || []) add(p, 'tired words');
  for (const p of angle?.banned_phrases || []) add(p, 'angle banned phrase');
  const hits = [];
  for (const [field, text] of textFields(adapted)) {
    if (rules?.emDashBanned && text.includes('\u2014')) hits.push({ field, phrase: 'em dash', source: 'banned claim' });
    const hay = norm(text);
    for (const { p, n, source } of phrases) if (hay.includes(n)) hits.push({ field, phrase: p, source });
  }
  return hits;
}

// ── Our price, never struck ─────────────────────────────────────────────────

const amountsIn = (s) => [...String(s || '').matchAll(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g)].map((m) => Number(m[1].replace(/,/g, '')));
const WAS_WORD = String.raw`(?:was|reg\.?|regular(?:ly)?(?:\s+price)?|originally|original\s+price|compare\s+at|msrp|list\s+price|retail(?:\s+price)?)`;
const STRIKE_CHARS = /[\u0335\u0336\u0338]/g;
const STRIKE_TEST = /[\u0335\u0336\u0338]/;

function ownPriceOf(offer) { return amountsIn(offer?.price)[0]; }

/**
 * Deterministic part of fix 1: strike markup and "was" words attached to OUR price are removed from adapted_text.
 * Only product-pack/bible products; a price that is not ours is left for the check to flag.
 */
export function enforceOwnPriceNotStruck(claudeResult = {}, product = {}) {
  const report = { changed: [] };
  const adapted = claudeResult?.adapted_text;
  const own = ownPriceOf(product?._bible?.offer) ?? amountsIn(product?._bible?.copy?.market?.price)[0];
  if (!product?._bible || !adapted || typeof adapted !== 'object' || own === undefined) return { result: claudeResult, report };
  const price = String.raw`\$\s?${String(own).replace('.', '\\.')}(?![\d.,]\d)`;
  const fix = (v) => {
    if (typeof v !== 'string') return v;
    let out = v.replace(STRIKE_CHARS, '')
      .replace(new RegExp(String.raw`~~\s*(${price})\s*~~`, 'g'), '$1')
      .replace(new RegExp(String.raw`<(s|del|strike)>\s*(${price})\s*</\1>`, 'gi'), '$2')
      .replace(new RegExp(String.raw`\b${WAS_WORD}\s*:?\s*(${price})`, 'gi'), '$1');
    if (out !== v) report.changed.push({ from: v, to: out });
    return out;
  };
  const next = { ...adapted };
  for (const f of TEXT_SCALARS) if (typeof next[f] === 'string') next[f] = fix(next[f]);
  for (const f of TEXT_ARRAYS) if (Array.isArray(next[f])) next[f] = next[f].map(fix);
  // The visual brief is what the image model reads: a described strikethrough sticker gets drawn for our price.
  const scene = (v) => {
    if (typeof v !== 'string') return v;
    const out = v.replace(STRUCK_PAIR, PLAIN_PRICE).replace(STRUCK_ONE, PLAIN_PRICE);
    if (out !== v) report.changed.push({ from: v, to: out });
    return out;
  };
  const extra = {};
  for (const f of ['composition', 'background']) if (typeof claudeResult[f] === 'string') extra[f] = scene(claudeResult[f]);
  if (Array.isArray(claudeResult.visual_adaptations)) {
    extra.visual_adaptations = claudeResult.visual_adaptations.map((va) => (va && typeof va === 'object' ? { ...va, adapted_visual: scene(va.adapted_visual) } : va));
  }
  if (!report.changed.length) return { result: claudeResult, report };
  return { result: { ...claudeResult, ...extra, adapted_text: next }, report };
}

const STRIKE_WORD = String.raw`(?:struck[\s-]?(?:through|out)|strike[\s-]?through|crossed[\s-]?(?:out|through)|slashed)`;
const STRUCK_PAIR = new RegExp(String.raw`(?:an?\s+|the\s+)?${STRIKE_WORD}\s+(?:old\s+|original\s+|was\s+|regular\s+)?price\s+(?:above|over|next\s+to|beside|and|with|then)\s+(?:an?\s+|the\s+)?(?:new|sale|discounted|current|lower)\s+price`, 'gi');
const STRUCK_ONE = new RegExp(String.raw`(?:an?\s+|the\s+)?(?:${STRIKE_WORD}\s+(?:old\s+|original\s+|was\s+|regular\s+)?price|${STRIKE_WORD}\s+(?:an?\s+|the\s+)?(?:old\s+|original\s+|was\s+|regular\s+)?price|(?:old|original|was)\s+price\s+${STRIKE_WORD})(?:\s+and\s+(?:the\s+|a\s+)?(?:new|sale|discounted|current)\s+price)?`, 'gi');
const PLAIN_PRICE = 'our price and savings text as plain text, no strikethrough';

/** adapted_text lines that describe a struck/was price or pair our price with an invented original price. */
export function findStruckOwnPrice(adapted, offer) {
  const own = ownPriceOf(offer);
  const allowed = new Set([offer?.price, offer?.savings, offer?.discount, offer?.notes].flatMap(amountsIn));
  const hits = [];
  for (const [field, text] of textFields(adapted)) {
    if (STRIKE_TEST.test(text) || /~~\s*\$|<(s|del|strike)>/i.test(text)) { hits.push({ field, text, why: 'strikethrough markup on a price' }); continue; }
    if (new RegExp(String.raw`\b${WAS_WORD}\s*:?\s*\$\s?\d`, 'i').test(text) || /\b(?:struck|strike|crossed|slashed)\b/i.test(text)) {
      hits.push({ field, text, why: 'an old/was price' }); continue;
    }
    const amounts = amountsIn(text);
    if (own !== undefined && amounts.includes(own) && amounts.some((a) => !allowed.has(a))) {
      hits.push({ field, text, why: 'our price next to a price that is not in the offer (a was/now pair)' });
    }
  }
  return hits;
}

// ── The check ────────────────────────────────────────────────────────────────

export function buildRequiredElementsJudgePrompt(adapted, angle) {
  const bullets = Array.isArray(adapted?.bullets) ? adapted.bullets : [];
  return [
    'You check the copy of one static ad against its angle brief. Answer in JSON only.',
    '',
    `Angle: ${angle.name}`,
    'Required elements (the copy must clearly reflect at least one of them):',
    ...angle.required_elements.map((e) => `- ${e}`),
    '',
    'Ad copy (JSON):',
    JSON.stringify(adapted),
    '',
    'Return {"reflected": [...], "spec_bullets": [...]}:',
    '- reflected: the exact text of every required element above that the copy clearly reflects (empty list if none).',
    `- spec_bullets: the 0-based indexes (0 to ${Math.max(0, bullets.length - 1)}) of bullets that only state a product spec or feature (a count of settings or levels, a battery, a material, a list of things it does not have) and make no point from the required elements. A bullet that states the offer, the guarantee or a required element is not a spec bullet. Empty list if none.`,
  ].join('\n');
}

export function parseJudgeReply(text, bulletCount = 0) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('judge returned no JSON');
  const j = JSON.parse(m[0]);
  return {
    reflected: list(j.reflected),
    spec_bullets: (Array.isArray(j.spec_bullets) ? j.spec_bullets : []).filter((i) => Number.isInteger(i) && i >= 0 && i < bulletCount),
  };
}

/**
 * @param {object} claudeResult  the analysis after the enforce steps
 * @param {object} product       carries _bible (copy.curated, copyRules, offer, angleDef)
 * @param {{ judge?: Function }} deps  judge({ adapted, angle, prompt }) -> { reflected, spec_bullets }
 */
export async function checkPackCopy(claudeResult, product, { judge = null } = {}) {
  const bible = product?._bible;
  if (!bible?.copy?.curated || !bible.copyRules) return { applies: false, pass: true, violations: [] };
  const adapted = claudeResult?.adapted_text || {};
  const angle = resolveCheckedAngle(claudeResult, bible);
  const out = { applies: true, angle: angle?.name || null, violations: [] };
  if (!textFields(adapted).length) { out.pass = true; return out; }
  if (!angle) out.note = `angle "${claudeResult?.chosen_angle || bible.angleDef?.name || ''}" is not a pinned angle: only the core bans were checked`;

  for (const h of findBannedPhrases(adapted, bible.copyRules, angle)) {
    out.violations.push({ kind: 'tired_or_banned', detail: `${h.field} uses "${h.phrase}" (${h.source})` });
  }
  for (const h of findStruckOwnPrice(adapted, bible.offer)) {
    out.violations.push({ kind: 'struck_price', detail: `${h.field} "${h.text.replace(/\n/g, ' / ')}": ${h.why}. Our price is never struck through or shown as an old price` });
  }
  if (angle && angle.required_elements.length && typeof judge === 'function') {
    try {
      const v = await judge({ adapted, angle, prompt: buildRequiredElementsJudgePrompt(adapted, angle) });
      const bullets = Array.isArray(adapted.bullets) ? adapted.bullets : [];
      const reflected = list(v?.reflected);
      const spec = (Array.isArray(v?.spec_bullets) ? v.spec_bullets : []).filter((i) => Number.isInteger(i) && i >= 0 && i < bullets.length);
      out.reflected = reflected;
      if (!reflected.length) {
        out.violations.push({ kind: 'missing_required_element', detail: `none of the angle's required elements is reflected (${angle.required_elements.join('; ')})` });
      }
      for (const i of spec) {
        out.violations.push({ kind: 'spec_bullet', detail: `bullets[${i}] "${String(bullets[i]).replace(/\n/g, ' / ')}" is a spec-sheet feature line, not a point from the angle` });
      }
    } catch (err) {
      out.judge_error = String(err?.message || err).slice(0, 200);
    }
  }
  out.pass = out.violations.length === 0;
  return out;
}

export function buildCopyRewritePrompt(claudeResult, violations, angle, offer, rules = null) {
  const adapted = claudeResult?.adapted_text || {};
  const orig = claudeResult?.original_text || {};
  const count = (f) => (Array.isArray(adapted[f]) ? adapted[f].length : 0);
  const n = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;
  const bans = [...new Set([...(rules?.claims || []), ...(rules?.tired || []), ...(angle?.banned_phrases || [])])];
  const terms = [offer?.price && `price ${offer.price}`, offer?.discount && `discount ${offer.discount}`, offer?.code && `code ${offer.code}`, offer?.savings && `savings option ${offer.savings}`].filter(Boolean);
  return [
    'You wrote adapted_text (the words of a static ad) and it breaks these rules:',
    ...violations.map((v) => `- ${v.detail}`),
    '',
    'Rewrite ONLY adapted_text so that every violation is fixed.',
    `- Keep the same fields, the same shape and a similar length per field: ${n(count('bullets'), 'bullet')} and ${n(count('badges'), 'badge')}, empty fields stay empty, and keep line breaks where the current copy has them. The reference text below shows the space each field has.`,
    '- Bullets: each one a different point from the angle\'s required elements or copy directives, or a proof point from the product (mechanism, guarantee, honest timeline). Never a spec-sheet feature line.',
    `- Commercial terms: only ${terms.length ? terms.join(', ') : 'the price'}, in digits. Our price is never struck through, crossed out or written as an old or "was" price; next to a savings figure write it like "${offer?.price || '$X'} · ${offer?.savings || 'Save $Y'}".`,
    bans.length ? `- Never use any of these phrases: ${bans.map((b) => `"${b}"`).join(', ')}. No em dashes.` : '- No em dashes.',
    '',
    angle ? `Angle: ${angle.name}\nRequired elements:\n${angle.required_elements.map((e) => `- ${e}`).join('\n')}${angle.copy_directives ? `\nCopy directives:\n${angle.copy_directives}` : ''}` : 'Angle: not resolved; follow the product pack.',
    '',
    `Reference text (shape and length only, never its words): ${JSON.stringify(orig)}`,
    `Current adapted_text: ${JSON.stringify(adapted)}`,
    '',
    'Return JSON only: {"adapted_text": {"headline": "...", "subheadline": "...", "body": "...", "cta": "...", "bullets": [], "badges": []}}',
  ].join('\n');
}

const summarise = (violations) => violations.map((v) => v.detail).join(' | ');

/**
 * Check, and on a failure ask for ONE rewrite of adapted_text. Returns { result } with result.copy_check recorded.
 * deps: enforce(result) -> result (the path's own enforce steps), judge (see checkPackCopy),
 *       rewrite({ prompt, claudeResult }) -> { adapted_text }, log(line)
 */
export async function guardPackCopy({ claudeResult, product, enforce = (r) => r, judge = null, rewrite = null, log = () => {} }) {
  const bible = product?._bible;
  if (!bible?.copy?.curated || !bible.copyRules) return { result: claudeResult };
  const first = await checkPackCopy(claudeResult, product, { judge });
  const base = { angle: first.angle, ...(first.note ? { note: first.note } : {}), ...(first.judge_error ? { judge_error: first.judge_error } : {}) };
  if (first.judge_error) log(`copy check: judge unavailable (${first.judge_error}); required elements not checked`);
  if (first.pass) {
    log(`copy check: pass (angle ${first.angle || 'unresolved'})`);
    return { result: { ...claudeResult, copy_check: { ...base, pass: true, violations: [], rewrite: 'not_needed' } } };
  }
  log(`copy check: ${first.violations.length} violation(s), asking for one rewrite: ${summarise(first.violations)}`);
  const angle = resolveCheckedAngle(claudeResult, bible);
  let candidate = null; let second = null; let failure = null;
  try {
    if (typeof rewrite !== 'function') throw new Error('no rewrite function');
    const r = await rewrite({ prompt: buildCopyRewritePrompt(claudeResult, first.violations, angle, bible.offer, bible.copyRules), claudeResult });
    const adapted = r?.adapted_text;
    if (!adapted || typeof adapted !== 'object' || Array.isArray(adapted)) throw new Error('rewrite returned no adapted_text object');
    candidate = enforce({ ...claudeResult, adapted_text: adapted });
    second = await checkPackCopy(candidate, product, { judge });
  } catch (err) {
    failure = String(err?.message || err).slice(0, 200);
  }
  const record = { ...base, violations: first.violations.map((v) => v.detail) };
  if (failure) {
    const warning = summarise(first.violations);
    log(`copy check: rewrite failed (${failure}); kept the original. quality_warning: ${warning}`);
    return { result: { ...claudeResult, copy_check: { ...record, pass: false, rewrite: 'failed', rewrite_error: failure, quality_warning: warning } } };
  }
  if (second.pass) {
    log('copy check: rewrite accepted, all violations fixed');
    return { result: { ...candidate, copy_check: { ...record, pass: true, rewrite: 'accepted', original_adapted_text: claudeResult.adapted_text } } };
  }
  if (second.violations.length < first.violations.length) {
    const warning = summarise(second.violations);
    log(`copy check: rewrite improved ${first.violations.length}->${second.violations.length}, kept it. quality_warning: ${warning}`);
    return { result: { ...candidate, copy_check: { ...record, pass: false, rewrite: 'improved', remaining: second.violations.map((v) => v.detail), quality_warning: warning, original_adapted_text: claudeResult.adapted_text } } };
  }
  const warning = summarise(first.violations);
  log(`copy check: rewrite not better (${second.violations.length} vs ${first.violations.length}), kept the original. quality_warning: ${warning}`);
  return { result: { ...claudeResult, copy_check: { ...record, pass: false, rewrite: 'rejected', rewrite_violations: second.violations.map((v) => v.detail), quality_warning: warning } } };
}
