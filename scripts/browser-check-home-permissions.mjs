#!/usr/bin/env node
// W8b REAL-BROWSER check for the HOME PAGE and the permission it does not have.
//
// Ludo hopped into the brand-new Throwaway store through the hub and the home page showed a red
// "Request failed with status code 403". GET /api/v1/kpi-system/home-dashboard sits behind
// requirePermission('kpi-system', 'access') (server/src/routes/kpiSystem.js:259) and the page asked for
// it regardless of who was looking.
//
// This drives a real headless Chromium over the DevTools Protocol (Node 22's built-in WebSocket, no new
// dependency), builds the REAL client — the REAL Dashboard page, the REAL usePermissions hook, the REAL
// axios client — into a temp directory, serves it next to a REAL HTTP API, and asserts, per fixture:
//
//   A. WITH kpi-system:access      the request is made and the KPI cards render
//   B. WITHOUT kpi-system:access   NO request is made at all, there is no red error anywhere on the
//                                  page, and a quiet "not available for your role" card stands in its
//                                  place. The rest of the page still renders.
//   C. WITH the permission but the network down   the RED retry banner is still shown (the failure path
//                                  this lane must not silence)
//   D. WITH the permission and a real 403 from the server   still no red banner: the page reads the
//                                  status and shows the same quiet card (the server is the authority)
//
// NOTHING LEAVES THE MACHINE: Chromium runs with --host-resolver-rules=MAP * 127.0.0.1:9.
//
// Usage:  node scripts/browser-check-home-permissions.mjs [--shots <dir>]
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

const PAGE = '/dev/switcher-check.html';
const log = (...a) => console.log(...a);
const fail = (msg) => { throw new Error(msg); };
const checks = [];
const check = (what, ok) => checks.push([what, Boolean(ok)]);

/* ------------------------------------------------------------------ build */
log('building the harness page with the REAL client sources…');
const outDir = await mkdtemp(path.join(tmpdir(), 'w8-client-'));
const build = spawnSync('npx', ['vite', 'build', '--config', 'dev/switcher-check.config.js'], {
  cwd: CLIENT, encoding: 'utf8', env: { ...process.env, W6_OUT_DIR: outDir },
});
if (build.status !== 0) fail(`vite build failed (${build.status}):\n${build.stdout}\n${build.stderr}`);
log(build.stdout.trim().split('\n').slice(-2).join('\n'));

/* ------------------------------------------------------- the fake dashboard */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// 'ok' answers the KPI payload · 'forbidden' answers the REAL 403 the server sends · 'down' never answers.
let kpiMode = 'ok';
let kpiCalls = 0;
const today = new Date();
const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
const KPI_PAYLOAD = {
  success: true,
  data: {
    serverDate: todayStr, latestSnapshotDate: todayStr,
    current: { revenue: 12345.67, adSpend: 4321, orders: 88, profit: 2222, netMargin: 18, roas: 2.85 },
    previous: { revenue: 10000, adSpend: 4000, orders: 70, profit: 1500, netMargin: 15, roas: 2.5 },
    sparklines: [], chartData: [],
  },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  if (url.pathname === '/api/v1/kpi-system/home-dashboard') {
    kpiCalls += 1;
    if (kpiMode === 'down') { req.socket.destroy(); return undefined; }
    if (kpiMode === 'forbidden') {
      // byte-for-byte the shape middleware/permissions.js sends
      return send(403, 'application/json', JSON.stringify({ success: false, error: { message: 'Insufficient permissions' } }));
    }
    return send(200, 'application/json', JSON.stringify(KPI_PAYLOAD));
  }
  // the shell's own reads: no hub (R21 path — this check is about the home page, not the switcher)
  if (url.pathname === '/api/v1/store-config') {
    return send(200, 'application/json', JSON.stringify({ success: true, data: { storeCode: 'TW', brand: {}, hub: { origin: null, sso_enabled: false }, switcher: { current: 'TW', stores: [] } } }));
  }
  if (url.pathname === '/api/v1/brand') {
    return send(200, 'application/json', JSON.stringify({ success: true, data: { name: 'Throwaway Ltd', shortName: 'Throwaway', logoWhite: null, logoSymbol: null, logoBlack: null, emailDomain: 'throwaway.test' } }));
  }
  if (url.pathname.startsWith('/api/')) return send(200, 'application/json', JSON.stringify({ success: true, data: null }));
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
log(`serving the built shell + a fake kpi-system at ${BASE}`);

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
async function until(label, fn, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) fail(`timed out waiting for ${label}`); await sleep(120); }
}
async function shot(name) {
  if (!shotDir) return null;
  await mkdir(shotDir, { recursive: true });
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
  const file = path.join(shotDir, `w8b-${name}.png`);
  await writeFile(file, Buffer.from(data, 'base64'));
  log(`   screenshot: ${file}`);
  return file;
}

