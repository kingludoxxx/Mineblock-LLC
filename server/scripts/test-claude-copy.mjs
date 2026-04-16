#!/usr/bin/env node
/**
 * Claude-stage test harness for static-ad copy generation.
 *
 * Bypasses auth + Gemini + DB. Uses a hardcoded product (matching the
 * MineBlock profile shape that production sends) and a reference image URL,
 * then runs the REAL production prompt/model path so we can see what Claude
 * produces with the P0.1–P0.5 changes applied.
 *
 * Usage:
 *   node scripts/test-claude-copy.mjs ["angle"]                 # default: "Value Proposition"
 *   REFERENCE_URL=https://example.com/ad.jpg node scripts/test-claude-copy.mjs
 */

import fs from 'fs';
import path from 'path';

// ── Env loader (handles root .env and server/.env.testharness) ──
const candidates = ['.env.testharness', '.env', '../.env'];
for (const p of candidates) {
  try {
    const content = fs.readFileSync(p, 'utf8');
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[k]) process.env[k] = v;
    }
    console.log(`[env] loaded from ${path.resolve(p)}`);
    break;
  } catch {}
}

const { buildClaudePrompt, buildSwapPairs, buildNanoBananaPrompt } = await import('../src/utils/staticsPrompts.js');

const ANGLE = process.argv[2] || 'Value Proposition';
const REFERENCE_URL = process.env.REFERENCE_URL
  // A generic public ad image — any competitor bitcoin/mining ad would do.
  // This one is a DIRECT link to a product thumbnail; if it 404s, pass REFERENCE_URL.
  || 'https://images.unsplash.com/photo-1518544801976-3e159e50e5bb?w=1080';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_API_URL    = 'https://api.anthropic.com/v1/messages';
if (!ANTHROPIC_API_KEY) { console.error('Missing ANTHROPIC_API_KEY'); process.exit(1); }

// ── Hardcoded product matching the MineBlock case from the user's screenshot.
// Shape is what staticsGeneration.js receives from the React client:
//   { id, name, price, profile: { ... } }
const PRODUCT = {
  id: 3,
  name: 'MineBlock Solo Miner',
  price: '$249',
  profile: {
    shortName: 'MineBlock',
    category: 'Bitcoin solo mining device',
    targetAudience: 'Crypto hobbyists, passive-income seekers, retail miners',
    keyBenefits: [
      'Plug-and-play — no technical setup required',
      'Silent operation — runs in any home office',
      'Low power draw — ~30W from a standard wall outlet',
      'Solo mining — keep 100% of any block reward you find',
    ].join('\n'),
    uniqueSellingPoints: 'Only consumer device that lets you solo-mine Bitcoin without joining a pool',
    painPoints: 'Mining pools take fees; industrial miners are loud/expensive; cloud mining is a scam',
    offerDetails: 'FREE shipping worldwide + 2-year warranty + 30-day money-back guarantee',
    guarantee: '30-day money-back — return it if it doesn\'t mine',
    discountCodes: 'BITCOIN10',
    maxDiscount: '10% off',
    complianceRestrictions: 'Do not guarantee profits; do not claim specific BTC earnings; do not promise "passive income"',
    bundleVariants: '1 unit: $249 | 2-pack: $449 (save $49) | 3-pack: $629 (save $118)',
  },
};

function banner(s) { console.log('\n' + '═'.repeat(78) + '\n ' + s + '\n' + '═'.repeat(78)); }

