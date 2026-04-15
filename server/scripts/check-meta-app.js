#!/usr/bin/env node
// Quick diagnostic: check Meta app mode, token info, and page access
import 'dotenv/config';

const TOKEN = process.env.META_ACCESS_TOKEN;
const BASE = 'https://graph.facebook.com/v21.0';

async function main() {
  // 1. Debug token — shows app info, user info, scopes
  console.log('=== TOKEN DEBUG INFO ===');
  const debugRes = await fetch(`${BASE}/debug_token?input_token=${TOKEN}&access_token=${TOKEN}`);
  const debugData = await debugRes.json();
  console.log(JSON.stringify(debugData, null, 2));

  // 2. Check the app itself
  if (debugData.data?.app_id) {
    console.log('\n=== APP INFO ===');
    const appRes = await fetch(`${BASE}/${debugData.data.app_id}?fields=name,category,link,status&access_token=${TOKEN}`);
    const appData = await appRes.json();
    console.log(JSON.stringify(appData, null, 2));
  }

  // 3. List ad accounts
  console.log('\n=== AD ACCOUNTS ===');
  const adAccRes = await fetch(`${BASE}/me/adaccounts?fields=id,name,account_status&access_token=${TOKEN}`);
  const adAccData = await adAccRes.json();
  console.log(JSON.stringify(adAccData, null, 2));

  // 4. Check pages we have access to
  console.log('\n=== PAGES ===');
  const pagesRes = await fetch(`${BASE}/me/accounts?fields=id,name,access_token&access_token=${TOKEN}`);
  const pagesData = await pagesRes.json();
  // Don't print page tokens in full
  if (pagesData.data) {
    pagesData.data.forEach(p => {
      if (p.access_token) p.access_token = p.access_token.slice(0, 20) + '...';
    });
  }
  console.log(JSON.stringify(pagesData, null, 2));
}

main().catch(err => console.error('Error:', err.message));
