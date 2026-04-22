#!/usr/bin/env node
// Phase A — iteration prompt sanity test.
// Sends the iteration prompt to Claude for a known winning static ad (IM115)
// and validates the returned JSON shape and constraints.
//
// Usage: node server/scripts/test-iteration-prompt.mjs
//
// Requires: ANTHROPIC_API_KEY env var (loaded from server/.env.testharness if present).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIterationPrompt } from '../src/utils/staticsPrompts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load testharness env
const envPath = path.resolve(__dirname, '../.env.testharness');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) { console.error('ANTHROPIC_API_KEY missing'); process.exit(1); }

// Hard-coded IM115 winner data (confirmed via /creative-analysis/active)
const winner = {
  creative_id: 'IM115',
  ad_name: 'IM115 - V3 - NN - NA - Ret - Scarcity - MoneySeeker - Lottery - IMG - Ludovico - 9x16 - Ali - WK10_2026.jpg',
  spend: 68.15,
  roas: 11.72,
  cpa: 68.15,
  ctr: 3.20,
  angle: 'Lottery',
  avatar: 'Scarcity',
  week: 'WK10_2026',
};

// Download the thumbnail
const thumbUrl = 'https://scontent-iad3-1.xx.fbcdn.net/v/t45.1600-4/650113923_1610531726660320_7662779825895717191_n.png?_nc_cat=101&ccb=1-7&_nc_ohc=VslX73Ocu6EQ7kNvwGL7uA7&_nc_oc=AdqBJ1m0fEPFWnfLejRvWhWFjyU8zljL1a3F6NUkAl2oq9UJvxX94D3fhcSRcnWXt-o&_nc_zt=1&_nc_ht=scontent-iad3-1.xx&edm=AOgd6ZUEAAAA&_nc_gid=TmoVbzbnHKMfztZCfN0J7Q&_nc_tpa=Q5bMBQGCNmOYP2hl3pbPbkdxzjDIKJaAoGd5IqX61ufXz-YCcY1HRX4MtIiWquKXb01vxZj_z6jz9lRIVw&stp=c0.5000x0.5000f_dst-emg0_p720x720_q75_tt6&ur=52f3c4&_nc_sid=58080a&oh=00_Af3SY9-Jkjp5DxwEp8jg-CmDtvG7etFtlUeqj5UViR0_QQ&oe=69EE967E';

console.log('📥 Downloading IM115 thumbnail...');
const imgRes = await fetch(thumbUrl);
if (!imgRes.ok) {
  console.error(`Thumbnail download failed: ${imgRes.status}`);
  process.exit(1);
}
const imgBuf = Buffer.from(await imgRes.arrayBuffer());
const mediaType = imgRes.headers.get('content-type') || 'image/png';
const base64 = imgBuf.toString('base64');
console.log(`   ${imgBuf.length} bytes, ${mediaType}`);

// Product profile — hard-coded minimal subset of Miner Forge Pro's full profile
// (mirroring the real payload the server would send)
const product = {
  name: 'Miner Forge Pro',
  price: '$59.99',
  profile: {
    discountCodes: 'MINER10',
    maxDiscount: '58% — never exceed this',
    bundleVariants: '1 Miner = $59.99\n2 Miners = $55 each\n3 Miners get 1 free = $45 each',
    guarantee: '90-day money back guarantee. Lifetime warranty.',
    mechanism: 'MinerForge Pro is the only home Bitcoin miner that attempts to win the full block reward solo instead of splitting it with a pool.',
    bigPromise: 'For $59.99 and about a dollar a year in electricity, 144 daily shots at winning a full Bitcoin block worth around $300,000.',
    differentiator: 'Only home miner that attempts the full block reward solo',
    winningAngles: '1. Someone won a block. Real person. Real amount. Blockchain verified.\n2. Competitor callout. Other devices generate pennies via pools.\n3. Lottery angle. Daily shots at a $300K block.',
    painPoints: 'They feel like Bitcoin passed them by. Frustrated by crypto complexity.',
    voice: 'Direct, conversational, honest. Speaks like a friend who knows crypto.',
    complianceRestrictions: 'Never say "win Bitcoin" or "win BTC" as a direct promise or guaranteed outcome. Always frame as an attempt or chance.',
  },
};

// Build the prompt
const N = 3;
const prompt = buildIterationPrompt(winner, product, N);
console.log(`\n📝 Prompt length: ${prompt.length} chars`);

// Send to Claude
console.log(`\n🧠 Calling Claude (claude-sonnet-4-6)...`);
const t0 = Date.now();
const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'x-api-key': KEY,
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
        { type: 'text', text: prompt },
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
      ],
    }],
  }),
});
if (!claudeRes.ok) {
  console.error(`Claude error ${claudeRes.status}: ${await claudeRes.text()}`);
  process.exit(1);
}
const claudeData = await claudeRes.json();
console.log(`   Done in ${Date.now() - t0}ms`);

const raw = claudeData.content?.[0]?.text || '';
console.log(`\n📄 Raw response (${raw.length} chars):\n${raw.slice(0, 500)}${raw.length > 500 ? '...[truncated]' : ''}`);

