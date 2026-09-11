#!/usr/bin/env node
// W6 REAL-BROWSER check for the sidebar store switcher (R8: UI is not done on unit tests alone).
//
// Drives a real headless Chromium over the DevTools Protocol with Node 22's built-in WebSocket — no new
// dependency. It builds the REAL client (the real Sidebar, the real StoreSwitcher, the real hook) into a temp
// directory, serves it next to a REAL GET /api/v1/store-config, and then:
//
//   1. asserts the brand block became a switcher, opens it, and reads the menu
//   2. asserts the three stores the fake store-config carries, the current one marked, Add store + Manage stores
//   3. CLICKS another store and intercepts the navigation: it must go to <hub>/switch/<code>?next=/app/dashboard
//   4. 375 px: the open menu causes no horizontal scroll and fits the viewport
//   5. keyboard: Escape closes, ArrowDown walks the menu
//   6. R21 (the failure path): a store-config with no hub renders the plain brand block — no chevron, no menu
//   7. collapsed sidebar: the symbol logo is still the trigger
//
// NOTHING LEAVES THE MACHINE: Chromium runs with --host-resolver-rules=MAP * 127.0.0.1:9 (every hostname
// resolves to a dead local port) AND the hub navigation is caught by CDP Fetch at requestStage=Request, before
// it is sent. No live URL, no real hub, no database.
//
// Usage:  node scripts/browser-check-sidebar-switcher.mjs [--shots <dir>]
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CLIENT = path.join(REPO, 'client');
const ARGV = process.argv.slice(2);
const shotDir = (() => { const i = ARGV.indexOf('--shots'); return i >= 0 ? path.resolve(ARGV[i + 1]) : null; })();

const HUB_ORIGIN = 'https://hub.example.test';
const PAGE = '/dev/switcher-check.html';
// Store identity is DATA here too (R5/R15): these three codes live in this check's fake API answer, nowhere else.
const FAKE_STORES = [{ code: 'MB', name: 'Mineblock' }, { code: 'SB', name: 'Sandbox' }, { code: 'TW', name: 'Third Wave' }];
const CURRENT = 'MB';
const CLICKED = 'SB';

const log = (...a) => console.log(...a);
const fail = (msg) => { throw new Error(msg); };
const checks = [];
const check = (what, ok) => checks.push([what, Boolean(ok)]);

/* ------------------------------------------------------------------ build */
log('building the harness page with the REAL client sources…');
const outDir = await mkdtemp(path.join(tmpdir(), 'w6-client-'));
const build = spawnSync('npx', ['vite', 'build', '--config', 'dev/switcher-check.config.js'], {
  cwd: CLIENT, encoding: 'utf8', env: { ...process.env, W6_OUT_DIR: outDir },
});
if (build.status !== 0) fail(`vite build failed (${build.status}):\n${build.stdout}\n${build.stderr}`);
log(build.stdout.trim().split('\n').slice(-3).join('\n'));

