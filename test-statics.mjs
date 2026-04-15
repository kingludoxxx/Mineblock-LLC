#!/usr/bin/env node
// Test script for statics generation pipeline
// Generates images, polls for completion, downloads results for analysis

const API_BASE = 'https://mineblock-dashboard.onrender.com/api/v1';
const fs = await import('fs');
const path = await import('path');

// Create output directory
const outDir = '/Users/ludo/Mineblock-LLC/test-output';
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

async function login() {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@try-mineblock.com', password: 'MineblockAdmin2026!' }),
  });
  const data = await res.json();
  return data.accessToken;
}

async function getProduct(token, id) {
  const res = await fetch(`${API_BASE}/product-profiles/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.data;
}

async function generate(token, payload) {
  const res = await fetch(`${API_BASE}/statics-generation/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Generate failed ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.json();
}

async function pollStatus(token, taskId, maxPollSec = 300) {
  const start = Date.now();
  while (Date.now() - start < maxPollSec * 1000) {
    // Re-login if needed (token expires every 15 min)
    if (Date.now() - start > 14 * 60 * 1000) {
      token = await login();
    }
    const res = await fetch(`${API_BASE}/statics-generation/status/${taskId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    const status = data.data?.status;
    if (status === 'completed') {
      return data.data;
    }
    if (status === 'failed') {
      throw new Error(`Generation failed: ${data.data?.error || 'Unknown error'}`);
    }
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('Timeout waiting for generation');
}

async function downloadImage(url, filename) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const filepath = path.join(outDir, filename);
  fs.writeFileSync(filepath, buf);
  console.log(`  Saved: ${filepath} (${(buf.length / 1024).toFixed(0)} KB)`);
  return filepath;
}

// Reference images to test with (Xano-hosted)
const REFERENCE_IMAGES = [
  'https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/ZpSUZZ5Jnw2ovZaCF5ClOAwegH4/f5ANmQ../4401.webp',
  'https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/mSuMIIFG0AtxhmNWNQQHdWBSuSk/a9uyFg../1598.webp',
  'https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/3ADJaAVyHseGn0cKPzimGrRfRAY/DDWUqw../4408.webp',
  'https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/Jb-hns7qoAdcbwzmBbDJLeHi0G8/2Ll3XA../3643.webp',
  'https://mineblock-dashboard.onrender.com/static-templates/Offer-Sale/3972.webp',
];

const ANGLES = ['Curiosity', 'Social Proof', 'Urgency/Scarcity', 'Value Proposition', null];

async function main() {
  console.log('=== Statics Generation Test Suite ===');
  console.log(`Time: ${new Date().toISOString()}\n`);

  let token = await login();
  console.log('✅ Authenticated\n');

  const product = await getProduct(token, 3);
  console.log(`✅ Product: ${product.name} | Price: ${product.price}`);
  console.log(`   Images: ${product.product_images?.length || 0} | Logos: ${product.logos?.length || 0}`);
  console.log(`   Discount: ${product.discount_codes || 'none'}\n`);

  // Build product payload like the client does
  const profile = {};
  if (product.oneliner) profile.oneliner = product.oneliner;
  if (product.customer_avatar) profile.customerAvatar = product.customer_avatar;
  if (product.customer_frustration) profile.customerFrustration = product.customer_frustration;
  if (product.customer_dream) profile.customerDream = product.customer_dream;
  if (product.big_promise) profile.bigPromise = product.big_promise;
  if (product.mechanism) profile.mechanism = product.mechanism;
  if (product.differentiator) profile.differentiator = product.differentiator;
  if (product.voice) profile.voice = product.voice;
  if (product.guarantee) profile.guarantee = product.guarantee;
  if (product.benefits) profile.benefits = product.benefits;
  if (product.pain_points) profile.painPoints = product.pain_points;
  if (product.common_objections) profile.commonObjections = product.common_objections;
  if (product.winning_angles) profile.winningAngles = product.winning_angles;
  if (product.competitive_edge) profile.competitiveEdge = product.competitive_edge;
  if (product.offer_details) profile.offerDetails = product.offer_details;
  if (product.max_discount) profile.maxDiscount = product.max_discount;
  if (product.discount_codes) profile.discountCodes = product.discount_codes;
  if (product.bundle_variants) profile.bundleVariants = product.bundle_variants;
  if (product.compliance_restrictions) profile.complianceRestrictions = product.compliance_restrictions;
  if (product.notes) profile.notes = product.notes;

  console.log(`   Profile fields: ${Object.keys(profile).length}\n`);

  const productPayload = {
    id: product.id,
    name: product.name,
    description: product.description,
    price: product.price,
    profile,
    product_images: product.product_images || [],
    logos: product.logos || [],
    brand_colors: product.brand_colors || {},
    fonts: product.fonts || [],
  };

  const results = [];

  // Test: Generate 3 images with different references and angles
  const testCases = [
    { ref: REFERENCE_IMAGES[0], angle: 'Curiosity', label: 'test1-curiosity-4401' },
    { ref: REFERENCE_IMAGES[1], angle: 'Social Proof', label: 'test2-social-1598' },
    { ref: REFERENCE_IMAGES[4], angle: 'Urgency/Scarcity', label: 'test3-urgency-3972' },
  ];

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    console.log(`\n--- Test ${i + 1}/${testCases.length}: ${tc.label} ---`);
    console.log(`  Ref: ${tc.ref.slice(0, 80)}`);
    console.log(`  Angle: ${tc.angle}`);

    try {
      // Re-login for fresh token
      token = await login();

      const payload = {
        reference_image_url: tc.ref,
        product: productPayload,
        angle: tc.angle,
        ratio: '4:5',
      };

      console.log('  Generating...');
      const genResult = await generate(token, payload);

      if (!genResult.success) {
        console.error('  ❌ Generate returned error:', genResult.error);
        results.push({ test: tc.label, status: 'GENERATE_FAILED', error: genResult.error });
        continue;
      }

      const tasks = genResult.data?.tasks || [];
      const taskId = tasks[0]?.taskId || genResult.data?.taskId;
      console.log(`  TaskID: ${taskId}`);
      console.log(`  Swap pairs: ${genResult.data?.swapPairs?.length || 0}`);

      // Log Claude analysis summary
      const analysis = genResult.data?.claudeAnalysis;
      if (analysis) {
        console.log(`  Claude: people=${analysis.people_count}, products=${analysis.product_count}, logo=${analysis.has_competitor_logo}, orientation=${analysis.product_orientation}`);
        console.log(`  Headline orig: "${(analysis.original_text?.headline || '').slice(0, 60)}"`);
        console.log(`  Headline adapted: "${(analysis.adapted_text?.headline || '').slice(0, 60)}"`);
      }

      // Log all swap pairs
      const swapPairs = genResult.data?.swapPairs || [];
      console.log(`  --- Swap Pairs (${swapPairs.length}) ---`);
      swapPairs.forEach((sp, idx) => {
        console.log(`    ${idx + 1}. [${sp.field}] "${sp.original?.slice(0, 50)}" → "${sp.adapted?.slice(0, 50)}"`);
      });

      // Poll for completion
      if (taskId) {
        console.log('  Polling...');
        token = await login(); // fresh token for polling
        const status = await pollStatus(token, taskId);
        console.log(`\n  ✅ Completed! Image: ${status.resultImageUrl?.slice(0, 80)}`);

        // Download generated image
        const ext = status.resultImageUrl?.includes('.png') ? 'png' : 'jpg';
        const filepath = await downloadImage(status.resultImageUrl, `${tc.label}.${ext}`);

        // Also download reference for comparison
        try {
          await downloadImage(tc.ref, `${tc.label}-reference.webp`);
        } catch (e) {
          console.log(`  (Could not download reference: ${e.message})`);
        }

        results.push({
          test: tc.label,
          status: 'COMPLETED',
          imageUrl: status.resultImageUrl,
          localPath: filepath,
          swapPairs: swapPairs.length,
          analysis: {
            people: analysis?.people_count,
            products: analysis?.product_count,
            logo: analysis?.has_competitor_logo,
            orientation: analysis?.product_orientation,
          },
          headlineOrig: analysis?.original_text?.headline,
          headlineAdapted: analysis?.adapted_text?.headline,
        });
      }
    } catch (err) {
      console.error(`  ❌ Error: ${err.message}`);
      results.push({ test: tc.label, status: 'ERROR', error: err.message });
    }
  }

  // Summary
  console.log('\n\n========== TEST RESULTS SUMMARY ==========');
  results.forEach((r, i) => {
    console.log(`\nTest ${i + 1}: ${r.test}`);
    console.log(`  Status: ${r.status}`);
    if (r.status === 'COMPLETED') {
      console.log(`  Swap pairs: ${r.swapPairs}`);
      console.log(`  People: ${r.analysis?.people}, Products: ${r.analysis?.products}`);
      console.log(`  Logo detected: ${r.analysis?.logo}`);
      console.log(`  Orientation: ${r.analysis?.orientation}`);
      console.log(`  Headline: "${r.headlineOrig?.slice(0, 40)}" → "${r.headlineAdapted?.slice(0, 40)}"`);
      console.log(`  Image: ${r.localPath}`);
    } else {
      console.log(`  Error: ${r.error}`);
    }
  });

  // Write detailed report
  const reportPath = path.join(outDir, 'test-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`\nFull report: ${reportPath}`);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
