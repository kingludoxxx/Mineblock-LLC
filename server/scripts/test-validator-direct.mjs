#!/usr/bin/env node
/**
 * Run the text validator directly against known-bad images to verify the
 * P0.4.1 upgrades catch what P0.4 missed. Bypasses the full pipeline.
 *
 * Usage: node server/scripts/test-validator-direct.mjs <image_path>
 */

import fs from 'fs';

// Load .env
try {
  const content = fs.readFileSync('.env', 'utf8');
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[k]) process.env[k] = v;
  }
} catch {}

const { validateGenerationText, summarizeTextValidation } = await import('../src/utils/generationTextValidator.js');

const PRODUCT = {
  id: 3,
  name: 'MineBlock Solo Miner',
  price: '$249',
  profile: {
    shortName: 'MineBlock',
    offerDetails: 'FREE shipping worldwide + 2-year warranty + 30-day money-back guarantee',
    discountCodes: 'BITCOIN10',
    maxDiscount: '10% off',
    guarantee: '30-day money-back — return it if it doesn\'t mine',
    bundleVariants: '1 unit: $249 | 2-pack: $449 (save $49) | 3-pack: $629 (save $118)',
  },
};

// Approximate of the adapted_text each of our test generations produced.
// The exact text isn't critical — the validator needs to catch issues
// IN THE IMAGE regardless of what the adapted_text was.
const ADAPTED_TEXT = {
  headline: 'WAS $249, NOW $224',
  body:    'Plug in. Mine Bitcoin. No pool fees. 30-day money-back. 2-year warranty.',
  cta:     'FREE SHIPPING + 2-YEAR WARRANTY',
  badges:  ['MineBlock', 'Code BITCOIN10'],
};

async function main() {
  const filePaths = process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : [
        '/tmp/test-generate-live-gen-9d0758b6-af1c-4ffa-89e6-ce3d8f34edeb.png',  // has "WORLWIDE"
        '/tmp/test-generate-live-gen-5a5355ad-aba6-4f6d-8f53-cccd7c86a60f.png',  // has "WAS $277" + "= 2-Yr"
      ];

  for (const fp of filePaths) {
    if (!fs.existsSync(fp)) { console.log(`SKIP (missing): ${fp}`); continue; }
    const buf = fs.readFileSync(fp);
    const mt = fp.endsWith('.jpg') || fp.endsWith('.jpeg') ? 'image/jpeg' : fp.endsWith('.webp') ? 'image/webp' : 'image/png';

    console.log('\n' + '═'.repeat(78));
    console.log(`Validating: ${fp}  (${buf.length} bytes, ${mt})`);
    console.log('═'.repeat(78));

    const t0 = Date.now();
    const v = await validateGenerationText(buf, mt, ADAPTED_TEXT, PRODUCT);
    const ms = Date.now() - t0;

    console.log(`\n  ${summarizeTextValidation(v)}`);
    console.log(`  severity:       ${v.severity}`);
    console.log(`  totalErrors:    ${v.totalErrors}`);
    console.log(`  hardErrorCount: ${v.hardErrorCount}`);
    console.log(`  elapsed:        ${ms}ms`);
    if (v.errors) {
      for (const [k, arr] of Object.entries(v.errors)) {
        if (Array.isArray(arr) && arr.length > 0) {
          console.log(`  ${k}:`);
          for (const e of arr) console.log(`    - ${typeof e === 'string' ? e : JSON.stringify(e)}`);
        }
      }
    }
  }
}

main().catch(err => { console.error('FATAL:', err.stack || err.message); process.exit(1); });
