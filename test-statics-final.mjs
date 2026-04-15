#!/usr/bin/env node
// Final Gemini Test — verify retry logic, bleed-through fix, and overall quality
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
  if (!res.ok) throw new Error(`Generate ${res.status}: ${(await res.text()).slice(0, 500)}`);
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
    await new Promise(r => setTimeout(r, 3000));
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
  console.log('=== FINAL GEMINI TEST — Retry + Bleed Fix Verification ===');
  console.log(`Time: ${new Date().toISOString()}\n`);
  let token = await login();
  const product = await getProduct(token);
  const pp = { id:product.id, name:product.name, description:product.description, price:product.price, profile:buildProfile(product), product_images:product.product_images||[], logos:product.logos||[], brand_colors:product.brand_colors||{}, fonts:product.fonts||[] };

  const tests = [
    // Comparison template — previously had "hair regrowth" bleed. Run 3 times to verify consistency.
    { ref: 'https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/DJ6lbSosi847hcS_hWlxrdUXEDA/RCSP2Q../3732.webp', angle: 'Value Proposition', label: 'final-compare-v1' },
    { ref: 'https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/DJ6lbSosi847hcS_hWlxrdUXEDA/RCSP2Q../3732.webp', angle: 'Curiosity', label: 'final-compare-v2' },
    { ref: 'https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/DJ6lbSosi847hcS_hWlxrdUXEDA/RCSP2Q../3732.webp', angle: null, label: 'final-compare-v3' },
    // Stack promo — consistent high performer
    { ref: 'https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/5GJqQNh56CWQYjGpdotizxTqhug/0pgzUg../4545.webp', angle: 'Value Proposition', label: 'final-stack-value' },
    // Trustpilot — mid-complexity
    { ref: 'https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/wUaXxuwXjSy7QrOuK88lh8urdV4/1K7dHA../1983.webp', angle: 'Curiosity', label: 'final-trustpilot-curiosity' },
    // Mars hero — 9:16 ratio test
    { ref: 'https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/qjSNJhugKkGnlYCejvPjfP46s4A/ejc7Cg../4361.webp', angle: 'Social Proof', label: 'final-mars-9x16', ratio: '9:16' },
  ];

  let successCount = 0;
  let geminiCount = 0;

  for (let i = 0; i < tests.length; i++) {
    const tc = tests[i];
    console.log(`\n--- Test ${i+1}/${tests.length}: ${tc.label} ---`);
    const startTime = Date.now();
    try {
      token = await login();
      const payload = { reference_image_url: tc.ref, product: pp, angle: tc.angle, ratio: tc.ratio || '4:5' };
      const g = await generate(token, payload);
      if (!g.success) { console.error('  ❌', g.error); continue; }
      const provider = g.data?.provider || 'unknown';
      const model = g.data?.model || 'unknown';
      console.log(`  Provider: ${provider} | Model: ${model}`);
      if (provider === 'gemini') geminiCount++;
      const taskId = g.data?.tasks?.[0]?.taskId || g.data?.taskId;
      const sp = g.data?.swapPairs || [];
      console.log(`  TaskID: ${taskId} | Swaps: ${sp.length}`);
      sp.slice(0,5).forEach((s,idx) => console.log(`    ${idx+1}. [${s.field}] "${s.adapted?.slice(0,50)}"`));
      if (sp.length > 5) console.log(`    ... and ${sp.length-5} more`);

      // Check for reference bleed in swap pairs
      const bleedWords = ['hair', 'regrowth', 'DHT', 'shedding', 'follicle', 'scalp', 'thinning'];
      const allAdapted = sp.map(s => s.adapted || '').join(' ').toLowerCase();
      const bleeds = bleedWords.filter(w => allAdapted.includes(w.toLowerCase()));
      if (bleeds.length > 0) {
        console.error(`  ⚠️ REFERENCE BLEED DETECTED: ${bleeds.join(', ')}`);
      } else {
        console.log('  ✅ No reference bleed detected in swap pairs');
      }

      if (taskId) {
        console.log('  Polling...');
        token = await login();
        const st = await pollStatus(token, taskId);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\n  ✅ Done in ${elapsed}s`);
        await downloadImage(st.resultImageUrl, `${tc.label}.png`);
        successCount++;
      }
    } catch (err) { console.error(`  ❌ ${err.message.slice(0, 300)}`); }

    // Small delay between tests to avoid rate limiting
    if (i < tests.length - 1) {
      console.log('  (waiting 5s between tests...)');
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  console.log(`\n=== FINAL TEST Complete: ${successCount}/${tests.length} succeeded, ${geminiCount} via Gemini ===`);
}
main().catch(e => { console.error('FATAL:', e); process.exit(1); });
