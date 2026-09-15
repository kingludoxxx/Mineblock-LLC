// Product-pack copy quality (found live 2026-09-16, Test 1).
// Reference: a "LABOR DAY FLASH SALE / EXTRA 26% OFF / WITH CODE LD26" promo with 3 icon bullets and a "$69 struck
// through, $32" sticker. Auto picked Promo / Urgency and returned:
//   bullets ["3 INTENSITY LEVELS\nFOR YOUR COMFORT", "NO MASK + NO HOSE\nJUST WEAR & SLEEP", "90-NIGHT MONEY-BACK\nGUARANTEE"]
//   badges  ["$149\nSave $197"]
// and the rendered image showed OUR $149 struck through (the image model copied the reference sticker).
// Three fixes, product-pack products only: (1) our price is never struck through, in the analysis prompt, the image
// prompt and the adapted text; (2) bullets come from the angle's required elements or the core's proof, never spec
// lines or tired words; (3) a check before render that asks the analysis model for ONE rewrite of adapted_text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderCommercialStructureBlock, buildClaudeAnalysisPrompt, buildNanoBananaImagePrompt, ownPriceRuleLine,
} from '../../src/utils/staticsPrompts.js';
import {
  parseNeverSay, packCopyRules, resolveCheckedAngle, findBannedPhrases, findStruckOwnPrice, enforceOwnPriceNotStruck,
  checkPackCopy, guardPackCopy, buildCopyRewritePrompt, buildRequiredElementsJudgePrompt, parseJudgeReply,
} from '../../src/utils/packCopyGuard.js';

// The approved apnea core's "WHAT WE NEVER SAY" block, verbatim from the live pack (2026-09-16).
const NEVER_SAY = `WHAT WE NEVER SAY
Banned claims: cures sleep apnea, eliminates, resolves, permanent; replaces CPAP, stop using your CPAP; FDA approved or cleared; "your sleep apnea"; guaranteed or first-night results; invented studies, numbers or percentages; doctor names we cannot verify; competitor brand names; % off or timers in cold ads; the spelling "NEMS"; "No mask. No hose. Just sleep." (Inspire); em dashes.
Tired words to avoid: finally, breakthrough, game changer, miracle, science-backed, clinically tested, doctor-backed, root cause, a simple fix, "no mask, no hose" as a headline.`;
const CORE = `WHAT IT IS\nReevo Pulse Pro is a small rechargeable under-chin device.\n\nHOW IT IS USED\n- Three intensity levels.\n- No mask, no hose, nothing in the mouth.\n\nPRICE AND GUARANTEE\n$149. Code SLEEP20. 90-night money-back guarantee.\n\n${NEVER_SAY}`;
const URGENCY = {
  id: 'rv_apnea_angle_urgency', name: 'Promo / Urgency', market: 'apnea',
  required_elements: ['The real offer (price and code from the offer block)', 'One program-urgency line', '90-night money-back guarantee'],
  banned_phrases: ['cures sleep apnea', 'replaces CPAP', 'FDA approved', 'invented deadlines or countdowns', 'stock counts', 'prices going up'],
  copy_directives: '- Lead with the real offer.\n- Add program urgency: "every night you wait".',
};
const PARTNER = {
  id: 'rv_apnea_angle_partner', name: 'Partner (Separate Rooms)', market: 'apnea',
  required_elements: ['The separate rooms, or the second bed', 'Back in the same bed'],
  banned_phrases: ['saves your marriage', 'stops snoring completely'],
};
const OFFER = { price: '$149', discount: 'Up to 20% off', code: 'SLEEP20', savings: 'Save up to $197' };
const rules = packCopyRules({ core: CORE, angles: [URGENCY, PARTNER] });
const bible = (angleName = 'AUTO', extra = {}) => ({
  angleDef: { name: angleName }, copy: { text: 'PRODUCT PACK', curated: true, market: { price: '$149' } },
  image: { text: 'IMAGE PACK' }, offer: OFFER, copyRules: rules, ...extra,
});
const TEST1_ADAPTED = {
  headline: 'SAVE\nUP TO 20% OFF', subheadline: 'SLEEP APNEA SALE', body: 'WITH CODE SLEEP20', cta: '',
  bullets: ['3 INTENSITY LEVELS\nFOR YOUR COMFORT', 'NO MASK + NO HOSE\nJUST WEAR & SLEEP', '90-NIGHT MONEY-BACK\nGUARANTEE'],
  badges: ['$149\nSave $197'],
};
const TEST1 = {
  original_text: { headline: 'LABOR DAY\nFLASH SALE', subheadline: 'EXTRA 26% OFF', body: 'WITH CODE LD26', cta: '', bullets: ['a', 'b', 'c'], badges: ['$69 $32'] },
  adapted_text: TEST1_ADAPTED, chosen_angle: 'Promo / Urgency',
};

