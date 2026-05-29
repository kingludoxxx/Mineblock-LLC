#!/usr/bin/env node
/**
 * Final-assessment batch: uses the REAL product library profile (not a
 * placeholder), runs N generations sequentially, produces a summary table.
 *
 * Usage: node server/scripts/test-generate-real-batch.mjs [N] [startIndex]
 */
import fs from 'fs';
try {
  const content = fs.readFileSync('.env', 'utf8');
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('='); if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[k]) process.env[k] = v;
  }
} catch {}

const BASE = 'https://mineblock-dashboard.onrender.com';
const N = parseInt(process.argv[2] || '5', 10);
const START = parseInt(process.argv[3] || '40', 10);

async function main() {
  const { accessToken } = await (await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.SUPERADMIN_EMAIL, password: process.env.SUPERADMIN_PASSWORD }),
  })).json();
  const AUTH = { Authorization: `Bearer ${accessToken}` };

  // Real product profile
  const profile = ((await (await fetch(`${BASE}/api/v1/product-profiles`, { headers: AUTH })).json()).data || [])[0];
  if (!profile) throw new Error('no product profile');
  let productImageUrl = null;
  try {
    const imgs = typeof profile.first_image === 'string' ? JSON.parse(profile.first_image) : profile.first_image;
    if (Array.isArray(imgs) && imgs.length > 0) productImageUrl = imgs[0];
  } catch {}

  const product = {
    id: profile.id,
    name: profile.name || 'Miner Forge Pro',
    price: profile.price || '$249',
    product_image_url: productImageUrl,
    profile: {
      shortName: profile.short_name || 'MineBlock',
      category: profile.category || 'Bitcoin solo mining device',
      targetAudience: profile.target_audience,
      keyBenefits: profile.key_benefits,
      uniqueSellingPoints: profile.unique_selling_points,
      painPoints: profile.pain_points,
      offerDetails: profile.offer_details || 'FREE shipping worldwide + 2-year warranty + 30-day money-back guarantee',
      guarantee: profile.guarantee,
      discountCodes: profile.discount_codes || 'BITCOIN10',
      maxDiscount: profile.max_discount || '10% off',
      bundleVariants: profile.bundle_variants,
    },
  };
  console.log(`Product: ${product.name} | Price: ${product.price} | Image: ${productImageUrl ? 'YES' : 'NO'}`);

  // Templates
  const items = ((await (await fetch(`${BASE}/api/v1/statics-templates?category=Offer%2FSale&limit=300`, { headers: AUTH })).json()).data || [])
    .filter(t => t.name?.startsWith('Offer/Sale - '))
    .slice(START, START + N);
  console.log(`Picked ${items.length} templates (from index ${START})\n`);

  const results = [];
  for (let i = 0; i < items.length; i++) {
    const tpl = items[i];
    console.log(`${'═'.repeat(78)}\n[${i + 1}/${items.length}] ${tpl.name?.slice(0, 65)}\n${'═'.repeat(78)}`);
    const t0 = Date.now();
    const submit = await (await fetch(`${BASE}/api/v1/statics-generation/generate`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference_image_url: tpl.image_url, product, angle: 'Offer', ratio: '4:5', template_id: tpl.id }),
    })).json();
    const taskId = submit.data?.taskId;
    if (!taskId) { console.log(`❌ submit failed`); continue; }

    let data = null;
    for (let p = 0; p < 180; p++) {
      await new Promise(r => setTimeout(r, 5000));
      const sd = (await (await fetch(`${BASE}/api/v1/statics-generation/status/${taskId}`, { headers: AUTH })).json()).data || {};
      if (sd.status === 'completed' || sd.status === 'failed') { data = sd; break; }
    }
    if (!data) { console.log(`❌ timeout`); continue; }

    const v = data.textValidation;
    const badge = v?.severity === 'clean' ? '✅ CLEAN' : v?.severity === 'soft' ? '⚠️  SOFT' : v?.severity === 'hard' ? '❌ HARD' : '❓';
    console.log(`  ${badge}  attempts=${v?.attempts}  elapsed=${((Date.now()-t0)/1000).toFixed(1)}s  taskId=${taskId}`);
    if (v?.errors) {
      for (const [k, arr] of Object.entries(v.errors)) {
        if (arr?.length > 0) {
          console.log(`    ${k}:`);
          arr.forEach(e => console.log(`      - ${typeof e === 'string' ? e : JSON.stringify(e)}`));
        }
      }
    }

    if (data.resultImageUrl) {
      try {
        const buf = Buffer.from(await (await fetch(data.resultImageUrl)).arrayBuffer());
        const outPath = `/tmp/real-batch-${String(i).padStart(2, '0')}-${taskId}.png`;
        fs.writeFileSync(outPath, buf);
        console.log(`  saved: ${outPath}`);
      } catch {}
    }
    results.push({ tpl, v, taskId });
  }

  console.log(`\n${'═'.repeat(78)}\n FINAL SUMMARY\n${'═'.repeat(78)}`);
  const clean = results.filter(r => r.v?.severity === 'clean').length;
  const soft  = results.filter(r => r.v?.severity === 'soft').length;
  const hard  = results.filter(r => r.v?.severity === 'hard').length;
  console.log(`  Clean:  ${clean} / ${items.length}  (${Math.round(100*clean/items.length)}%)`);
  console.log(`  Soft:   ${soft}`);
  console.log(`  Hard:   ${hard}`);

  const agg = {};
  results.forEach(r => { if (r.v?.errors) Object.entries(r.v.errors).forEach(([k, a]) => { if (a?.length) agg[k] = (agg[k]||0) + a.length; }); });
  if (Object.keys(agg).length) {
    console.log('\n  Error categories across batch:');
    Object.entries(agg).sort((a,b) => b[1]-a[1]).forEach(([k, n]) => console.log(`    ${n}×  ${k}`));
  }
}

main().catch(e => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
