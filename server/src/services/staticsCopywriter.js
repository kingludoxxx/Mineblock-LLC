/**
 * Authored copy for statics.
 *
 * WHY THIS EXISTS
 * Until now the image model invented the words and rendered them in one step.
 * That is why a finished card read "A SURGERY RESULTS.", why another was
 * attributed to "— Editorial Reviewer" (an internal taxonomy label printed as a
 * byline), and why a third argued "Puure met our cost criteria" — nobody was
 * assigned to write copy, so the renderer improvised it. Worse, the words only
 * existed as pixels, so nothing could check them; catching a banned phrase
 * needed a vision model reading our own headline back.
 *
 * Splitting the stages fixes the class, not the instance:
 *   - copy is a STRING before it is a picture, so enforcement is deterministic
 *     (exact banned-phrase match, real word counts, duplicate detection)
 *   - a bad candidate costs a fraction of a cent to reject instead of a full
 *     image generation
 *   - the renderer receives EXACT text to typeset rather than a brief to
 *     interpret
 *
 * The image model still owns layout and art direction. It no longer owns words.
 */
import Anthropic from '@anthropic-ai/sdk';
import { capFor, getFormat } from '../config/staticsFormats.js';
import { extractAuthorisedCodes } from '../utils/staticsPrompts.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const COPY_MODEL = 'claude-opus-5';

// Per-field ceilings. The format cap governs the TOTAL; these stop one field
// eating the whole budget (a 30-word "headline" inside a 32-word checklist).
export const FIELD_CAPS = Object.freeze({
  headline: 8,
  subhead: 12,
  bullet: 6,
  cta: 5,
  attribution: 6,
});

const PLACEHOLDER = /\b(lorem ipsum|placeholder|your (?:headline|text) here|tbd|xxx+)\b/i;

export function wordCount(s) {
  if (!s) return 0;
  return String(s).trim().split(/\s+/).filter(Boolean).length;
}

/** Every visible word a copy set will put on the card. */
export function totalWords(set = {}) {
  const parts = [set.headline, set.subhead, set.cta, set.attribution]
    .concat(Array.isArray(set.bullets) ? set.bullets : []);
  return parts.reduce((n, p) => n + wordCount(p), 0);
}

