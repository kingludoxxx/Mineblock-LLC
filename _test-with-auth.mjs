import { execSync } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';

const BRAND = '1afd1d94-ffef-4a8a-b6ab-9685cb1c649a';
const AD    = '1e7ec708-5ecb-4f4b-9133-d8e521cd8daf';
const URL   = `https://mineblock-dashboard.onrender.com/app/brand-spy/${BRAND}/ads/${AD}`;

// --- 1. Decrypt Chrome cookies for the dashboard ---
const safePw = execSync('security find-generic-password -wa "Chrome" -s "Chrome Safe Storage"').toString().trim();
const key = pbkdf2Sync(safePw, 'saltysalt', 1003, 16, 'sha1');
const iv  = Buffer.alloc(16, ' '.charCodeAt(0));

function decrypt(encrypted) {
  if (!encrypted || encrypted.length < 4) return null;
  const prefix = encrypted.slice(0, 3).toString();
  if (prefix !== 'v10' && prefix !== 'v11') return null;
  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  let out = Buffer.concat([decipher.update(encrypted.slice(3)), decipher.final()]);
  // Modern Chrome prepends SHA256(host) (32 bytes) to the plaintext.
  if (out.length > 32 && out[0] < 0x20) out = out.subarray(32);
  return out.toString('utf8');
}

const db = new Database('/tmp/chrome-test-profile/Default/Cookies', { readonly: true });
const rows = db.prepare("SELECT host_key, name, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite FROM cookies WHERE host_key LIKE '%mineblock-dashboard%'").all();
const cookies = rows.map(r => ({
  name: r.name,
  value: decrypt(r.encrypted_value),
  domain: r.host_key.replace(/^\./, ''),
  path: r.path,
  expires: r.expires_utc ? (r.expires_utc - 11644473600000000) / 1000000 : -1,
  httpOnly: !!r.is_httponly,
  secure: !!r.is_secure,
  sameSite: ['Strict','Lax','None'][r.samesite] || 'Lax',
}));
console.log('cookies decrypted:', cookies.map(c => `${c.name}=${(c.value||'').slice(0,12)}...`));

const access = cookies.find(c => c.name === 'accessToken')?.value;
console.log('accessToken JWT exp:', (() => {
  try { return new Date(JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString()).exp * 1000).toISOString(); } catch { return '?'; }
})());

// --- 2. Launch headless Chromium with those cookies ---
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies(cookies.filter(c => c.value));
const page = await ctx.newPage();

const errs = [];
page.on('pageerror', e => errs.push('PAGE: ' + e.message));
page.on('console',  m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text().slice(0,300)); });

// Some apps store the access token in localStorage; pre-seed it.
await page.addInitScript((tok) => { try { localStorage.setItem('accessToken', tok); } catch {} }, access);

console.log('→ goto', URL);
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
// Give the SPA time to mount and call /auth/me
await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
await page.waitForTimeout(2500);

console.log('landed:', page.url());
console.log('title:', await page.title());

const counts = {
  loginForm:        await page.locator('text=/Sign in to your account/').count(),
  adDetailHeading:  await page.locator('text=/^Ad Detail$/').count(),
  signalLabel:      await page.locator('text=/^Signal$/').count(),
  atriaAi:          await page.locator('text=/^Atria AI$/').count(),
  transcribeCard:   await page.locator('text=/Transcribe script|View transcript/').count(),
  videoScriptPanel: await page.locator('text=/^Video Script$/').count(),
  cachedBadge:      await page.locator('text=/Cached/').count(),
  videoElement:     await page.locator('video').count(),
  norseOrganics:    await page.locator('text=/Norse/i').count(),
};
console.log('counts:', counts);

await page.screenshot({ path: '/tmp/ad-detail-loaded.png', fullPage: false });
console.log('screenshot →  /tmp/ad-detail-loaded.png');

// If we're authenticated, try clicking the Transcribe card and see the panel populate.
if (counts.transcribeCard > 0 && counts.signInForm === undefined) {
  console.log('clicking Transcribe…');
  await page.locator('text=/Transcribe script|View transcript/').first().click().catch(() => {});
  await page.waitForTimeout(3000);
  const after = {
    videoScriptPanel: await page.locator('text=/^Video Script$/').count(),
    timestampRows:    await page.locator('aside button:has-text(":")').count(),
  };
  console.log('after-click:', after);
  await page.screenshot({ path: '/tmp/ad-detail-panel-open.png', fullPage: false });
}

if (errs.length) {
  console.log('--- errors ---');
  errs.slice(0, 8).forEach(e => console.log('  ' + e));
}
await browser.close();
