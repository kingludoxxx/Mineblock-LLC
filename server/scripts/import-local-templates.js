#!/usr/bin/env node
/**
 * Import templates from local folders into the Mineblock statics library.
 *
 * Usage: node server/scripts/import-local-templates.js "/Users/ludo/Desktop/Static Templates"
 *
 * Expects folder structure:
 *   Static Templates/
 *     Offer : Sale/
 *       4507.webp
 *       3387.webp
 *     Us Vs Them/
 *       1234.webp
 *     Before & After/
 *       ...
 *
 * Each subfolder name becomes the category. Files are uploaded to the server
 * via the bulk create API endpoint.
 */

import fs from 'fs';
import path from 'path';

const BASE_DIR = process.argv[2] || '/Users/ludo/Desktop/Static Templates';
const API_BASE = process.env.API_BASE || 'https://mineblock-dashboard.onrender.com';

// Category name mapping (folder names → Konvert standard names)
const CATEGORY_MAP = {
  'Offer : Sale': 'Offer/Sale',
  'Offer Sale': 'Offer/Sale',
  'Us Vs Them': 'Us vs Them',
  'Before And After': 'Before & After',
  'Problem Solution': 'Problem + Solution',
  'Social Proof Testimonials': 'Social Proof & Testimonials',
  'Feature Benefit': 'Feature/Benefit',
  'Article News': 'Article/News',
  'Whats Inside': "What's Inside",
};

function normalizeCategory(folderName) {
  return CATEGORY_MAP[folderName] || folderName;
}

async function main() {
  console.log(`Scanning: ${BASE_DIR}`);

  const categories = fs.readdirSync(BASE_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  console.log(`Found ${categories.length} categories: ${categories.join(', ')}`);

  const allTemplates = [];

  for (const cat of categories) {
    const catDir = path.join(BASE_DIR, cat);
    const files = fs.readdirSync(catDir).filter(f => /\.(webp|png|jpg|jpeg|gif)$/i.test(f));
    const normalCat = normalizeCategory(cat);

    console.log(`  ${normalCat}: ${files.length} files`);

    for (const file of files) {
      const filePath = path.join(catDir, file);
      const fileId = path.parse(file).name;

      // The Xano CDN URL pattern from Konvert
      // We'll store the local path as the image_url for now
      // In production, you'd upload to R2 first
      allTemplates.push({
        name: `${normalCat} - ${fileId}`,
        category: normalCat,
        image_url: `file://${filePath}`,
        tags: [normalCat.toLowerCase()],
      });
    }
  }

  console.log(`\nTotal: ${allTemplates.length} templates ready to import`);

  // Write as JSON for the bulk API
  const outPath = path.join(BASE_DIR, 'import-manifest.json');
  fs.writeFileSync(outPath, JSON.stringify({ templates: allTemplates, count: allTemplates.length }, null, 2));
  console.log(`Manifest written to: ${outPath}`);

  // Also output a summary
  const byCat = {};
  allTemplates.forEach(t => { byCat[t.category] = (byCat[t.category] || 0) + 1; });
  console.log('\nBy category:');
  Object.entries(byCat).sort((a, b) => b[1] - a[1]).forEach(([cat, count]) => {
    console.log(`  ${cat}: ${count}`);
  });
}

main().catch(console.error);