// ── FIX 1: our price is never struck through ────────────────────────────────
test('G1: the commercial-structure block forbids striking our price and maps a was/now sticker to price + savings', () => {
  const block = renderCommercialStructureBlock(OFFER);
  assert.match(block, /OUR PRICE/);
  assert.match(block, /never (?:shown |written )?struck through/i);
  assert.match(block, /\$149 · Save up to \$197/, 'gives the exact replacement for a was/now sticker');
  assert.doesNotMatch(block, /—/, 'no em dash in prompt copy');
  const none = renderCommercialStructureBlock({ price: '$99' });
  assert.match(none, /OUR PRICE/);
  assert.match(none, /\$99/);
});

test('G2: a pack product image prompt carries the OUR PRICE rule first, and it survives a tight budget', () => {
  const claude = { adapted_text: TEST1_ADAPTED, original_text: TEST1.original_text, product_visual_for_generation: 'device' };
  const TEMPLATE = 'TEXT:\n{{TEXT_SWAPS}}\n\nKNOWLEDGE: {{NOTES}}\n' + 'filler line\n'.repeat(400);
  const product = { name: 'Reevo Pulse Pro', _bible: bible() };
  const full = buildNanoBananaImagePrompt(claude, product, TEMPLATE, {}, { referenceCount: 2 });
  const rule = ownPriceRuleLine('Reevo Pulse Pro');
  assert.ok(full.includes(rule), 'rule present');
  assert.ok(full.indexOf(rule) < full.indexOf('TEXT:'), 'rule is ahead of the template');
  assert.doesNotMatch(rule, /—/);
  assert.match(rule, /struck through/i);
  const tight = buildNanoBananaImagePrompt(claude, product, TEMPLATE, {}, { maxChars: 3000, referenceCount: 2 });
  assert.ok(tight.length <= 3000, `fits (${tight.length})`);
  assert.ok(tight.includes(rule), 'rule survives shortening');
});

test('G3: products without a pack or bible get no price rule (legacy prompt unchanged)', () => {
  const claude = { adapted_text: { headline: 'H' }, original_text: { headline: 'O' } };
  const out = buildNanoBananaImagePrompt(claude, { name: 'Mineblock' }, 'X {{TEXT_SWAPS}}', {}, { referenceCount: 1 });
  assert.doesNotMatch(out, /OUR PRICE/);
});

test('G4: deterministic clean-up removes strike markup and was-words from our own price only', () => {
  const product = { name: 'P', _bible: bible('Promo / Urgency') };
  const r = enforceOwnPriceNotStruck({ adapted_text: {
    headline: 'Was $149, now $119', subheadline: '~~$149~~ $119', body: '<s>$149</s> today', cta: 'Reg. $299', bullets: ['$1̶4̶9̶ Save up to $197'], badges: ['$149\nSave $197'],
  } }, product);
  assert.equal(r.result.adapted_text.headline, '$149, now $119');
  assert.equal(r.result.adapted_text.subheadline, '$149 $119');
  assert.equal(r.result.adapted_text.body, '$149 today');
  assert.equal(r.result.adapted_text.cta, 'Reg. $299', 'a price that is not ours is left for the check to flag');
  assert.equal(r.result.adapted_text.bullets[0], '$149 Save up to $197');
  assert.equal(r.result.adapted_text.badges[0], '$149\nSave $197');
  assert.ok(r.report.changed.length >= 4);
  const legacy = { adapted_text: { headline: 'Was $149' } };
  assert.equal(enforceOwnPriceNotStruck(legacy, { name: 'MB' }).result, legacy, 'legacy stores untouched');
});