/* ------------------------------------------------------- the fake dashboard */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
// 1x1 transparent PNG: the brand logo files are not in this build's output, and a broken <img> would muddy a screenshot.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** Flipped between page loads to serve a DIFFERENT store-config: this is how the R21 no-hub path is reached. */
let mode = 'hub';
const storeConfigBody = () => ({
  success: true,
  data: {
    storeCode: CURRENT,
    brand: { name: null, shortName: null, logoWhite: null, logoSymbol: null, logoBlack: null, emailDomain: null },
    hub: mode === 'hub' ? { origin: HUB_ORIGIN, sso_enabled: true } : { origin: null, sso_enabled: false },
    switcher: { current: CURRENT, stores: mode === 'hub' ? FAKE_STORES : [] },
  },
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  if (url.pathname === '/api/v1/store-config') return send(200, 'application/json', JSON.stringify(storeConfigBody()));
  if (url.pathname === '/api/v1/brand') return send(200, 'application/json', JSON.stringify({ success: true, data: storeConfigBody().data.brand }));
  if (url.pathname.endsWith('.png')) return send(200, 'image/png', PNG);
  try {
    const file = path.join(outDir, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(outDir)) return send(403, 'text/plain', 'no');
    const body = await readFile(file);
    return send(200, TYPES[path.extname(file)] || 'application/octet-stream', body);
  } catch { return send(404, 'text/plain', 'not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
log(`serving the built shell + a fake store-config at ${BASE}`);

/* ---------------------------------------------------------------- chromium */
async function findChromium() {
  const root = path.join(process.env.HOME, 'Library/Caches/ms-playwright');
  const dirs = (await readdir(root)).filter((d) => d.startsWith('chromium_headless_shell-') || d.startsWith('chromium-')).sort();
  for (const d of dirs.reverse()) {
    for (const rel of ['chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chrome-headless-shell-mac-x64/chrome-headless-shell', 'chrome-mac/headless_shell', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, rel);
      try { await readFile(p, { encoding: null, flag: 'r' }); return p; } catch { /* next */ }
    }
  }
  fail(`no Chromium binary under ${root}`);
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); ws.addEventListener('message', (e) => this.#onMessage(e)); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    return new Cdp(ws);
  }
  #onMessage(e) {
    const msg = JSON.parse(e.data);
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id);
      return msg.error ? reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`)) : resolve(msg.result);
    }
    for (const h of this.handlers.get(msg.method) ?? []) h(msg.params, msg.sessionId);
  }
  on(method, fn) { if (!this.handlers.has(method)) this.handlers.set(method, []); this.handlers.get(method).push(fn); }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`)); }, 30000);
    });
  }
  close() { this.ws.close(); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cdp, sid;
const evaluate = async (expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) fail(`page threw: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
};
async function until(label, fn, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) fail(`timed out waiting for ${label}`); await sleep(120); }
}
async function key(k, code, keyCode) {
  for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }, sid);
}
async function shot(name) {
  if (!shotDir) return null;
  await mkdir(shotDir, { recursive: true });
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
  const file = path.join(shotDir, `${name}.png`);
  await writeFile(file, Buffer.from(data, 'base64'));
  log(`   screenshot: ${file}`);
  return file;
}
const click = (sel) => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return false;el.click();return true})()`);
const open = () => evaluate(`!!document.querySelector('[data-testid="store-switcher-menu"]')`);

const chromium = await findChromium();
const profile = await mkdtemp(path.join(tmpdir(), 'w6-chrome-'));
const child = spawn(chromium, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, '--remote-debugging-port=0',
  '--host-resolver-rules=MAP * 127.0.0.1:9, EXCLUDE 127.0.0.1',
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

const intercepted = [];
try {
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    child.stderr.on('data', (d) => { buf += d; const m = buf.match(/ws:\/\/[^\s]+/); if (m) resolve(m[0]); });
    child.on('exit', (c) => reject(new Error(`chromium exited ${c}: ${buf}`)));
    setTimeout(() => reject(new Error(`chromium never printed a DevTools url: ${buf}`)), 20000);
  });
  const version = await (await fetch(wsUrl.replace(/^ws:\/\/([^/]+)\/.*/, 'http://$1/json/version'))).json();
  log(`browser: ${version['User-Agent']}\n         ${version.Browser} at ${chromium}`);
  cdp = await Cdp.connect(wsUrl);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  ({ sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  await cdp.send('Page.enable', {}, sid); await cdp.send('Runtime.enable', {}, sid); await cdp.send('Network.enable', {}, sid);

  // Anything that is not this harness is caught before it is sent and answered with a stub page.
  cdp.on('Fetch.requestPaused', async (p, session) => {
    const r = p.request;
    if (!r.url.startsWith(BASE)) {
      intercepted.push({ url: r.url, method: r.method });
      const body = Buffer.from('<!doctype html><title>stub hub</title><h1 id="stub">stubbed hub</h1>').toString('base64');
      return cdp.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'text/html' }], body }, session);
    }
    return cdp.send('Fetch.continueRequest', { requestId: p.requestId }, session);
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sid);

  // ── 1. the shell renders and the brand block became a switcher ────────────
  await cdp.send('Page.navigate', { url: BASE + PAGE }, sid);
  await until('the sidebar', async () => await evaluate(`!!document.querySelector('[data-testid="store-switcher"], [data-testid="brand-block"]')`));
  const trigger = await until('the switcher trigger', async () => await evaluate(`(()=>{const b=document.querySelector('[data-testid="store-switcher-button"]');if(!b)return null;const r=b.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),label:b.getAttribute('aria-label'),haspopup:b.getAttribute('aria-haspopup'),expanded:b.getAttribute('aria-expanded'),chevron:!!b.querySelector('svg'),logo:!!b.querySelector('img')}})()`));
  log(`1. switcher trigger in the sidebar: ${JSON.stringify(trigger)}`);
  check('the brand block is a button with a chevron, top-left of the sidebar', trigger.x < 20 && trigger.y < 48 && trigger.chevron && trigger.logo);
  check('it is announced as a menu trigger', trigger.haspopup === 'menu' && trigger.expanded === 'false' && trigger.label === 'Switch store');
  await shot('01-sidebar-closed');

  // ── 2. the menu: the stores the server sent, the current one marked ───────
  await click('[data-testid="store-switcher-button"]');
  await until('the menu', open);
  const rows = await evaluate(`[...document.querySelectorAll('[data-testid="store-switcher-menu"] [role="menuitem"]')].map(a=>({code:a.dataset.storeCode||null,testid:a.dataset.testid||null,text:a.innerText.replace(/\\n/g,' ').trim(),href:a.getAttribute('href'),target:a.getAttribute('target'),current:a.getAttribute('aria-current'),check:!!a.querySelector('svg.lucide-check')}))`);
  log('2. menu rows:'); for (const r of rows) log(`   ${JSON.stringify(r)}`);
  const storeRows = rows.filter((r) => r.code);
  check('the menu lists exactly the stores the server sent', storeRows.length === FAKE_STORES.length && FAKE_STORES.every((s) => storeRows.some((r) => r.code === s.code && r.text.includes(s.name))));
  check('the current store is the one marked', storeRows.filter((r) => r.current === 'true').length === 1 && storeRows.find((r) => r.current === 'true').code === CURRENT);
  check('the mark is a visible check, not only an attribute', storeRows.find((r) => r.code === CURRENT).check === true);
  check('"Add store" is there and points at the hub wizard', rows.some((r) => r.testid === 'add-store' && r.href === `${HUB_ORIGIN}/#add-store`));
  check('"Manage stores" is there and points at the hub', rows.some((r) => r.testid === 'manage-stores' && r.href === `${HUB_ORIGIN}/`));
  check('every row navigates the TOP window', rows.every((r) => r.target === '_top'));
  check('the expanded state is announced', (await evaluate(`document.querySelector('[data-testid="store-switcher-button"]').getAttribute('aria-expanded')`)) === 'true');
  await shot('02-menu-open');

  // ── 4. 375 px, menu open: no horizontal scroll (Ludo's standing rule) ─────
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true }, sid);
  await sleep(200);
  const mobile = await evaluate(`({scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,menu:(()=>{const r=document.querySelector('[data-testid="store-switcher-menu"]').getBoundingClientRect();return {left:Math.round(r.left),right:Math.round(r.right)}})()})`);
  // The SHELL's own width at 375 px is not this lane's to change (a fixed 220 px sidebar plus a min-width main
  // has always overflowed there). What must be true is that the switcher adds NOTHING to it: same scrollWidth
  // open and closed, and a menu that stays inside the viewport.
  await click('[data-testid="store-switcher-button"]');
  await until('the menu to close', async () => !(await open()));
  const closedWidth = await evaluate(`document.documentElement.scrollWidth`);
  await click('[data-testid="store-switcher-button"]');
  await until('the menu to open again', open);
  const widest = await evaluate(`[...document.querySelectorAll('body *')].map(el=>({t:el.tagName+(el.className&&typeof el.className==='string'?'.'+el.className.split(' ')[0]:''),r:Math.round(el.getBoundingClientRect().right)})).filter(x=>x.r>375).slice(0,4)`);
  log(`4. 375 px: scrollWidth open=${mobile.scrollWidth} closed=${closedWidth} clientWidth=${mobile.clientWidth} menu box=${JSON.stringify(mobile.menu)}`);
  log(`   what is wider than the viewport (the shell itself, unchanged by this lane): ${JSON.stringify(widest)}`);
  check('375 px: the switcher adds no horizontal scroll of its own', mobile.scrollWidth === closedWidth);
  check('375 px: the open menu fits the viewport', mobile.menu.left >= 0 && mobile.menu.right <= 375);
  await shot('03-menu-375px');
  await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sid);
  await sleep(150);

  // ── 5. keyboard ───────────────────────────────────────────────────────────
  const focusAfterOpen = await evaluate(`document.activeElement?.dataset?.storeCode || document.activeElement?.tagName`);
  await key('ArrowDown', 'ArrowDown', 40);
  await sleep(120);
  const focusAfterDown = await evaluate(`document.activeElement?.dataset?.storeCode || document.activeElement?.dataset?.testid || document.activeElement?.tagName`);
  await key('Escape', 'Escape', 27);
  await sleep(150);
  const closedByEscape = !(await open());
  log(`5. keyboard: focus on open = ${focusAfterOpen}, after ArrowDown = ${focusAfterDown}, Escape closed = ${closedByEscape}`);
  check('opening puts focus on the current store', focusAfterOpen === CURRENT);
  check('ArrowDown walks the menu', focusAfterDown !== focusAfterOpen);
  check('Escape closes the menu', closedByEscape);

  // ── 3. clicking another store goes to the hub, and nowhere else ───────────
  await click('[data-testid="store-switcher-button"]');
  await until('the menu again', open);
  const before = intercepted.length;
  await click(`[data-store-code="${CLICKED}"]`);
  await until('the navigation to the hub', async () => intercepted.length > before);
  const nav = intercepted[intercepted.length - 1];
  log(`3. clicking ${CLICKED}: ${nav.method} ${nav.url}`);
  check(`clicking a store navigates to <hub>/switch/${CLICKED}`, nav.url === `${HUB_ORIGIN}/switch/${CLICKED}?next=%2Fapp%2Fdashboard`);
  check('the navigation carries no ticket and no credential', !/ticket|token|secret/i.test(nav.url));
  await until('the stubbed hub page', async () => await evaluate(`!!document.getElementById('stub')`));

  // ── 7. collapsed sidebar: the symbol logo is still the trigger ────────────
  await cdp.send('Page.navigate', { url: BASE + PAGE }, sid);
  await until('the sidebar again', async () => await evaluate(`!!document.querySelector('[data-testid="store-switcher-button"]')`));
  await click('aside button[title="Collapse sidebar"]');
  await sleep(250);
  const collapsed = await evaluate(`(()=>{const b=document.querySelector('[data-testid="store-switcher-button"]');const r=b.getBoundingClientRect();return {w:Math.round(r.width),x:Math.round(r.x),img:b.querySelector('img')?.getAttribute('src'),sidebar:Math.round(document.querySelector('aside').getBoundingClientRect().width)}})()`);
  await click('[data-testid="store-switcher-button"]');
  await until('the menu in a collapsed sidebar', open);
  const collapsedMenu = await evaluate(`(()=>{const r=document.querySelector('[data-testid="store-switcher-menu"]').getBoundingClientRect();return {left:Math.round(r.left),right:Math.round(r.right),rows:document.querySelectorAll('[data-testid="store-switcher-menu"] [role="menuitem"]').length}})()`);
  log(`7. collapsed sidebar (${collapsed.sidebar}px): trigger ${JSON.stringify(collapsed)}, menu ${JSON.stringify(collapsedMenu)}`);
  check('collapsed: the symbol logo is still the trigger', collapsed.sidebar <= 60 && Boolean(collapsed.img));
  check('collapsed: the same menu opens and stays on screen', collapsedMenu.rows === FAKE_STORES.length + 2 && collapsedMenu.left >= 0);
  await shot('04-collapsed-open');

  // ── 6. R21 THE FAILURE PATH: no hub -> the brand block, exactly as before ──
  mode = 'nohub';
  await cdp.send('Page.navigate', { url: BASE + PAGE }, sid);
  await until('the sidebar with no hub', async () => await evaluate(`!!document.querySelector('aside')`));
  await sleep(400);
  const noHub = await evaluate(`({brand:!!document.querySelector('[data-testid="brand-block"]'), switcher:!!document.querySelector('[data-testid="store-switcher-button"]'), menu:!!document.querySelector('[data-testid="store-switcher-menu"]'), logo:document.querySelector('[data-testid="brand-block"] img')?.getAttribute('src')||null})`);
  log(`6. R21 no hub configured: ${JSON.stringify(noHub)}`);
  check('R21: with no hub the sidebar shows the plain brand block', noHub.brand === true && noHub.logo !== null);
  check('R21: there is no dropdown at all — not an empty one', noHub.switcher === false && noHub.menu === false);
  // The 375 px control: with this lane's component rendering NOTHING but the old brand block, the shell is
  // exactly as wide as it is with the switcher open. The overflow at 375 px is the shell's, and it predates W6.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true }, sid);
  await sleep(200);
  const noHubWidth = await evaluate(`document.documentElement.scrollWidth`);
  await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sid);
  log(`6b. 375 px control: scrollWidth with NO switcher at all = ${noHubWidth} (with the menu open it was ${mobile.scrollWidth})`);
  check('375 px: the shell is exactly as wide with the switcher as without it', noHubWidth === mobile.scrollWidth);
  await shot('05-no-hub');

  log('\nRESULT');
  for (const [what, ok] of checks) log(`   ${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (checks.some(([, ok]) => !ok)) fail('sidebar switcher browser check failed');
  log('\nAll sidebar switcher browser checks passed.');
} finally {
  try { cdp?.close(); } catch { /* closing */ }
  child.kill('SIGKILL');
  await new Promise((r) => server.close(r));
}
