import { execSync } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';

console.log('[1/6] decrypting cookies…');
const safePw = execSync('security find-generic-password -wa "Chrome" -s "Chrome Safe Storage"').toString().trim();
const key = pbkdf2Sync(safePw, 'saltysalt', 1003, 16, 'sha1');
const iv  = Buffer.alloc(16, 0x20);

function decrypt(enc) {
  if (!enc || enc.length < 4) return null;
  const v = enc.slice(0, 3).toString();
  if (v !== 'v10' && v !== 'v11') return null;
  const d = createDecipheriv('aes-128-cbc', key, iv);
  let out = Buffer.concat([d.update(enc.slice(3)), d.final()]);
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
  expires: r.expires_utc ? (r.expires_utc - 11644473600000000) / 1e6 : -1,
  httpOnly: !!r.is_httponly,
  secure: !!r.is_secure,
  sameSite: ['Strict','Lax','None'][r.samesite] || 'Lax',
})).filter(c => c.value);
console.log('   →', cookies.map(c => c.name).join(', '));

console.log('[2/6] launching headless chromium…');
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies(cookies);
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push('PAGE: ' + e.message));
page.on('console',  m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text().slice(0,250)); });

const BRAND = '1afd1d94-ffef-4a8a-b6ab-9685cb1c649a';
const AD    = '1e7ec708-5ecb-4f4b-9133-d8e521cd8daf';
const URL   = `https://mineblock-dashboard.onrender.com/app/brand-spy/${BRAND}/ads/${AD}`;

console.log('[3/6] navigating to', URL);
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
console.log('   landed:', page.url());
await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => console.log('   networkidle timeout (continuing)'));
await page.waitForTimeout(3000);

console.log('[4/6] reading page state…');
const c = {
  loginForm:        await page.locator('text=/Sign in to your account/').count(),
  adDetailHeading:  await page.locator('text=/^Ad Detail$/').count(),
  signalLabel:      await page.locator('text=/^Signal$/').count(),
  atriaAi:          await page.locator('text=/^Atria AI$/').count(),
  transcribeCard:   await page.locator('text=/Transcribe script|View transcript/').count(),
  videoScriptPanel: await page.locator('text=/^Video Script$/').count(),
  cachedBadge:      await page.locator('text=/^Cached$/').count(),
  videoElement:     await page.locator('video').count(),
};
console.log('   counts:', c);

await page.screenshot({ path: '/tmp/ad-detail-1-initial.png', fullPage: false });
console.log('   shot → /tmp/ad-detail-1-initial.png');

if (c.loginForm > 0 || c.adDetailHeading === 0) {
  console.log('[5/6] ❌ login wall hit — auth refresh failed');
} else if (c.transcribeCard > 0) {
  console.log('[5/6] clicking Transcribe…');
  await page.locator('text=/Transcribe script|View transcript/').first().click().catch(() => {});
  await page.waitForTimeout(3000);
  const c2 = {
    videoScriptPanel: await page.locator('text=/^Video Script$/').count(),
    timestamps: await page.locator('button:has(span[class*="tabular-nums"])').count(),
    transcriptText: (await page.locator('aside').textContent().catch(() => '')).slice(0, 200),
  };
  console.log('   after-click:', c2);
  await page.screenshot({ path: '/tmp/ad-detail-2-panel-open.png', fullPage: false });
  console.log('   shot → /tmp/ad-detail-2-panel-open.png');
}

console.log('[6/6] done. errors:', errs.length);
errs.slice(0, 6).forEach(e => console.log('   ' + e));
await browser.close();
process.exit(0);