test('G5: the check flags a was/now price pair and a higher invented original price', () => {
  assert.deepEqual(findStruckOwnPrice({ badges: ['$149\nSave up to $197'] }, OFFER), []);
  assert.deepEqual(findStruckOwnPrice({ headline: '$149 · Save up to $197' }, OFFER), []);
  assert.ok(findStruckOwnPrice({ badges: ['$299 $149'] }, OFFER).length === 1, 'was/now pair');
  assert.ok(findStruckOwnPrice({ badges: ['Reg. $299'] }, OFFER).length === 1, 'invented original price');
  assert.ok(findStruckOwnPrice({ body: 'Regular price $149, today $119' }, OFFER).length >= 1, 'our price as the old price');
  assert.deepEqual(findStruckOwnPrice({ body: '90-night money-back guarantee, 20% OFF, code SLEEP20' }, OFFER), []);
});

// ── FIX 2: bullets from the angle, bans stored structurally ─────────────────
test('G6: the pack copy approach demands angle bullets, no spec lines, no tired words', () => {
  const prompt = buildClaudeAnalysisPrompt({ name: 'Reevo Pulse Pro', _bible: bible() }, '', 'TEMPLATE {{PRODUCT_NAME}}', {});
  assert.match(prompt, /BULLETS/);
  assert.match(prompt, /required element/i);
  assert.match(prompt, /spec/i);
  assert.match(prompt, /3 intensity levels/i, 'names the live spec example');
  assert.match(prompt, /tired words/i);
  assert.match(prompt, /OUR PRICE/);
  assert.doesNotMatch(prompt.slice(prompt.indexOf('COPY APPROACH')), /—/);
});

test('G7: the WHAT WE NEVER SAY block parses into literal phrases, respecting quotes and parentheses', () => {
  const p = parseNeverSay(CORE);
  for (const want of ['cures sleep apnea', 'eliminates', 'permanent', 'replaces cpap', 'stop using your cpap', 'fda approved', 'fda cleared', 'your sleep apnea', 'nems', 'no mask. no hose. just sleep.']) {
    assert.ok(p.claims.map((s) => s.toLowerCase()).includes(want), `claims has "${want}": ${JSON.stringify(p.claims)}`);
  }
  for (const want of ['finally', 'breakthrough', 'game changer', 'root cause', 'a simple fix', 'no mask, no hose']) {
    assert.ok(p.tired.map((s) => s.toLowerCase()).includes(want), `tired has "${want}": ${JSON.stringify(p.tired)}`);
  }
  assert.ok(!p.tired.some((s) => /as a headline/i.test(s)), 'qualifier dropped');
  assert.ok(!p.claims.some((s) => /Inspire/.test(s)), 'parenthetical dropped');
  assert.ok(p.emDashBanned);
  assert.deepEqual(parseNeverSay('no such block'), { claims: [], tired: [], emDashBanned: false });
  assert.deepEqual(parseNeverSay(null), { claims: [], tired: [], emDashBanned: false });
});

test('G8: rules are per angle; AUTO resolves to the model chosen_angle; an unknown angle falls back to core bans', () => {
  assert.equal(resolveCheckedAngle({ chosen_angle: 'Promo / Urgency' }, bible('AUTO')).name, 'Promo / Urgency');
  assert.equal(resolveCheckedAngle({ chosen_angle: 'promo / urgency ' }, bible('AUTO')).name, 'Promo / Urgency');
  assert.equal(resolveCheckedAngle({ chosen_angle: 'Nope' }, bible('AUTO')), null);
  assert.equal(resolveCheckedAngle({ chosen_angle: 'Promo / Urgency' }, bible('Partner (Separate Rooms)')).name, 'Partner (Separate Rooms)', 'an operator-picked angle wins');
  // A structural list on the pack is honoured too.
  const withList = packCopyRules({ core: CORE, angles: [URGENCY], banned_phrases: ['sleep like a baby'] });
  assert.ok(withList.claims.includes('sleep like a baby'));
});

