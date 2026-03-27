#!/usr/bin/env node
/**
 * Import Offer/Sale templates from local folders to the live API.
 * Logs in as admin, reads images as base64 data URIs, bulk-inserts via authenticated API.
 *
 * Usage: node server/scripts/import-sale-templates.js
 */
import fs from 'fs';
import path from 'path';

const API_BASE = 'https://mineblock-dashboard.onrender.com/api/v1';
const EMAIL = 'admin@try-mineblock.com';
const PASSWORD = 'MineblockAdmin2026!';

const FOLDERS = [
  {
    path: '/Users/ludo/Desktop/Static Templates/New Offer : Sale Template',
    category: 'Offer/Sale',
  },
  {
    path: '/Users/ludo/Desktop/Static Templates/Offer : Sale',
    category: 'Offer/Sale',
  },
];

const MIME_MAP = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function fileToDataUri(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_MAP[ext] || 'image/jpeg';
  const buffer = fs.readFileSync(filePath);
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

async function login() {
  const resp = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!resp.ok) throw new Error(`Login failed: ${resp.status}`);
  const data = await resp.json();
  return data.accessToken || data.token;
}

async function main() {
  console.log('Logging in...');
  const token = await login();
  console.log('Logged in successfully.\n');

  let totalUploaded = 0;
  let totalSkipped = 0;

  for (const folder of FOLDERS) {
    console.log(`Processing: ${path.basename(folder.path)}`);

    if (!fs.existsSync(folder.path)) {
      console.error(`  Folder not found, skipping.`);
      continue;
    }

    const files = fs.readdirSync(folder.path).filter((f) => {
      const ext = path.extname(f).toLowerCase();
      return MIME_MAP[ext];
    });

    console.log(`  Found ${files.length} images`);

    // Process in batches of 3 (data URIs are large)
    for (let i = 0; i < files.length; i += 3) {
      const batch = files.slice(i, i + 3);
      const templates = batch.map((file) => {
        const filePath = path.join(folder.path, file);
        const baseName = path.basename(file, path.extname(file));
        return {
          name: baseName,
          category: folder.category,
          image_url: fileToDataUri(filePath),
          tags: ['sale', 'offer', 'promotion'],
        };
      });

      try {
        const resp = await fetch(`${API_BASE}/statics-templates/bulk`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ templates }),
        });

        if (!resp.ok) {
          const errText = await resp.text();
          console.error(`  Batch ${i + 1}-${i + batch.length} failed: ${resp.status} ${errText.substring(0, 100)}`);
          totalSkipped += batch.length;
        } else {
          const result = await resp.json();
          totalUploaded += result.data?.count || batch.length;
          console.log(`  Uploaded ${totalUploaded} total`);
        }
      } catch (err) {
        console.error(`  Batch error: ${err.message}`);
        totalSkipped += batch.length;
      }

      // Delay between batches
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  console.log(`\nDone! Uploaded: ${totalUploaded}, Skipped: ${totalSkipped}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