/**
 * Everything a person would call "a red error" on this page: the error banner's own test id, plus a
 * SHAPE scan — any element whose computed text contains an axios failure string, and any element
 * painted in the shell's error red. The shape scan is what stops the fix being "rename the banner".
 */
const RED_SCAN = `(() => {
  const out = { banner: !!document.querySelector('[data-testid="dashboard-error"]'), axiosText: [], redBoxes: [] };
  const body = document.body.innerText || '';
  if (/status code 40\\d|status code 5\\d\\d|Request failed|Network Error/i.test(body)) {
    out.axiosText = body.split('\\n').filter((l) => /status code|Request failed|Network Error/i.test(l));
  }
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    const bg = cs.backgroundColor, bc = cs.borderTopColor;
    const isRed = (c) => { const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(c); if (!m) return false;
      const [r, g, b] = [ +m[1], +m[2], +m[3] ]; return r > 150 && g < 110 && b < 110; };
    if ((isRed(bg) || isRed(bc)) && el.innerText && el.innerText.trim()) out.redBoxes.push(el.innerText.trim().slice(0, 80));
  }
  out.redBoxes = [...new Set(out.redBoxes)].slice(0, 5);
  return out;
})()`;

const chromium = await findChromium();
const profile = await mkdtemp(path.join(tmpdir(), 'w8-chrome-'));
const child = spawn(chromium, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, '--remote-debugging-port=0',
  '--host-resolver-rules=MAP * 127.0.0.1:9, EXCLUDE 127.0.0.1',
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

try {
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    child.stderr.on('data', (d) => { buf += d; const m = buf.match(/ws:\/\/[^\s]+/); if (m) resolve(m[0]); });
    child.on('exit', (c) => reject(new Error(`chromium exited ${c}: ${buf}`)));
    setTimeout(() => reject(new Error(`chromium never printed a DevTools url: ${buf}`)), 20000);
  });
  const version = await (await fetch(wsUrl.replace(/^ws:\/\/([^/]+)\/.*/, 'http://$1/json/version'))).json();
  log(`browser: ${version.Browser} at ${chromium}`);
  cdp = await Cdp.connect(wsUrl);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  ({ sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  await cdp.send('Page.enable', {}, sid); await cdp.send('Runtime.enable', {}, sid); await cdp.send('Network.enable', {}, sid);

  const openHome = async (perms) => {
    await cdp.send('Page.navigate', { url: `${BASE}${PAGE}?view=dashboard&perms=${perms}` }, sid);
    await until('the home page', async () => await evaluate(`!!document.querySelector('[data-testid="home-dashboard"]')`));
    await sleep(900);   // the page's own fetch + one render
  };

  // ── A. a user WITH kpi-system:access ──────────────────────────────────────
  kpiMode = 'ok'; kpiCalls = 0;
  await openHome('all');
  const withPerm = await evaluate(`({
    calls: 0,
    kpiCards: document.querySelectorAll('[data-testid="kpi-card"]').length,
    gate: !!document.querySelector('[data-testid="kpi-no-access"]'),
    revenue: (document.body.innerText.match(/12,345/) || [null])[0],
    red: ${RED_SCAN},
  })`);
  log(`A. with kpi-system:access -> requests=${kpiCalls} cards=${withPerm.kpiCards} gateCard=${withPerm.gate} red=${JSON.stringify(withPerm.red)}`);
  check('A: the page asks for the KPI data when the user may have it', kpiCalls >= 1);
  check('A: the KPI cards render', withPerm.kpiCards >= 5);
  check('A: the numbers the API sent are on the page', withPerm.revenue !== null);
  check('A: no gate card when there is nothing to gate', withPerm.gate === false);
  check('A: no red error', withPerm.red.banner === false && withPerm.red.axiosText.length === 0);
  await shot('A-with-permission');

  // ── B. a user WITHOUT it: the defect Ludo saw ─────────────────────────────
  kpiMode = 'forbidden'; kpiCalls = 0;
  await openHome('none');
  const noPerm = await evaluate(`({
    gate: !!document.querySelector('[data-testid="kpi-no-access"]'),
    gateText: document.querySelector('[data-testid="kpi-no-access"]')?.innerText.replace(/\\n/g, ' ').trim() || null,
    kpiCards: document.querySelectorAll('[data-testid="kpi-card"]').length,
    heading: document.querySelector('[data-testid="home-dashboard"] h1')?.innerText || null,
    red: ${RED_SCAN},
  })`);
  log(`B. WITHOUT kpi-system:access -> requests=${kpiCalls} gateCard=${noPerm.gate} text=${JSON.stringify(noPerm.gateText)} red=${JSON.stringify(noPerm.red)}`);
  check('B: the page makes NO request it is not allowed to make', kpiCalls === 0);
  check('B: no red error banner', noPerm.red.banner === false);
  check('B: no axios failure text anywhere on the page', noPerm.red.axiosText.length === 0);
  check('B: nothing on the page is painted in the error red', noPerm.red.redBoxes.length === 0);
  check('B: a quiet card stands in for the KPI block', noPerm.gate === true);
  check('B: the card says what it is, in words, and names no status code',
    Boolean(noPerm.gateText) && /role/i.test(noPerm.gateText) && !/40\d|error|failed/i.test(noPerm.gateText));
  check('B: the rest of the page is unaffected', noPerm.heading === 'Dashboard');
  check('B: and the KPI cards themselves are gone, not blank', noPerm.kpiCards === 0);
  await shot('B-without-permission');

  // ── C. the FAILURE PATH this lane must not silence ────────────────────────
  kpiMode = 'down'; kpiCalls = 0;
  await openHome('all');
  await sleep(4200);   // the page retries twice (1 s, 2 s) before it gives up
  const down = await evaluate(`({
    banner: !!document.querySelector('[data-testid="dashboard-error"]'),
    retry: !!document.querySelector('[data-testid="dashboard-retry"]'),
    gate: !!document.querySelector('[data-testid="kpi-no-access"]'),
  })`);
  log(`C. network down, WITH the permission -> requests=${kpiCalls} banner=${down.banner} retry=${down.retry} gate=${down.gate}`);
  check('C: a real network failure still shows the retry banner', down.banner === true && down.retry === true);
  check('C: a network failure is NOT reported as a permission problem', down.gate === false);
  // Chromium re-opens an idempotent GET whose connection died before any response, so the SERVER can see
  // more hits than the page made attempts. Three is the floor the page's own retry loop guarantees.
  check('C: the page really did retry (at least the 3 attempts its loop promises)', kpiCalls >= 3);
  await shot('C-network-down');

  // ── D. the server is the authority: a 403 the client did not predict ──────
  kpiMode = 'forbidden'; kpiCalls = 0;
  await openHome('all');
  const server403 = await evaluate(`({
    gate: !!document.querySelector('[data-testid="kpi-no-access"]'),
    red: ${RED_SCAN},
  })`);
  log(`D. server says 403 although the client thought it was allowed -> requests=${kpiCalls} gate=${server403.gate} red=${JSON.stringify(server403.red)}`);
  check('D: the request was made (the client believed it was allowed)', kpiCalls === 1);
  check('D: a 403 from the server is shown as the same quiet card, never a red error',
    server403.gate === true && server403.red.banner === false && server403.red.axiosText.length === 0);
  await shot('D-server-403');

  log('\nRESULT');
  for (const [what, ok] of checks) log(`   ${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (checks.some(([, ok]) => !ok)) fail('home page permission browser check failed');
  log('\nAll home-page permission browser checks passed.');
} finally {
  try { cdp?.close(); } catch { /* closing */ }
  child.kill('SIGKILL');
  await new Promise((r) => server.close(r));
}
