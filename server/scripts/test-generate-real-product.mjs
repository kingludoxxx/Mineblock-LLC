#!/usr/bin/env node
/**
 * Run a live generation using the REAL Miner Forge Pro product profile
 * from the library (with its real image), to see if the product-swap
 * actually works when Gemini is given the real product image.
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

async function main() {
  const loginRes = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.SUPERADMIN_EMAIL, password: process.env.SUPERADMIN_PASSWORD }),
  });
  const { accessToken } = await loginRes.json();
  const AUTH = { Authorization: `Bearer ${accessToken}` };

  // Fetch the real product profile
  const profRes = await fetch(`${BASE}/api/v1/product-profiles`, { headers: AUTH });
  const profData = await profRes.json();
  const profile = (profData.data || profData.profiles || [])[0];
  if (!profile) throw new Error('No product profile found');

  console.log(`Product profile loaded: ${profile.name}`);
  console.log(`Profile fields: ${Object.keys(profile).join(', ')}`);

  // Build the product object the /generate endpoint expects
  // first_image is a JSON-encoded array of base64 data URIs
  let productImageUrl = null;
  try {
    const imgs = typeof profile.first_image === 'string'
      ? JSON.parse(profile.first_image)
      : profile.first_image;
    if (Array.isArray(imgs) && imgs.length > 0) productImageUrl = imgs[0];
  } catch {}

  console.log(`Product image: ${productImageUrl ? productImageUrl.slice(0, 60) + '...' : 'NONE'} (length: ${productImageUrl?.length || 0})`);

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

  // Pick a known-good template
  const tplRes = await fetch(`${BASE}/api/v1/statics-templates?category=Offer%2FSale&limit=100`, { headers: AUTH });
  const tplData = await tplRes.json();
  const items = (tplData.data || []).filter(t => t.name?.startsWith('Offer/Sale - '));
  const tpl = items[0];
  console.log(`Template: ${tpl.name} (${tpl.id})`);

  // Submit
  const t0 = Date.now();
  const submitRes = await fetch(`${BASE}/api/v1/statics-generation/generate`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reference_image_url: tpl.image_url,
      product,
      angle: 'Offer',
      ratio: '4:5',
      template_id: tpl.id,
    }),
  });
  const submitData = await submitRes.json();
  const taskId = submitData.data?.taskId;
  if (!taskId) throw new Error(`No taskId: ${JSON.stringify(submitData)}`);
  console.log(`Submitted: ${taskId}`);

  // Poll
  for (let i = 0; i < 180; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const s = await fetch(`${BASE}/api/v1/statics-generation/status/${taskId}`, { headers: AUTH });
    const sd = await s.json();
    const data = sd.data || {};
    console.log(`  [t+${Math.round((Date.now() - t0) / 1000)}s] ${data.status}${data.progress ? ' — ' + data.progress : ''}`);
    if (data.status === 'completed' || data.status === 'failed') {
      console.log(`\nFINAL: ${JSON.stringify({
        status: data.status,
        resultImageUrl: data.resultImageUrl,
        textValidation: data.textValidation,
        quality_warning: data.quality_warning,
      }, null, 2)}`);

      if (data.resultImageUrl) {
        const imgRes = await fetch(data.resultImageUrl);
        if (imgRes.ok) {
          const buf = Buffer.from(await imgRes.arrayBuffer());
          const outPath = `/tmp/real-product-${taskId}.png`;
          fs.writeFileSync(outPath, buf);
          console.log(`\nSaved: ${outPath}  (${buf.length} bytes)`);
        }
      }
      break;
    }
  }
}

main().catch(err => { console.error('FATAL:', err.stack || err.message); process.exit(1); });
