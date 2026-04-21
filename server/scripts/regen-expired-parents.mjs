/**
 * Regenerates 5 parent creatives that have expired images via the production API.
 * No direct DB connection needed — uses API endpoints only.
 * Run: node server/scripts/regen-expired-parents.mjs
 */
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env') });

const API = 'https://mineblock-dashboard.onrender.com';
const ADMIN_EMAIL = process.env.SUPERADMIN_EMAIL || 'admin@try-mineblock.com';
const ADMIN_PASS  = process.env.SUPERADMIN_PASSWORD || 'MineblockAdmin2026!';

const TARGET_IDS = [
  'fcb2c190-3ca7-48d4-bf83-c8f9d4321269',
  '0e3f2231-3646-4a71-9160-e9576b1b2587',
  '55012f6b-5ab4-4f32-b800-a3880208a79d',
  '79b5c734-6500-4ef9-91be-83db239b722a',
  'd839722e-6805-49b3-8ed6-087564742169',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(path, jwt, opts = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  return res.json();
}

async function getJWT() {
  // Retry login up to 6 times to handle Render free-tier cold start (~30s spin-up)
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch(`${API}/api/v1/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASS }),
        signal: AbortSignal.timeout(20000),
      });
      const text = await res.text();
      let d;
      try { d = JSON.parse(text); } catch { throw new Error(`Non-JSON response: ${text.slice(0, 80)}`); }
      if (d.accessToken) return d.accessToken;
      throw new Error(`Login rejected: ${JSON.stringify(d)}`);
    } catch (err) {
      if (attempt < 6) {
        console.log(`  Login attempt ${attempt} failed (${err.message.slice(0, 60)}) — waiting 20s for server wake-up...`);
        await sleep(20000);
      } else {
        throw err;
      }
    }
  }
}

async function pollStatus(jwt, taskId, maxMin = 7) {
  const deadline = Date.now() + maxMin * 60_000;
  let i = 0;
  while (Date.now() < deadline) {
    await sleep(12000);
    const d = await api(`/statics-generation/status/${taskId}`, jwt);
    const st = d?.data?.status;
    const img = (d?.data?.resultImageUrl || '').slice(0, 70);
    console.log(`    poll ${++i}: ${st} ${img}`);
    if (st === 'completed') return d.data;
    if (st === 'failed')    throw new Error(d?.data?.error || 'failed');
  }
  throw new Error('timeout');
}

async function main() {
  console.log('Logging in...');
  const jwt = await getJWT();

  // Fetch all creatives and find our targets
  console.log('Fetching creative data from API...');
  // The endpoint paginates; fetch enough to get all
  const resp = await api('/statics-generation/creatives?limit=200', jwt);
  const all = resp.data || [];
  const targets = all.filter(c => TARGET_IDS.includes(c.id));
  console.log(`Found ${targets.length}/${TARGET_IDS.length} target creatives\n`);

  // Get product profile (id=3)
  const ppResp = await api('/product-profiles', jwt);
  const ppList = Array.isArray(ppResp) ? ppResp : (ppResp.data || [ppResp]);
  const product = ppList.find(p => p.id === 3) || ppList[0];
  if (!product) throw new Error('product_profiles id=3 not found');

  const productPayload = {
    name:  product.name,
    price: product.price,
    profile: {
      big_promise:   (product.big_promise   || '').slice(0, 400),
      mechanism:     (product.mechanism     || '').slice(0, 400),
      guarantee:     product.customer_guarantee || '30-day money-back',
      discount_code: product.discount_code  || null,
      free_shipping: true,
    },
    product_image_url: product.product_image_url || null,
  };
  console.log(`Product: "${product.name}" @ ${product.price}\n`);

  const results = [];

  for (const creative of targets) {
    console.log(`\n── ${creative.id} (${creative.angle || 'no-angle'}, ${creative.aspect_ratio}, status=${creative.status}) ──`);

    if (!creative.reference_thumbnail) {
      console.log('  SKIP: no reference_thumbnail');
      continue;
    }

    // Trigger generation with reference_thumbnail as reference image
    console.log('  Submitting to /generate...');
    const genResp = await api('/statics-generation/generate', jwt, {
      method: 'POST',
      body: JSON.stringify({
        reference_image_url: creative.reference_thumbnail,
        ratio: '4:5',
        angle: creative.angle || 'Urgency',
        product: productPayload,
      }),
    });

    if (!genResp.success) {
      console.error('  Generate failed:', JSON.stringify(genResp).slice(0, 200));
      continue;
    }

    const taskId = genResp.data?.taskId;
    console.log(`  taskId: ${taskId}`);

    // Poll to completion
    let result;
    try {
      result = await pollStatus(jwt, taskId);
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
      continue;
    }
    console.log(`  ✅ Image: ${(result.resultImageUrl || '').slice(0, 80)}`);

    // Save the generated creative to DB
    console.log('  Saving creative to DB...');
    const saveResp = await api('/statics-generation/creatives', jwt, {
      method: 'POST',
      body: JSON.stringify({
        product_id: creative.product_id || String(product.id),
        product_name: product.name,
        angle: creative.angle || 'Urgency',
        aspect_ratio: '4:5',
        image_url: result.resultImageUrl,
        reference_thumbnail: creative.reference_thumbnail,
        reference_name: creative.reference_name || null,
        status: 'review',
        pipeline: 'standard',
        source_label: 'template',
      }),
    });

    if (!saveResp.success || !saveResp.data?.id) {
      console.error('  Save failed:', JSON.stringify(saveResp).slice(0, 200));
      continue;
    }
    const newCreative = saveResp.data;
    console.log(`  New creative ID: ${newCreative.id}`);

    // Approve → auto-triggers 9:16 variant
    const approveResp = await api(`/statics-generation/creatives/${newCreative.id}/status`, jwt, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'approved' }),
    });
    const newStatus = approveResp?.data?.status || approveResp?.status;
    console.log(`  Approved → ${newStatus}`);

    results.push({ srcId: creative.id, newId: newCreative.id, imageUrl: result.resultImageUrl });

    if (targets.indexOf(creative) < targets.length - 1) {
      console.log('  Waiting 8s before next...');
      await sleep(8000);
    }
  }

  console.log('\n══════════════ SUMMARY ══════════════');
  for (const r of results) {
    console.log(`${r.srcId} → ${r.newId}`);
    console.log(`  image: ${(r.imageUrl || '').slice(0, 80)}`);
  }
  console.log(`\n${results.length}/${targets.length} regenerated and approved. 9:16 variants now auto-triggering.`);
  process.exit(0);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
