#!/usr/bin/env node
// W9 REAL-BROWSER check for the ClickUp Pipeline page (R20).
//
// The page used to build its iframe src out of two literals — the launcher's host and its
// admin access token — which meant both were in the public bundle. The server side of the
// fix is proved by server/tests/video-launcher/route.mjs. This proves the BROWSER half,
// which is the half Ludo sees:
//
//   A. store WITH a launcher    an iframe is mounted, and its src is a SAME-ORIGIN path on
//                               this dashboard. No request leaves for any other host. The
//                               token and the host appear nowhere in the DOM or the page's
//                               javascript.
//   B. store WITHOUT one        the DISABLED panel, in words, naming the two env keys. NO
//                               iframe at all, no red error, nothing in the console, and
//                               the status poll STOPS (a disabled page does not poll
//                               forever).
//   C. the operator lacks the permission (403)  a quiet explanatory state, no red crash.
//   D. the tool is down (healthy:false)         the reconnecting overlay, still no direct
//                               call to any launcher origin.
//
// NOTHING LEAVES THE MACHINE: Chromium runs with --host-resolver-rules=MAP * 127.0.0.1:9,
// so a request to any host other than the harness is a connection to a dead port, and the
// check counts those attempts rather than trusting that none were made.
//
// Usage:  node scripts/browser-check-video-launcher.mjs [--shots <dir>]
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

const PAGE = '/dev/w9-launcher-check.html';
const log = (...a) => console.log(...a);
const fail = (msg) => { throw new Error(msg); };
const checks = [];
const check = (what, ok) => checks.push([what, Boolean(ok)]);

// The values that must NOT be in the browser. Shaped like the ones that leaked.
const FAKE_HOST = 'https://a-launcher-host.example.test';
const FAKE_TOKEN = 'mb-0000testtoken0000deadbeefcafe00';

/* ------------------------------------------------------------------ build */
log('building the harness page with the REAL ClickupPipeline source…');
const outDir = await mkdtemp(path.join(tmpdir(), 'w9-client-'));
const build = spawnSync('npx', ['vite', 'build', '--config', 'dev/w9-launcher-check.config.js'], {
  cwd: CLIENT, encoding: 'utf8', env: { ...process.env, W9_OUT_DIR: outDir },
});
if (build.status !== 0) fail(`vite build failed (${build.status}):\n${build.stdout}\n${build.stderr}`);
log(build.stdout.trim().split('\n').slice(-2).join('\n'));

/* ------------------------------------------------------ the fake dashboard */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