async function main() {
  banner(`Test config`);
  console.log(`Product: ${PRODUCT.name}  price=${PRODUCT.price}`);
  console.log(`Angle:   ${ANGLE}`);
  console.log(`Ref URL: ${REFERENCE_URL}`);

  banner('Load reference image');
  let buf;
  if (REFERENCE_URL.startsWith('file://') || REFERENCE_URL.startsWith('/')) {
    const fp = REFERENCE_URL.replace(/^file:\/\//, '');
    buf = fs.readFileSync(fp);
    console.log(`Loaded from disk: ${fp}`);
  } else {
    const imgRes = await fetch(REFERENCE_URL);
    if (!imgRes.ok) throw new Error(`Fetch reference failed: ${imgRes.status}`);
    buf = Buffer.from(await imgRes.arrayBuffer());
  }
  const mediaType = buf[0] === 0xFF && buf[1] === 0xD8 ? 'image/jpeg'
                  : buf[0] === 0x89 && buf[1] === 0x50 ? 'image/png'
                  : buf[0] === 0x52 && buf[1] === 0x49 ? 'image/webp'
                  : 'image/jpeg';
  const base64 = buf.toString('base64');
  console.log(`Reference: ${buf.length} bytes, ${mediaType}`);

  banner('Build Claude prompt');
  const promptText = buildClaudePrompt(PRODUCT, ANGLE, null, null, null);
  console.log(`Prompt size: ${promptText.length} chars`);
  console.log('--- Prompt head (first 1500 chars) ---');
  console.log(promptText.slice(0, 1500));
  console.log('--- Prompt tail (last 600 chars) ---');
  console.log(promptText.slice(-600));

  banner('Call Claude (sonnet-4-6, temp=0.4, max_tokens=4000)');
  const t0 = Date.now();
  const claudeRes = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      temperature: 0.4,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: promptText },
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        ],
      }],
    }),
  });
  const elapsed = Date.now() - t0;
  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    throw new Error(`Claude ${claudeRes.status}: ${errText.slice(0, 500)}`);
  }
  const claudeData = await claudeRes.json();
  console.log(`Claude responded in ${elapsed}ms  usage=${JSON.stringify(claudeData.usage)}`);

  const rawText = claudeData.content?.[0]?.text || '';
  banner('Raw Claude text (first 4000 chars)');
  console.log(rawText.slice(0, 4000));

  banner('Parse JSON');
  let parsed;
  try {
    const jsonMatch = rawText.match(/```json\s*([\s\S]*?)```/) || rawText.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch?.[1] || jsonMatch?.[0] || rawText;
    parsed = JSON.parse(jsonStr.trim());
  } catch (e) {
    console.error('❌ JSON parse failed:', e.message);
    process.exit(1);
  }
  console.log('Parsed keys:', Object.keys(parsed).join(', '));
  if (parsed.original_text) console.log('\noriginal_text:\n' + JSON.stringify(parsed.original_text, null, 2));
  if (parsed.adapted_text)  console.log('\nadapted_text:\n'  + JSON.stringify(parsed.adapted_text, null, 2));

  banner('Build swap pairs (watches for leakage warnings)');
  const pairs = buildSwapPairs(parsed.original_text || {}, parsed.adapted_text || {}, PRODUCT.name);
  console.log(`\n${pairs.length} swap pairs:`);
  for (const p of pairs) console.log(`  [${p.field}]  "${p.original}"  →  "${p.adapted}"`);

  banner('Final Gemini prompt (what the image model actually sees)');
  try {
    const gemPrompt = buildNanoBananaPrompt(parsed, pairs, PRODUCT, 0, null, null, parsed.logo_background_tone);
    console.log(`Length: ${gemPrompt.length} chars\n`);
    console.log(gemPrompt);
  } catch (e) {
    console.error('buildNanoBananaPrompt failed:', e.message);
  }

  banner('Quality checks on adapted copy');
  const allAdapted = [];
  const collect = (v) => {
    if (!v) return;
    if (typeof v === 'string') allAdapted.push(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (typeof v === 'object') Object.values(v).forEach(collect);
  };
  collect(parsed.adapted_text);
  const allText = allAdapted.join(' | ');
  console.log('\nAll adapted strings joined:\n' + allText + '\n');

  const checks = [
    { name: 'Fabricated social-proof numbers',
      re: /\b\d{1,3}(,\d{3})*\s*\+?\s*(verified|customers?|users?|reviews?|ratings?|solo\s*miners?|happy|members?|subscribers?)\b/i },
    { name: 'Fabricated percentage/ratio stat',
      // Must be paired with a people-noun to count as social-proof fabrication.
      // "100% of every block reward" is a mathematical truth, not a fake stat.
      re: /\b(\d{1,3}%\*?\s+of\s+(participants|customers|users|people|adults|subjects|clients|members|buyers|owners|miners|respondents|surveyed)|\d+\s*(in|out of)\s*\d+\*?\s+(participants|customers|users|people|adults|subjects|clients|members|buyers|owners|miners))\b/i },
    { name: 'Fabricated study/retention disclaimer',
      re: /\*?\s*based on (a |an |customer |user |our )?(study|data|retention|survey|trial|clinical|adults|participants|subjects|owners|respondents)/i },
    { name: 'Star rating claims',
      re: /\d(\.\d)?\s*★|\d(\.\d)?\s*(stars?|out of 5)/i },
    { name: 'Month names',
      re: /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i },
    { name: 'Seasonal sale text',
      re: /\b(Spring|Summer|Autumn|Fall|Winter)\s+(Sale|Deal|Promo|Special)\b/i },
    { name: 'Emoji present',
      re: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u },
    { name: 'Possibly mid-word mixedCase (truncation artifact)',
      re: /\b[a-z]{1,3}[A-Z][a-z]/ },
    { name: 'Profit guarantee (compliance violation)',
      re: /\b(guaranteed profits?|guaranteed income|passive income|get rich|make \$\d)/i },
    { name: 'AI-tell crutch words',
      re: /\b(effortlessly|seamlessly|revolutioniz(e|ing|es)|revolutionary|game[- ]chang(er|ing)|elevate your|unleash|unlock your potential|transformative|leverage|empowering?|harness the power|your journey|cutting[- ]edge|state[- ]of[- ]the[- ]art|next[- ]level|delve into|embark on|meticulous(ly)?|intricate|tapestry|paradigm|holistic|bespoke|curated|immerse|ever[- ]evolving|at your fingertips|dive in(to)?|say goodbye to|hello to|power of [a-z]+|world of [a-z]+|realm of [a-z]+|embrace the|look no further)\b/i },
    { name: 'Vague benefit-speak',
      re: /\b(best[- ]in[- ]class|premium experience|top[- ]tier|industry[- ]leading|proven to work|unparalleled|unmatched|unrivaled|second to none)\b/i },
    { name: 'Fabricated BOGO / N-for-M / get-free offer (P3.1)',
      re: /\b(buy\s+\d+\s+get\s+\d+\s+free|buy\s+one\s+get\s+one|\bbogo\b|\b\d+\s+for\s+\d+\b|get\s+\d+\s+free|extra\s+\d+\s+free|free\s+\w+\s+with\s+(purchase|order|any)|\d+\s*\+\s*\d+\s+free)\b/i },
  ];
  for (const c of checks) {
    const m = allText.match(c.re);
    console.log(`  ${m ? '❌ HIT ' : '✅ PASS'} ${c.name}${m ? ' → "' + m[0] + '"' : ''}`);
  }

  // Cross-check any "FREE" or "Buy X Get Y" claim against the real product library
  const offerCtx = `${PRODUCT.profile.offerDetails || ''} ${PRODUCT.profile.bundleVariants || ''} ${PRODUCT.profile.discountCodes || ''} ${PRODUCT.profile.maxDiscount || ''}`.toLowerCase();
  const offerMatches = [...allText.matchAll(/\b(buy\s+\d+\s+get\s+\d+\s+free|buy\s+one\s+get\s+one|\d+\s+for\s+\d+|get\s+\d+\s+free|free\s+\w+\s+with\s+(?:purchase|order|any)|\d+\s*\+\s*\d+\s+free)\b/gi)];
  if (offerMatches.length > 0) {
    console.log('\n  Offer-construction reality check vs product library:');
    for (const m of offerMatches) {
      const phrase = m[0].toLowerCase();
      const inCtx = offerCtx.includes(phrase);
      console.log(`    ${inCtx ? '✅ CONFIRMED' : '❌ FABRICATED'} "${m[0]}"${inCtx ? '' : ' — not present in offerDetails/bundleVariants/discountCodes'}`);
    }
  }

  banner('Done');
}

main().catch(e => {
  console.error('\nFATAL:', e.stack || e.message);
  process.exit(1);
});