// Contractions are expanded on BOTH sides before comparison. Angle lists are
// written longhand ("they do not want you to know") while copy is written the
// way people speak ("they don't want you to know"), so a raw substring match
// misses the exact violation it exists to catch.
// NOTE the missing leading \b on the suffix rules: in "don't" there is no word
// boundary between "o" and "n", so /\bn't\b/ never fires and the exact banned
// phrase this check exists to catch sails through. Irregulars run first.
const CONTRACTIONS = [
  [/\bcan't\b/g, 'cannot'], [/\bwon't\b/g, 'will not'], [/\bshan't\b/g, 'shall not'],
  [/\bit's\b/g, 'it is'], [/\bthat's\b/g, 'that is'], [/\bwhat's\b/g, 'what is'],
  [/\bhere's\b/g, 'here is'], [/\bthere's\b/g, 'there is'], [/\bwho's\b/g, 'who is'],
  [/\blet's\b/g, 'let us'],
  [/n't\b/g, ' not'], [/'re\b/g, ' are'], [/'ll\b/g, ' will'],
  [/'ve\b/g, ' have'], [/'d\b/g, ' would'],
];

function normalise(s) {
  let t = String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  for (const [re, to] of CONTRACTIONS) t = t.replace(re, to);
  return t.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Leading words that legitimately repeat down a list as parallel construction
// ("No scars." / "No downtime.") rather than as a duplicated row label.
const PARALLEL_OK = new Set([
  'no', 'not', 'zero', 'same', 'all', 'every', 'one', 'two', 'three', 'four', 'five',
  'at', 'in', 'on', 'for', 'from', 'with', 'up', 'and', 'or', 'the', 'a', 'an',
  'get', 'free', 'less', 'more', 'fast', 'real', 'only', 'just', 'your', 'our', 'you',
]);

/**
 * Deterministic validation of one copy set.
 *
 * Returns { ok, problems[], set } — `set` is the input with whitespace tidied,
 * never silently rewritten. A caller that wants a valid set picks one where
 * ok === true rather than shipping a repaired-but-wrong one.
 *
 * This is the check that used to require a vision model. Banned phrases are now
 * an exact substring match on normalised text, so there is no paraphrase
 * judgement to get wrong in either direction.
 */
export function enforceCopySet(rawSet = {}, { format = null, product = {}, angle = null } = {}) {
  const problems = [];
  const fmt = typeof format === 'string' ? getFormat(format) : format;
  const cap = fmt ? fmt.cap : capFor(null);

  const set = {
    concept: String(rawSet.concept || '').trim() || null,
    headline: String(rawSet.headline || '').trim(),
    subhead: String(rawSet.subhead || '').trim() || null,
    bullets: (Array.isArray(rawSet.bullets) ? rawSet.bullets : [])
      .map(b => String(b || '').trim()).filter(Boolean),
    cta: String(rawSet.cta || '').trim() || null,
    attribution: String(rawSet.attribution || '').trim() || null,
  };

  if (!set.headline) problems.push('missing headline');

  // ── field ceilings ───────────────────────────────────────────────────────
  if (wordCount(set.headline) > FIELD_CAPS.headline) {
    problems.push(`headline ${wordCount(set.headline)} words (max ${FIELD_CAPS.headline})`);
  }
  if (set.subhead && wordCount(set.subhead) > FIELD_CAPS.subhead) {
    problems.push(`subhead ${wordCount(set.subhead)} words (max ${FIELD_CAPS.subhead})`);
  }
  if (set.cta && wordCount(set.cta) > FIELD_CAPS.cta) {
    problems.push(`cta ${wordCount(set.cta)} words (max ${FIELD_CAPS.cta})`);
  }
  if (set.attribution && wordCount(set.attribution) > FIELD_CAPS.attribution) {
    problems.push(`attribution ${wordCount(set.attribution)} words (max ${FIELD_CAPS.attribution})`);
  }
  set.bullets.forEach((b, i) => {
    if (wordCount(b) > FIELD_CAPS.bullet) {
      problems.push(`bullet ${i + 1} ${wordCount(b)} words (max ${FIELD_CAPS.bullet})`);
    }
  });

  // ── total budget ─────────────────────────────────────────────────────────
  const total = totalWords(set);
  if (total > cap) problems.push(`${total} words total (cap ${cap}${fmt ? ` for ${fmt.id}` : ''})`);

  // ── grid discipline ──────────────────────────────────────────────────────
  if (set.bullets.length) {
    if (fmt && !fmt.allowsGrid) {
      problems.push(`${set.bullets.length} bullet(s) but format ${fmt.id} takes none`);
    } else if (fmt && fmt.maxRows && set.bullets.length > fmt.maxRows) {
      problems.push(`${set.bullets.length} rows (max ${fmt.maxRows} for ${fmt.id})`);
    }
    // The "Puure printed as three identical row labels" defect, catchable in
    // text now that copy exists as strings before it exists as pixels.
    //
    // Two signals. A repeated OPENING WORD is the real-world shape of it — the
    // rendered card showed the brand name as the label on three separate rows.
    // Parallel construction ("No scars." / "No downtime.") repeats an opening
    // word legitimately, so function words are exempt.
    const leads = new Map();
    for (const b of set.bullets) {
      const lead = normalise(b).split(' ')[0];
      if (!lead || PARALLEL_OK.has(lead)) continue;
      leads.set(lead, (leads.get(lead) || 0) + 1);
    }
    const dupLead = [...leads.entries()].find(([, n]) => n > 1);
    if (dupLead) problems.push(`repeated row label: "${dupLead[0]}" opens ${dupLead[1]} rows`);

    const seen = new Set();
    for (const b of set.bullets) {
      const key = normalise(b).split(' ').slice(0, 3).join(' ');
      if (key && seen.has(key)) { problems.push(`repeated row: "${b.slice(0, 40)}"`); break; }
      seen.add(key);
    }
  }

  // ── banned phrases: exact, no paraphrase judgement ───────────────────────
  const banned = Array.isArray(angle?.banned_phrases) ? angle.banned_phrases.filter(Boolean) : [];
  if (banned.length) {
    const hay = normalise([set.headline, set.subhead, set.cta, set.attribution, ...set.bullets].join(' '));
    for (const phrase of banned) {
      // Angle lists annotate intent in parentheses — "(as clickbait)" — which is
      // guidance for a human, not part of the string to match.
      const core = normalise(String(phrase).replace(/\([^)]*\)/g, ''));
      if (core && core.split(' ').length >= 2 && hay.includes(core)) {
        problems.push(`banned phrase: "${phrase}"`);
      }
    }
  }

  // ── offer discipline ─────────────────────────────────────────────────────
  const authorised = extractAuthorisedCodes(product?.discount_codes);
  const allText = [set.headline, set.subhead, set.cta, ...set.bullets].filter(Boolean).join(' ');
  const codeMentions = allText.match(/\b(?:use\s+)?(?:code|coupon|promo\s*code)\s*[:\-—]?\s*["“']?([A-Za-z0-9][A-Za-z0-9_-]{2,19})/gi) || [];
  for (const m of codeMentions) {
    const code = (m.match(/([A-Za-z0-9][A-Za-z0-9_-]{2,19})\s*$/) || [])[1];
    if (code && !authorised.some(a => a.toLowerCase() === code.toLowerCase())) {
      problems.push(`unauthorised discount code: "${code}"`);
    }
  }

  // ── attribution must be a person, not our internal label ─────────────────
  if (set.attribution && angle?.messenger) {
    const label = normalise(angle.messenger);
    const attr = normalise(set.attribution);
    const overlap = label.split(/\s*\/\s*|\s+/).filter(w => w.length > 3);
    if (attr && (label.includes(attr) || overlap.some(w => attr === w) || attr === label)) {
      problems.push(`attribution "${set.attribution}" is the messenger label, not a named person`);
    }
  }

  if (PLACEHOLDER.test(allText)) problems.push('placeholder text');

  return { ok: problems.length === 0, problems, set, totalWords: total, cap };
}

/**
 * Score a valid copy set so a batch can pick deterministically. Higher is
 * better. Deliberately simple and explainable — a short concrete headline with
 * room left in the budget beats a long abstract one that only just fits.
 */
export function scoreCopySet(result) {
  const s = result.set || {};
  let score = 0;
  const hw = wordCount(s.headline);
  if (hw >= 3 && hw <= 6) score += 3; else if (hw <= 8) score += 1;
  if (/\d/.test(`${s.headline} ${s.subhead || ''}`)) score += 2;  // concrete number
  if (s.subhead) score += 1;
  if (result.cap && result.totalWords <= result.cap * 0.75) score += 2;  // breathing room
  if (/[.!?]$/.test(s.headline)) score += 1;                      // finished thought
  return score;
}

function buildCopyPrompt({ product, angle, format, hook, proof, count }) {
  const fmt = getFormat(format) || null;
  const cap = fmt ? fmt.cap : capFor(null);
  const banned = Array.isArray(angle?.banned_phrases) ? angle.banned_phrases.filter(Boolean) : [];
  const codes = extractAuthorisedCodes(product?.discount_codes);

  const grid = fmt && fmt.allowsGrid
    ? `- bullets: up to ${fmt.maxRows} rows, each at most ${FIELD_CAPS.bullet} words. EVERY row must be a DIFFERENT subject — never repeat a row label.`
    : '- bullets: MUST be an empty array. This layout carries no list.';

  return `You are a senior direct-response copywriter. Write ad copy for a paid social static.

PRODUCT
  name: ${product?.name || ''}
  price: ${product?.price || ''}
  promise: ${product?.big_promise || ''}
  mechanism: ${product?.mechanism || ''}
  guarantee: ${product?.guarantee || ''}

${angle ? `ANGLE: ${angle.name}
  who it speaks to: ${angle.avatar || ''}
  voice: ${angle.messenger || 'brand voice'}
  tone: ${angle.tone || ''}` : ''}

${hook ? `THE ARGUMENT THIS ONE AD MAKES — write a FRESH headline in this direction,
do NOT copy it verbatim: "${hook}"` : ''}
${proof ? `THE SINGLE PROOF POINT IT CARRIES: ${proof}` : ''}

LAYOUT IT WILL BE SET IN: ${fmt ? fmt.prompt : 'a simple type-led card'}

HARD LIMITS — copy that breaks these is discarded unread:
- TOTAL across every field: at most ${cap} words. Count them.
- headline: at most ${FIELD_CAPS.headline} words.
- subhead: at most ${FIELD_CAPS.subhead} words, or null.
${grid}
- cta: at most ${FIELD_CAPS.cta} words, or null.
- attribution: only for a quote. It must be a PLAUSIBLE NAMED PERSON with a
  credential — "Dr. Elena Marquez, MD". NEVER a role label like "Confessing
  Surgeon" or "Editorial Reviewer"; those are our internal notes, not bylines.
${banned.length ? `- NEVER use these phrasings: ${banned.map(b => `"${b}"`).join(', ')}` : ''}
${codes.length ? `- The ONLY discount code that exists is: ${codes.join(', ')}` : '- Do NOT mention any discount code, coupon or promo code. None exist.'}
- No claim that is not supported by the product facts above.
- No before/after language about a person's body.

CRAFT:
- One idea per ad. The headline carries it; everything else supports.
- Concrete beats abstract. A number, a price, a depth, a timeframe.
- Write like a person talking, not a brand announcing. No "unlock", no
  "revolutionary", no "game-changing", no "elevate".
- The headline should be understandable in under two seconds at thumb speed.

Return ONLY raw JSON, no markdown fence:
{"candidates":[{"concept":"5-word note on the idea, for the operator","headline":"","subhead":null,"bullets":[],"cta":null,"attribution":null}]}

Give exactly ${count} candidates. Make them ${count} GENUINELY DIFFERENT arguments —
different entry points, not the same sentence reworded.`;
}

/**
 * Generate and validate copy candidates. Resolves to
 * { ok, candidates[], rejected[], error } and never throws.
 *
 * `candidates` are validated sets sorted best-first; `rejected` carries the
 * failures with their reasons so a caller (or an operator) can see WHY, rather
 * than a silent empty list.
 */
export async function generateCopySets({
  product = {}, angle = null, format = null, hook = '', proof = '', count = 3,
} = {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, candidates: [], rejected: [], error: 'ANTHROPIC_API_KEY missing' };
  }
  let parsed;
  try {
    const res = await anthropic.messages.create({
      model: COPY_MODEL,
      max_tokens: 2000,
      messages: [{ role: 'user', content: buildCopyPrompt({ product, angle, format, hook, proof, count }) }],
    });
    const raw = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  } catch (err) {
    console.error(`[staticsCopy] generation failed: ${err.message}`);
    return { ok: false, candidates: [], rejected: [], error: err.message };
  }

  const list = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
  const checked = list.map(c => enforceCopySet(c, { format, product, angle }));
  const candidates = checked.filter(r => r.ok)
    .map(r => ({ ...r, score: scoreCopySet(r) }))
    .sort((a, b) => b.score - a.score);
  const rejected = checked.filter(r => !r.ok).map(r => ({ set: r.set, problems: r.problems }));

  if (rejected.length) {
    console.log(`[staticsCopy] ${candidates.length}/${list.length} candidates passed; rejected: ` +
      rejected.map(r => r.problems[0]).join(' | '));
  }
  return { ok: candidates.length > 0, candidates, rejected, error: null };
}

/** Render a validated copy set as the exact text block the image model typesets. */
export function renderCopyForImage(set = {}) {
  const lines = ['THE EXACT TEXT TO SET ON THIS AD — render these strings verbatim,',
                 'spelled exactly as written. Do NOT add any other words, labels,',
                 'captions, badges or taglines beyond what is listed here.', ''];
  lines.push(`HEADLINE: "${set.headline}"`);
  if (set.subhead) lines.push(`SUB-LINE: "${set.subhead}"`);
  if (Array.isArray(set.bullets) && set.bullets.length) {
    lines.push('ROWS (one per line, in this order):');
    set.bullets.forEach(b => lines.push(`  - "${b}"`));
  }
  if (set.cta) lines.push(`CTA: "${set.cta}"`);
  if (set.attribution) lines.push(`ATTRIBUTION: "${set.attribution}"`);
  lines.push('');
  lines.push(`TOTAL WORDS ON THIS CARD: ${totalWords(set)}. Adding any word breaks the design.`);
  return lines.join('\n');
}