test('G9: banned + tired phrases are matched case-insensitively across punctuation, whole words only', () => {
  const hits = findBannedPhrases(TEST1_ADAPTED, rules, rules.angles.find((a) => a.name === 'Promo / Urgency'));
  assert.ok(hits.some((h) => h.phrase.toLowerCase() === 'no mask, no hose' && h.field === 'bullets[1]'), JSON.stringify(hits));
  assert.equal(hits.length, 1, JSON.stringify(hits));
  assert.deepEqual(findBannedPhrases({ bullets: ['90-night money-back guarantee'] }, rules, null), [], '"guaranteed" does not match "guarantee"');
  assert.equal(findBannedPhrases({ headline: 'It FINALLY works' }, rules, null).length, 1);
  assert.equal(findBannedPhrases({ headline: 'Sleep — better' }, rules, null)[0].phrase, 'em dash');
});

// ── FIX 3: check before render, one rewrite at most ────────────────────────
const judgeSays = (out) => async () => out;

test('G10: Test 1 output fails the check: tired words, a spec bullet, and no program-urgency element', async () => {
  const product = { name: 'Reevo Pulse Pro', _bible: bible('AUTO') };
  const judge = judgeSays({ reflected: ['The real offer (price and code from the offer block)', '90-night money-back guarantee'], spec_bullets: [0] });
  const c = await checkPackCopy(TEST1, product, { judge });
  assert.equal(c.applies, true);
  assert.equal(c.angle, 'Promo / Urgency');
  const kinds = c.violations.map((v) => v.kind).sort();
  assert.deepEqual(kinds, ['spec_bullet', 'tired_or_banned']);
  assert.equal(c.pass, false);
  const none = await checkPackCopy(TEST1, product, { judge: judgeSays({ reflected: [], spec_bullets: [] }) });
  assert.ok(none.violations.some((v) => v.kind === 'missing_required_element'));
});

test('G11: guard: a failing result gets exactly one rewrite; the fixed copy is kept and re-enforced', async () => {
  const product = { name: 'Reevo Pulse Pro', _bible: bible('AUTO') };
  let rewrites = 0; let judged = 0; const logs = [];
  const fixed = { ...TEST1_ADAPTED, bullets: ['EVERY NIGHT YOU WAIT\nTHE MUSCLE STAYS SLACK', 'YOUR 90 NIGHTS\nSTART TONIGHT', '90-NIGHT MONEY-BACK\nGUARANTEE'], badges: ['Was $149\nSave up to $197'] };
  const out = await guardPackCopy({
    claudeResult: TEST1, product,
    enforce: (r) => enforceOwnPriceNotStruck(r, product).result,
    judge: async (args) => { judged++; return args.adapted.bullets[0].startsWith('3 INTENSITY') ? { reflected: ['x'], spec_bullets: [0] } : { reflected: ['One program-urgency line'], spec_bullets: [] }; },
    rewrite: async ({ prompt }) => { rewrites++; assert.match(prompt, /no mask, no hose/); assert.match(prompt, /bullets\[0\]/); return { adapted_text: fixed }; },
    log: (m) => logs.push(m),
  });
  assert.equal(rewrites, 1);
  assert.equal(judged, 2);
  assert.equal(out.result.adapted_text.bullets[0], 'EVERY NIGHT YOU WAIT\nTHE MUSCLE STAYS SLACK');
  assert.equal(out.result.adapted_text.badges[0], '$149\nSave up to $197', 'enforce ran on the rewrite');
  assert.equal(out.result.copy_check.rewrite, 'accepted');
  assert.equal(out.result.copy_check.quality_warning, undefined);
  assert.ok(logs.some((l) => /rewrite/.test(l)));
});