// 'configured' · 'unconfigured' · 'forbidden' · 'unhealthy'
let mode = 'configured';
let statusCalls = 0;
let embedCalls = 0;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };

  if (url.pathname === '/api/v1/video-launcher/status') {
    statusCalls += 1;
    if (mode === 'forbidden') return send(403, 'application/json', JSON.stringify({ error: 'Insufficient permissions' }));
    if (mode === 'unconfigured') {
      return send(200, 'application/json', JSON.stringify({
        configured: false, healthy: null, reason: 'not_configured',
        missing: { VIDEO_LAUNCHER_URL: true, VIDEO_LAUNCHER_TOKEN: true },
      }));
    }
    return send(200, 'application/json', JSON.stringify({
      configured: true, healthy: mode !== 'unhealthy', reason: null,
    }));
  }
  // The real route answers 302 into the launcher here. The harness answers a plain
  // document instead: this check is about what the BROWSER holds, and following a
  // redirect to a dead host would only prove the resolver rules work.
  if (url.pathname === '/api/v1/video-launcher/open/app') {
    embedCalls += 1;
    return send(200, 'text/html; charset=utf-8', '<html><body data-w9-embed="1">the launcher would be here</body></html>');
  }
  if (url.pathname.startsWith('/api/')) return send(200, 'application/json', JSON.stringify({ success: true, data: null }));
  try {
    const file = path.join(outDir, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(outDir)) return send(403, 'text/plain', 'no');
    const body = await readFile(file);
    return send(200, TYPES[path.extname(file)] || 'application/octet-stream', body);
  } catch { return send(404, 'text/plain', 'not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
log(`serving the built page + a fake /api/v1/video-launcher at ${BASE}`);

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
  const file = path.join(shotDir, `w9-${name}.png`);
  await writeFile(file, Buffer.from(data, 'base64'));
  log(`   screenshot: ${file}`);
  return file;
}

// Everything a person would call "a red error", plus the credential scan that is the
// point of this lane: the two leaked shapes must be in NO text, NO attribute and NO
// script the browser holds.
const SCAN = `(async () => {
  const out = { redBoxes: [], errorText: [], iframes: [], leaks: [] };
  const body = document.body.innerText || '';
  if (/status code 40\\d|status code 5\\d\\d|Request failed|Network Error/i.test(body)) {
    out.errorText = body.split('\\n').filter((l) => /status code|Request failed|Network Error/i.test(l));
  }
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    const isRed = (c) => { const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(c); if (!m) return false;
      const [r, g, b] = [ +m[1], +m[2], +m[3] ]; return r > 150 && g < 110 && b < 110; };
    if ((isRed(cs.backgroundColor) || isRed(cs.borderTopColor)) && el.innerText && el.innerText.trim()) {
      out.redBoxes.push(el.innerText.trim().slice(0, 80));
    }
  }
  out.redBoxes = [...new Set(out.redBoxes)].slice(0, 5);
  out.iframes = [...document.querySelectorAll('iframe')].map((f) => f.getAttribute('src'));
  // the whole document, every attribute, plus every script the page loaded
  let hay = document.documentElement.outerHTML;
  for (const s of document.querySelectorAll('script[src]')) {
    try { hay += await (await fetch(s.src)).text(); } catch (e) { hay += ' FETCH_FAILED ' + s.src; }
  }
  for (const needle of ['${FAKE_HOST}', '${FAKE_TOKEN}', 'a-launcher-host', 'access=']) {
    if (hay.includes(needle)) out.leaks.push(needle);
  }
  out.hayLen = hay.length;
  out.bodyText = body.replace(/\\n+/g, ' | ').trim().slice(0, 400);
  return out;
})()`;

const chromium = await findChromium();
const profile = await mkdtemp(path.join(tmpdir(), 'w9-chrome-'));
const child = spawn(chromium, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, '--remote-debugging-port=0',
  '--host-resolver-rules=MAP * 127.0.0.1:9, EXCLUDE 127.0.0.1',
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

// Every request the page makes, and every console message it writes.
let requests = [];
let consoleMsgs = [];

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
  await cdp.send('Page.enable', {}, sid);
  await cdp.send('Runtime.enable', {}, sid);
  await cdp.send('Network.enable', {}, sid);
  cdp.on('Network.requestWillBeSent', (p) => requests.push(p.request.url));
  cdp.on('Runtime.consoleAPICalled', (p) => consoleMsgs.push(`${p.type}: ${(p.args || []).map((a) => a.value ?? a.description ?? '').join(' ')}`));
  cdp.on('Runtime.exceptionThrown', (p) => consoleMsgs.push(`exception: ${p.exceptionDetails?.exception?.description || p.exceptionDetails?.text}`));

  const open = async (m, waitFor) => {
    mode = m; statusCalls = 0; embedCalls = 0; requests = []; consoleMsgs = [];
    await cdp.send('Page.navigate', { url: `${BASE}${PAGE}` }, sid);
    await until(waitFor.label, async () => await evaluate(waitFor.expr));
    await sleep(700);
  };
  // The app's own stylesheet imports Google Fonts (client/src/index.css). That request
  // pre-dates this lane, is not a launcher call, and is dead anyway under the resolver
  // rules — so it is EXCLUDED by name rather than quietly swept into "no other origin".
  const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;
  const offOrigin = () => requests.filter((u) =>
    !u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('about:') && !FONTS.test(u));
  // The question this lane actually asks of the network: did anything carrying the
  // launcher host or an access token leave the browser?
  const credRequests = () => requests.filter((u) =>
    u.includes('a-launcher-host') || u.includes(FAKE_TOKEN) || /[?&]access=/.test(u));

  // ── A. a store WITH a launcher ────────────────────────────────────────────
  await open('configured', { label: 'the iframe', expr: `!!(document.body && document.querySelector('iframe'))` });
  const a = await evaluate(SCAN);
  log(`A. configured -> statusCalls=${statusCalls} embedCalls=${embedCalls} iframes=${JSON.stringify(a.iframes)} offOrigin=${JSON.stringify(offOrigin())}`);
  check('A: an iframe is mounted', a.iframes.length === 1);
  check('A: its src is a SAME-ORIGIN path on this dashboard, not a launcher host',
    typeof a.iframes[0] === 'string' && a.iframes[0].startsWith('/api/v1/video-launcher/open/app'));
  check('A: the browser loaded that embed through this server', embedCalls >= 1);
  check('A: the browser made NO request to any other origin', offOrigin().length === 0);
  check('A: NO request carried a launcher host or an access token', credRequests().length === 0);
  check('A: the host and the token are in no DOM node and no loaded script', a.leaks.length === 0);
  check('A: the scan actually read the page javascript (a zero leak count means something)', a.hayLen > 50000);
  check('A: no red error', a.redBoxes.length === 0 && a.errorText.length === 0);
  check('A: nothing written to the console', consoleMsgs.length === 0);
  await shot('A-configured');

  // ── B. a store WITHOUT one: the disabled state ────────────────────────────
  await open('unconfigured', { label: 'the disabled panel', expr: `!!document.body && /not configured for this store/i.test(document.body.innerText)` });
  const b = await evaluate(SCAN);
  const callsAfterFirst = statusCalls;
  await sleep(1200);
  log(`B. unconfigured -> statusCalls=${statusCalls} iframes=${JSON.stringify(b.iframes)} console=${JSON.stringify(consoleMsgs)}`);
  log(`   text: ${b.bodyText}`);
  check('B: the disabled panel is shown, in words', /not configured for this store/i.test(b.bodyText));
  check('B: it names both env keys so the operator knows what to set',
    b.bodyText.includes('VIDEO_LAUNCHER_URL') && b.bodyText.includes('VIDEO_LAUNCHER_TOKEN'));
  check('B: NO iframe is mounted at all', b.iframes.length === 0);
  check('B: nothing was loaded through the embed route', embedCalls === 0);
  check('B: no request left for any other origin', offOrigin().length === 0);
  check('B: no request carried a launcher host or an access token', credRequests().length === 0);
  check('B: no red error anywhere', b.redBoxes.length === 0 && b.errorText.length === 0);
  check('B: the console is clean — no failed call, no warning', consoleMsgs.length === 0);
  check('B: the status poll STOPPED once the answer was "no launcher here"', statusCalls === callsAfterFirst);
  check('B: the host and the token are nowhere in the page', b.leaks.length === 0);
  await shot('B-disabled');

  // ── C. the operator does not hold brief-pipeline:access ───────────────────
  await open('forbidden', { label: 'the refusal state', expr: `!!document.body && /does not open the pipeline/i.test(document.body.innerText)` });
  const c = await evaluate(SCAN);
  log(`C. 403 -> ${c.bodyText}`);
  check('C: a quiet explanation, not a crash', /does not open the pipeline/i.test(c.bodyText));
  check('C: no axios failure text on the page', c.errorText.length === 0);
  check('C: no iframe was mounted for a request the server refused', c.iframes.length === 0);
  await shot('C-forbidden');

  // ── D. the launcher is down ───────────────────────────────────────────────
  await open('unhealthy', { label: 'the reconnecting overlay', expr: `!!document.body && /Pipeline is restarting/i.test(document.body.innerText)` });
  const d = await evaluate(SCAN);
  log(`D. unhealthy -> ${d.bodyText}`);
  check('D: the reconnecting overlay is shown', /Pipeline is restarting/i.test(d.bodyText));
  check('D: the page still never talks to a launcher origin itself', offOrigin().length === 0);
  check('D: no request carried a launcher host or an access token', credRequests().length === 0);
  check('D: and still holds neither host nor token', d.leaks.length === 0);
  await shot('D-unhealthy');

  // ── POSITIVE CONTROL for the leak scan ────────────────────────────────────
  // The scan reports 0 leaks above. Prove that a 0 means something by planting the
  // exact strings in the page and re-running the identical scan: it must find them.
  await evaluate(`(() => {
    const n = document.createElement('div');
    n.textContent = '${FAKE_HOST}/?access=${FAKE_TOKEN}';
    n.style.display = 'none';
    document.body.appendChild(n);
    return true;
  })()`);
  const ctl = await evaluate(SCAN);
  log(`CONTROL. after planting the strings -> leaks=${JSON.stringify(ctl.leaks)}`);
  check('CONTROL: the leak scan BITES when the host and the token really are on the page',
    ctl.leaks.includes(FAKE_HOST) && ctl.leaks.includes(FAKE_TOKEN) && ctl.leaks.includes('access='));

  log('\nRESULT');
  for (const [what, okv] of checks) log(`   ${okv ? 'PASS' : 'FAIL'}  ${what}`);
  const bad = checks.filter(([, okv]) => !okv).length;
  log(`\n${checks.length - bad} passed, ${bad} failed`);
  if (bad) fail('video launcher browser check failed');
  log('All video-launcher browser checks passed.');
} finally {
  try { cdp?.close(); } catch { /* closing */ }
  child.kill('SIGKILL');
  await new Promise((r) => server.close(r));
}
