#!/usr/bin/env node
// Test: Gemini 3.1 Flash Image vs NanoBanana — same references, side by side
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
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Generate ${res.status}: ${errText.slice(0, 500)}`);
  }
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
  console.log('=== GEMINI 3.1 FLASH IMAGE TEST ===');
  console.log(`Time: ${new Date().toISOString()}\n`);
  let token = await login();
  const product = await getProduct(token);
  const pp = { id:product.id, name:product.name, description:product.description, price:product.price, profile:buildProfile(product), product_images:product.product_images||[], logos:product.logos||[], brand_colors:product.brand_colors||{}, fonts:product.fonts||[] };

  const tests = [
    // Simple promo — was 9/10 with NanoBanana
    { ref: 'https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/5GJqQNh56CWQYjGpdotizxTqhug/0pgzUg../4545.webp', angle: 'Social Proof', label: 'gemini-stack-4545', type: 'simple' },
    // Trustpilot — was 6-7/10
    { ref: 'https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/wUaXxuwXjSy7QrOuK88lh8urdV4/1K7dHA../1983.webp', angle: 'Social Proof', label: 'gemini-trustpilot-1983', type: 'medium' },
    // Notes layout — was 6-7/10
    { ref: 'https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/3ADJaAVyHseGn0cKPzimGrRfRAY/DDWUqw../4408.webp', angle: 'Value Proposition', label: 'gemini-notes-4408', type: 'medium' },
    // Stat layout — was 7/10
    { ref: 'https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/mSuMIIFG0AtxhmNWNQQHdWBSuSk/a9uyFg../1598.webp', angle: 'Value Proposition', label: 'gemini-stat-1598', type: 'simple' },
    // Comparison — was 4/10 (hardest test)
    { ref: 'https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/DJ6lbSosi847hcS_hWlxrdUXEDA/RCSP2Q../3732.webp', angle: null, label: 'gemini-compare-3732', type: 'complex' },
  ];

  for (let i = 0; i < tests.length; i++) {
    const tc = tests[i];
    console.log(`\n--- Test ${i+1}/${tests.length}: ${tc.label} (${tc.type}) ---`);
    const startTime = Date.now();
    try {
      token = await login();
      const g = await generate(token, { reference_image_url: tc.ref, product: pp, angle: tc.angle, ratio: '4:5' });
      if (!g.success) { console.error('  ❌', g.error); continue; }
      const provider = g.data?.provider || 'unknown';
      const model = g.data?.model || 'unknown';
      console.log(`  Provider: ${provider} | Model: ${model}`);
      const taskId = g.data?.tasks?.[0]?.taskId || g.data?.taskId;
      const sp = g.data?.swapPairs || [];
      console.log(`  TaskID: ${taskId} | Swaps: ${sp.length}`);
      sp.forEach((s,idx) => console.log(`    ${idx+1}. [${s.field}] (${s.original?.length}→${s.adapted?.length}) "${s.adapted?.slice(0,55)}"`));
      if (taskId) {
        console.log('  Polling...');
        token = await login();
        const st = await pollStatus(token, taskId);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\n  ✅ Done in ${elapsed}s (provider: ${st.provider || provider})`);
        await downloadImage(st.resultImageUrl, `${tc.label}.png`);
      }
    } catch (err) { console.error(`  ❌ ${err.message.slice(0, 300)}`); }
  }
  console.log('\n=== GEMINI TEST Complete ===');
}
main().catch(e => { console.error('FATAL:', e); process.exit(1); });