test('G12: guard never loops: a rewrite that still fails keeps the better version and records a quality_warning', async () => {
  const product = { name: 'Reevo Pulse Pro', _bible: bible('AUTO') };
  let rewrites = 0; const logs = [];
  const worse = { ...TEST1_ADAPTED, headline: 'FINALLY A BREAKTHROUGH', bullets: ['NO MASK, NO HOSE', 'MIRACLE', 'GAME CHANGER'] };
  const out = await guardPackCopy({
    claudeResult: TEST1, product, enforce: (r) => r,
    judge: judgeSays({ reflected: ['One program-urgency line'], spec_bullets: [] }),
    rewrite: async () => { rewrites++; return { adapted_text: worse }; },
    log: (m) => logs.push(m),
  });
  assert.equal(rewrites, 1);
  assert.deepEqual(out.result.adapted_text, TEST1_ADAPTED, 'the original had fewer violations');
  assert.equal(out.result.copy_check.rewrite, 'rejected');
  assert.match(out.result.copy_check.quality_warning, /no mask, no hose/);
  assert.ok(logs.some((l) => /quality_warning/.test(l)));
});

test('G13: guard failure paths: judge error, rewrite error, garbage rewrite; none throw, none loop', async () => {
  const product = { name: 'Reevo Pulse Pro', _bible: bible('AUTO') };
  const logs = [];
  const a = await guardPackCopy({ claudeResult: TEST1, product, enforce: (r) => r,
    judge: async () => { throw new Error('haiku 529 overloaded'); },
    rewrite: async () => { throw new Error('sonnet timeout'); }, log: (m) => logs.push(m) });
  assert.deepEqual(a.result.adapted_text, TEST1_ADAPTED);
  assert.equal(a.result.copy_check.rewrite, 'failed');
  assert.match(a.result.copy_check.judge_error, /529/);
  assert.match(a.result.copy_check.quality_warning, /no mask, no hose/);
  let n = 0;
  const b = await guardPackCopy({ claudeResult: TEST1, product, enforce: (r) => r, judge: judgeSays({ reflected: ['x'], spec_bullets: [] }),
    rewrite: async () => { n++; return { nope: true }; }, log: () => {} });
  assert.equal(n, 1);
  assert.deepEqual(b.result.adapted_text, TEST1_ADAPTED);
  assert.equal(b.result.copy_check.rewrite, 'failed');
});

test('G14: a clean result and a legacy product make no model call at all', async () => {
  const product = { name: 'Reevo Pulse Pro', _bible: bible('AUTO') };
  const clean = { ...TEST1, adapted_text: { ...TEST1_ADAPTED, bullets: ['EVERY NIGHT YOU WAIT\nTHE MUSCLE STAYS SLACK', 'YOUR 90 NIGHTS\nSTART TONIGHT', '90-NIGHT MONEY-BACK\nGUARANTEE'] } };
  let rewrites = 0;
  const ok = await guardPackCopy({ claudeResult: clean, product, enforce: (r) => r, judge: judgeSays({ reflected: ['One program-urgency line'], spec_bullets: [] }), rewrite: async () => { rewrites++; }, log: () => {} });
  assert.equal(rewrites, 0);
  assert.equal(ok.result.copy_check.pass, true);
  let calls = 0;
  const legacy = await guardPackCopy({ claudeResult: TEST1, product: { name: 'MB', _bible: undefined }, enforce: (r) => r,
    judge: async () => { calls++; }, rewrite: async () => { calls++; }, log: () => { calls++; } });
  assert.equal(calls, 0);
  assert.equal(legacy.result, TEST1, 'returned untouched, no copy_check field');
  const nonCurated = await guardPackCopy({ claudeResult: TEST1, product: { name: 'X', _bible: { ...bible(), copy: { text: 'b', curated: false } } }, enforce: (r) => r,
    judge: async () => { calls++; }, rewrite: async () => { calls++; }, log: () => {} });
  assert.equal(calls, 0);
  assert.equal(nonCurated.result, TEST1);
});

