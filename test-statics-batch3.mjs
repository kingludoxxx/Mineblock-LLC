#!/usr/bin/env node
// Batch 3: Post-fix test — same references as batch 1+2, compare results
const API_BASE = 'https://mineblock-dashboard.onrender.com/api/v1';
const fs = await import('fs');
const path = await import('path');
const outDir = '/Users/ludo/Mineblock-LLC/test-output';

async function login() {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@try-mineblock.com', password: 'MineblockAdmin2026!' }),
  });
  return (await res.json()).accessToken;
}

async function getProduct(token) {
  const res = await fetch(`${API_BASE}/product-profiles/3`, { headers: { Authorization: `Bearer ${token}` } });
  return (await res.json()).data;
}

async function generate(token, payload) {
  const res = await fetch(`${API_BASE}/statics-generation/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Generate ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function pollStatus(token, taskId) {
  const loginTime = Date.now();
  while (Date.now() - loginTime < 300000) {
    if (Date.now() - loginTime > 13 * 60 * 1000) token = await login();
    try {
      const res = await fetch(`${API_BASE}/statics-generation/status/${taskId}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.data?.status === 'completed') return data.data;
      if (data.data?.status === 'failed') throw new Error(`Failed: ${data.data?.error}`);
    } catch (e) {
      if (e.message.startsWith('Failed:')) throw e;
      // transient error, retry
    }
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('Timeout');
}

async function downloadImage(url, filename) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(path.join(outDir, filename), buf);
  console.log(`  Saved: ${filename} (${(buf.length/1024).toFixed(0)} KB)`);
}

function buildProfile(product) {
  const profile = {};
  const fields = { oneliner: 'oneliner', customer_avatar: 'customerAvatar', customer_frustration: 'customerFrustration',
    customer_dream: 'customerDream', big_promise: 'bigPromise', mechanism: 'mechanism', differentiator: 'differentiator',
    voice: 'voice', guarantee: 'guarantee', benefits: 'benefits', pain_points: 'painPoints',
    common_objections: 'commonObjections', winning_angles: 'winningAngles', competitive_edge: 'competitiveEdge',
    offer_details: 'offerDetails', max_discount: 'maxDiscount', discount_codes: 'discountCodes',
    bundle_variants: 'bundleVariants', compliance_restrictions: 'complianceRestrictions', notes: 'notes' };
  for (const [k, v] of Object.entries(fields)) {
    if (product[k]) profile[v] = product[k];
  }
  return profile;
}

async function main() {
  console.log('=== Batch 3: Post-Fix Test ===');
  console.log(`Time: ${new Date().toISOString()}\n`);

  let token = await login();
  const product = await getProduct(token);
  const profile = buildProfile(product);

  const productPayload = {
    id: product.id, name: product.name, description: product.description, price: product.price,
    profile, product_images: product.product_images || [], logos: product.logos || [],
    brand_colors: product.brand_colors || {}, fonts: product.fonts || [],
  };

  // Same references as before to compare
  const tests = [
    { ref: 'https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/3ADJaAVyHseGn0cKPzimGrRfRAY/DDWUqw../4408.webp', angle: 'Value Proposition', label: 'v2-test4-value-4408' },
    { ref: 'https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/mSuMIIFG0AtxhmNWNQQHdWBSuSk/a9uyFg../1598.webp', angle: 'Social Proof', label: 'v2-test2-social-1598' },
    { ref: 'https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/wUaXxuwXjSy7QrOuK88lh8urdV4/1K7dHA../1983.webp', angle: 'Social Proof', label: 'v2-test6-social-1983' },
    { ref: 'https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/DJ6lbSosi847hcS_hWlxrdUXEDA/RCSP2Q../3732.webp', angle: null, label: 'v2-test7-compare-3732' },
    { ref: 'https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/qoP-YXSUZLxCurLVpS5ahLhtpNE/1yGPUw../3865.webp', angle: 'Urgency/Scarcity', label: 'v2-test8-urgency-3865' },
  ];

  for (let i = 0; i < tests.length; i++) {
    const tc = tests[i];
    console.log(`\n--- Test ${i+1}/${tests.length}: ${tc.label} ---`);
    try {
      token = await login();
      const genResult = await generate(token, {
        reference_image_url: tc.ref, product: productPayload, angle: tc.angle, ratio: '4:5',
      });

      if (!genResult.success) { console.error('  ❌ Generate error:', genResult.error); continue; }

      const taskId = genResult.data?.tasks?.[0]?.taskId || genResult.data?.taskId;
      const analysis = genResult.data?.claudeAnalysis;
      const swapPairs = genResult.data?.swapPairs || [];

      console.log(`  TaskID: ${taskId}`);
      console.log(`  People: ${analysis?.people_count}, Logo: ${analysis?.has_competitor_logo}`);
      console.log(`  Swaps (${swapPairs.length}):`);
      swapPairs.forEach((sp, idx) => {
        const origLen = sp.original?.length || 0;
        const adaptLen = sp.adapted?.length || 0;
        const ratio = origLen > 0 ? Math.round(adaptLen / origLen * 100) : 0;
        console.log(`    ${idx+1}. [${sp.field}] (${origLen}→${adaptLen}, ${ratio}%) "${sp.adapted?.slice(0,50)}"`);
      });

      if (taskId) {
        console.log('  Polling...');
        token = await login();
        const status = await pollStatus(token, taskId);
        console.log(`\n  ✅ Done: ${status.resultImageUrl?.slice(0,80)}`);
        await downloadImage(status.resultImageUrl, `${tc.label}.png`);
      }
    } catch (err) {
      console.error(`  ❌ ${err.message}`);
    }
  }
  console.log('\n=== Batch 3 Complete ===');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
