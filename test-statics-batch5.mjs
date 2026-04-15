#!/usr/bin/env node
// Batch 5: After reducing MAX_SWAP_PAIRS to 7, adding similarity filter,
// complete-thought rule, and anti-reference-bleed rule
const API_BASE = 'https://mineblock-dashboard.onrender.com/api/v1';
const fs = await import('fs');
const path = await import('path');
const outDir = '/Users/ludo/Mineblock-LLC/test-output';

async function login() {
  const res = await fetch(`${API_BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@try-mineblock.com', password: 'MineblockAdmin2026!' }) });
  return (await res.json()).accessToken;
}
async function getProduct(token) {
  const res = await fetch(`${API_BASE}/product-profiles/3`, { headers: { Authorization: `Bearer ${token}` } });
  return (await res.json()).data;
}
async function generate(token, payload) {
  const res = await fetch(`${API_BASE}/statics-generation/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`Generate ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}
async function pollStatus(token, taskId) {
  const start = Date.now();
  while (Date.now() - start < 300000) {
    if (Date.now() - start > 13*60*1000) token = await login();
    try {
      const res = await fetch(`${API_BASE}/statics-generation/status/${taskId}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.data?.status === 'completed') return data.data;
      if (data.data?.status === 'failed') throw new Error(`Failed: ${data.data?.error}`);
    } catch(e) { if(e.message.startsWith('Failed:')) throw e; }
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('Timeout');
}
async function downloadImage(url, filename) {
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(path.join(outDir, filename), buf);
  console.log(`  Saved: ${filename} (${(buf.length/1024).toFixed(0)} KB)`);
}
function buildProfile(p) {
  const profile = {};
  const m = { oneliner:'oneliner',customer_avatar:'customerAvatar',customer_frustration:'customerFrustration',customer_dream:'customerDream',big_promise:'bigPromise',mechanism:'mechanism',differentiator:'differentiator',voice:'voice',guarantee:'guarantee',benefits:'benefits',pain_points:'painPoints',common_objections:'commonObjections',winning_angles:'winningAngles',competitive_edge:'competitiveEdge',offer_details:'offerDetails',max_discount:'maxDiscount',discount_codes:'discountCodes',bundle_variants:'bundleVariants',compliance_restrictions:'complianceRestrictions',notes:'notes' };
  for (const [k,v] of Object.entries(m)) if(p[k]) profile[v]=p[k];
  return profile;
}

async function main() {
  console.log('=== Batch 5: Reduced Swaps + Complete Thoughts + Anti-Bleed ===\n');
  let token = await login();
  const product = await getProduct(token);
  const pp = { id:product.id, name:product.name, description:product.description, price:product.price, profile:buildProfile(product), product_images:product.product_images||[], logos:product.logos||[], brand_colors:product.brand_colors||{}, fonts:product.fonts||[] };

  const tests = [
    // Re-test the worst performers from Batch 4
    { ref: 'https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/DJ6lbSosi847hcS_hWlxrdUXEDA/RCSP2Q../3732.webp', angle: null, label: 'v4-test7-compare-3732' },
    { ref: 'https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/qjSNJhugKkGnlYCejvPjfP46s4A/ejc7Cg../4361.webp', angle: 'Curiosity', label: 'v4-test9-curiosity-4361' },
    // Re-test Trustpilot (incomplete sentences issue)
    { ref: 'https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/wUaXxuwXjSy7QrOuK88lh8urdV4/1K7dHA../1983.webp', angle: 'Social Proof', label: 'v4-test6-social-1983' },
    // Re-test the best performer (should stay great)
    { ref: 'https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/5GJqQNh56CWQYjGpdotizxTqhug/0pgzUg../4545.webp', angle: 'Social Proof', label: 'v4-test10-social-4545' },
    // New reference — simple layout
    { ref: 'https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/mSuMIIFG0AtxhmNWNQQHdWBSuSk/a9uyFg../1598.webp', angle: 'Value Proposition', label: 'v4-test2-value-1598' },
  ];

  for (let i = 0; i < tests.length; i++) {
    const tc = tests[i];
    console.log(`\n--- Test ${i+1}/${tests.length}: ${tc.label} ---`);
    try {
      token = await login();
      const g = await generate(token, { reference_image_url: tc.ref, product: pp, angle: tc.angle, ratio: '4:5' });
      if (!g.success) { console.error('  ❌', g.error); continue; }
      const taskId = g.data?.tasks?.[0]?.taskId || g.data?.taskId;
      const sp = g.data?.swapPairs || [];
      console.log(`  TaskID: ${taskId} | Swaps: ${sp.length}`);
      sp.forEach((s,idx) => console.log(`    ${idx+1}. (${s.original?.length}→${s.adapted?.length}) "${s.adapted?.slice(0,50)}"`));
      if (taskId) {
        console.log('  Polling...');
        token = await login();
        const st = await pollStatus(token, taskId);
        console.log(`\n  ✅ Done`);
        await downloadImage(st.resultImageUrl, `${tc.label}.png`);
      }
    } catch (err) { console.error(`  ❌ ${err.message}`); }
  }
  console.log('\n=== Batch 5 Complete ===');
}
main().catch(e => { console.error('FATAL:', e); process.exit(1); });