test('G15: rewrite + judge prompts: same shape and lengths, violations listed, required elements named, no em dash', () => {
  const angle = rules.angles.find((a) => a.name === 'Promo / Urgency');
  const rp = buildCopyRewritePrompt(TEST1, [{ kind: 'tired_or_banned', detail: 'bullets[1] uses "no mask, no hose"' }], angle, OFFER);
  assert.match(rp, /adapted_text/);
  assert.match(rp, /same (?:fields|shape)/i);
  assert.match(rp, /3 bullets/);
  assert.match(rp, /One program-urgency line/);
  assert.match(rp, /no mask, no hose/);
  assert.doesNotMatch(rp, /—/);
  const jp = buildRequiredElementsJudgePrompt(TEST1_ADAPTED, angle);
  assert.match(jp, /One program-urgency line/);
  assert.match(jp, /spec_bullets/);
  assert.doesNotMatch(jp, /—/);
  assert.deepEqual(parseJudgeReply('```json\n{"reflected":["a"],"spec_bullets":[1,"x",9]}\n```', 3), { reflected: ['a'], spec_bullets: [1] });
  assert.throws(() => parseJudgeReply('no json here', 3));
});

test('G16: the three analysis paths (/generate, iterate, regenerate) run the guard after the enforce steps, and Composer carries the price rule', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../src/routes/staticsGeneration.js', import.meta.url), 'utf8');
  const guards = [...src.matchAll(/await runPackCopyGuard\(/g)].map((m) => m.index);
  assert.equal(guards.length, 3, `guard calls: ${guards.length}`);
  const digits = [...src.matchAll(/const digits = enforcePriceDigits\(claudeResult, product\);/g)].map((m) => m.index);
  assert.equal(digits.length, 3);
  for (let i = 0; i < 3; i++) assert.ok(guards[i] > digits[i] && (i === 2 || guards[i] < digits[i + 1]), `path ${i}: guard after its own enforce steps`);
  const offerAt = src.indexOf('const offer = enforceOfferClaims(claudeResult, product);');
  assert.ok(guards[0] > offerAt, '/generate: guard after enforceOfferClaims');
  assert.match(src, /ownPriceRuleLine\(/);
  assert.match(src, /claude-haiku-4-5/);
});

// The live Test 1 analysis described the reference sticker in `composition`, and the image model drew it for our price.
test('G17: a strikethrough price sticker described in composition / visual_adaptations is rewritten to a plain price', () => {
  const product = { name: 'P', _bible: bible('AUTO') };
  const live = 'three bullet points each preceded by a small icon (gear, leaf, shield), then a price badge (circle with struck-through old price above new price) in the lower-left corner. Right half is occupied by the product stack.';
  const r = enforceOwnPriceNotStruck({ adapted_text: { badges: ['$149\nSave $197'] }, composition: live,
    visual_adaptations: [{ original_visual: '$69 crossed out price sticker', adapted_visual: 'Circular sticker with a slashed original price and the sale price', position: 'lower-left' }] }, product);
  assert.doesNotMatch(r.result.composition, /struck|crossed|slashed|old price/i, r.result.composition);
  assert.match(r.result.composition, /price badge \(circle with our price and savings text as plain text, no strikethrough\) in the lower-left corner/);
  assert.doesNotMatch(r.result.visual_adaptations[0].adapted_visual, /slashed|original price/i, r.result.visual_adaptations[0].adapted_visual);
  assert.equal(r.result.visual_adaptations[0].original_visual, '$69 crossed out price sticker', 'the reference description is not ours to change');
  assert.ok(r.report.changed.length >= 2);
  const untouched = { adapted_text: { headline: 'H' }, composition: live };
  assert.equal(enforceOwnPriceNotStruck(untouched, { name: 'MB' }).result, untouched, 'legacy stores untouched');
});
