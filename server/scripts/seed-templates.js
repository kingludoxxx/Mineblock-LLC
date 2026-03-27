#!/usr/bin/env node
/**
 * Seed statics_templates table from local public/static-templates/ files.
 * Run after deploy: node server/scripts/seed-templates.js
 * Or call via API: POST /api/v1/statics-templates/bulk
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '../../client/public/static-templates');

const CATEGORIES = {
  'Offer-Sale': 'Offer/Sale',
  'Us-vs-Them': 'Us vs Them',
  'Before-After': 'Before & After',
  'Feature-Benefit': 'Feature/Benefit',
  'Article-News': 'Article/News',
  'Apple-Notes': 'Apple Notes',
  'Bold-Claim': 'Bold Claim',
  'Negative-Hook': 'Negative Hook',
  'Google-Search': 'Google Search',
  'Whats-Inside': "What's Inside",
  'Problem-Solution': 'Problem + Solution',
  'Social-Proof': 'Social Proof & Testimonials',
  'Offer-Promotion': 'Offer & Promotion',
  'Benefits-Features': 'Benefits & Features',
  'Lifestyle-Brand': 'Lifestyle & Brand',
  'UGC-Reviews': 'UGC & Reviews',
};

function main() {
  if (!fs.existsSync(PUBLIC_DIR)) {
    console.error(`Directory not found: ${PUBLIC_DIR}`);
    process.exit(1);
  }

  const folders = fs.readdirSync(PUBLIC_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  const templates = [];

  for (const folder of folders) {
    const category = CATEGORIES[folder] || folder.replace(/-/g, ' ');
    const folderPath = path.join(PUBLIC_DIR, folder);
    const files = fs.readdirSync(folderPath).filter(f => /\.(webp|png|jpg|jpeg|gif)$/i.test(f));

    for (const file of files) {
      const fileId = path.parse(file).name;
      templates.push({
        name: `${category} - ${fileId}`,
        category,
        image_url: `/static-templates/${folder}/${file}`,
        tags: [category.toLowerCase()],
      });
    }

    console.log(`${category}: ${files.length} templates`);
  }

  // Output as JSON for bulk API import
  const output = JSON.stringify({ templates }, null, 2);
  const outFile = path.join(__dirname, 'templates-seed.json');
  fs.writeFileSync(outFile, output);
  console.log(`\nTotal: ${templates.length} templates`);
  console.log(`Written to: ${outFile}`);
  console.log(`\nTo import, run:`);
  console.log(`  curl -X POST http://localhost:3000/api/v1/statics-templates/bulk \\`);
  console.log(`    -H "Content-Type: application/json" \\`);
  console.log(`    -H "Authorization: Bearer YOUR_TOKEN" \\`);
  console.log(`    -d @${outFile}`);
}

main();