// Parse JSON
const jsonMatch = raw.match(/\{[\s\S]*\}/);
if (!jsonMatch) {
  console.error('❌ No JSON found in response');
  process.exit(1);
}
let result;
try {
  result = JSON.parse(jsonMatch[0]);
} catch (e) {
  console.error('❌ JSON parse error:', e.message);
  console.error('Raw JSON:', jsonMatch[0].slice(0, 1000));
  process.exit(1);
}

// Assertions
console.log('\n🔍 Validating output shape...');
let failed = [];
const check = (cond, msg) => { if (!cond) { failed.push(msg); console.log(`   ❌ ${msg}`); } else { console.log(`   ✓ ${msg}`); } };

check(result.analysis && typeof result.analysis === 'object', 'has analysis object');
check(result.analysis?.works_because, 'analysis.works_because present');
check(Array.isArray(result.analysis?.load_bearing_elements) && result.analysis.load_bearing_elements.length > 0, 'analysis.load_bearing_elements non-empty');
check(Array.isArray(result.analysis?.safe_to_vary), 'analysis.safe_to_vary is array');
check(result.analysis?.extracted_text, 'analysis.extracted_text present');
check(result.analysis?.visual_summary, 'analysis.visual_summary present');

check(Array.isArray(result.variations), 'variations is array');
check(result.variations?.length === N, `variations.length === ${N}`);

const allowedCategories = new Set(['visual-refresh', 'hook-swap', 'angle-variant', 'product-orientation', 'badge-restyle']);
const categoriesUsed = new Set();
for (let i = 0; i < (result.variations?.length || 0); i++) {
  const v = result.variations[i];
  check(v.variation_id != null, `variation[${i}].variation_id present`);
  check(allowedCategories.has(v.change_category), `variation[${i}].change_category is valid (got: ${v.change_category})`);
  check(v.change && typeof v.change === 'string', `variation[${i}].change is string`);
  check(Array.isArray(v.preserved) && v.preserved.length > 0, `variation[${i}].preserved non-empty`);
  check(v.modified && typeof v.modified === 'object', `variation[${i}].modified is object`);
  check(v.rationale && typeof v.rationale === 'string', `variation[${i}].rationale is string`);
  categoriesUsed.add(v.change_category);
}
check(categoriesUsed.size === (result.variations?.length || 0), `all ${N} variations use DIFFERENT categories (got ${categoriesUsed.size} unique)`);

console.log('\n📊 Analysis preview:');
console.log(`   works_because: ${result.analysis?.works_because}`);
console.log(`   load_bearing:   ${JSON.stringify(result.analysis?.load_bearing_elements)}`);
console.log(`   safe_to_vary:   ${JSON.stringify(result.analysis?.safe_to_vary)}`);
console.log(`   extracted_text: ${JSON.stringify(result.analysis?.extracted_text)}`);

console.log('\n🎨 Variations:');
for (const v of (result.variations || [])) {
  console.log(`\n   [${v.variation_id}] ${v.change_category}`);
  console.log(`       change:    ${v.change}`);
  console.log(`       rationale: ${v.rationale}`);
  console.log(`       modified:  ${JSON.stringify(v.modified)}`);
  console.log(`       preserved: ${JSON.stringify(v.preserved).slice(0, 300)}`);
}

// Cross-check: every load_bearing element must appear in every variation's preserved list
console.log('\n🔒 Load-bearing consistency check:');
const lb = result.analysis?.load_bearing_elements || [];
for (const v of (result.variations || [])) {
  const preservedStr = JSON.stringify(v.preserved).toLowerCase();
  const missing = lb.filter(elem => {
    const lbStr = (typeof elem === 'string' ? elem : JSON.stringify(elem)).toLowerCase();
    // fuzzy contains — each load-bearing concept should appear somewhere in the preserved strings
    // We just check if any preserved item shares a meaningful substring with the load-bearing item
    return !v.preserved.some(p => {
      const pStr = (typeof p === 'string' ? p : JSON.stringify(p)).toLowerCase();
      return pStr.includes(lbStr.slice(0, Math.min(20, lbStr.length - 1))) ||
             lbStr.includes(pStr.slice(0, Math.min(20, pStr.length - 1)));
    });
  });
  if (missing.length > 0) {
    console.log(`   ⚠️  variation ${v.variation_id}: load-bearing NOT explicitly preserved: ${JSON.stringify(missing)}`);
  } else {
    console.log(`   ✓  variation ${v.variation_id}: all load-bearing elements preserved`);
  }
}

console.log(`\n${'='.repeat(60)}`);
if (failed.length === 0) {
  console.log('✅ Phase A PASSED — prompt produces valid structured output');
  fs.writeFileSync('/tmp/iteration-prompt-result.json', JSON.stringify(result, null, 2));
  console.log('   Full result saved to /tmp/iteration-prompt-result.json');
} else {
  console.log(`❌ Phase A FAILED — ${failed.length} checks failed`);
  for (const f of failed) console.log(`   - ${f}`);
  process.exit(1);
}
