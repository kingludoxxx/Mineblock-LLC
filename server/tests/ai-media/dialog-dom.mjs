// AI MEDIA DIALOG — real-browser verification of the two runaway-loop bugs
// the adversarial review measured (MAJOR F1: 3,241 /media requests in 4s;
// MAJOR F2: 8 orphan poll chains with the dialog closed, +1 per reopen).
//
// Both are TIMING bugs in effect/timer lifecycles. A snapshot test cannot see
// them and a "read the code" argument is what let them ship, so this harness
// runs the REAL component in REAL chromium against a REAL http server and
// COUNTS THE REQUESTS THAT ARRIVE. The number on the server is the verdict.
//
// Nothing is stubbed on the client side: the component's own axios instance,
// its own effects and its own setTimeout chain are what produce the traffic.
//
// Pipeline:
//   1. write a throwaway entry that mounts <AiMediaDialog> plus an open/close
//      toggle, inside client/ so its imports resolve
//   2. bundle it with the project's own vite
//   3. serve the bundle + a mock /api/v1 that counts every hit
//   4. drive it with playwright and assert the counters
//
// Proves BY EXECUTION:
//   D1  a FAILING GET /media is requested ONCE, not in a loop, and the error
//       panel with "Try again" actually renders and survives
//   D2  "Try again" issues exactly one more request
//   D3  a job polls on a ~3s cadence while the dialog is open
//   D4  closing the dialog MID-FLIGHT stops the chain dead — zero further polls
//   D5  reopening arms exactly ONE chain, not one more per cycle
//
// Run:  node server/tests/ai-media/dialog-dom.mjs        (idempotent)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.resolve(HERE, '../../../client');
const TMP = path.join(CLIENT, '.tmp-aimedia-dom');

// package.json pins the browsers to a repo-local ./playwright-browsers. In a
// git WORKTREE that directory does not exist — node_modules is a symlink back
// to the primary checkout and the browsers live next to the REAL one. Resolve
// it from wherever node_modules actually is, so this runs unchanged in either
// place and no machine path is hardcoded.
function browsersPath() {
  const fromEnv = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const candidates = [path.resolve(HERE, '../../../playwright-browsers')];
  try {
    // node_modules may be a symlink; its real parent is the primary checkout.
    const realModules = fs.realpathSync(path.resolve(HERE, '../../../node_modules'));
    candidates.push(path.join(path.dirname(realModules), 'playwright-browsers'));
  } catch { /* no node_modules to follow — the first candidate stands */ }
  return candidates.find((c) => fs.existsSync(c)) || candidates[0];
}
process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath();

let pass = 0; let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass += 1; console.log(`PASS  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name}  ${extra}`); }
};

const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } };
cleanup();
fs.mkdirSync(TMP, { recursive: true });

// ── 1. the throwaway entry ─────────────────────────────────────────────────
fs.writeFileSync(path.join(TMP, 'entry.jsx'), `
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AiMediaDialog } from '../src/components/media';

function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button id="toggle" onClick={() => setOpen((v) => !v)}>toggle</button>
      <span id="state">{open ? 'open' : 'closed'}</span>
      <AiMediaDialog open={open} onClose={() => setOpen(false)} onSelect={() => {}} />
    </div>
  );
}
createRoot(document.getElementById('root')).render(<Harness />);
`);

fs.writeFileSync(path.join(TMP, 'vite.config.js'), `
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
  root: ${JSON.stringify(TMP)},
  plugins: [react(), tailwindcss()],
  build: {
    outDir: ${JSON.stringify(path.join(TMP, 'dist'))},
    emptyOutDir: true,
    rollupOptions: { input: ${JSON.stringify(path.join(TMP, 'entry.jsx'))} },
  },
});
`);

// ── 2. bundle it with the project's own vite ───────────────────────────────
try {
  execFileSync('npx', ['vite', 'build', '--config', path.join(TMP, 'vite.config.js')], {
    cwd: CLIENT, stdio: 'pipe',
  });
} catch (err) {
  console.error('BLOCKED: could not bundle the dialog —', String(err?.stderr || err?.message || err).slice(0, 800));
  cleanup();
  process.exit(2);
}

const distDir = path.join(TMP, 'dist');
const assets = fs.readdirSync(path.join(distDir, 'assets'));
const bundle = assets.find((f) => f.endsWith('.js'));
const css = assets.find((f) => f.endsWith('.css'));
if (!bundle) { console.error('BLOCKED: no bundle produced'); cleanup(); process.exit(2); }

// ── 3. the counting server ─────────────────────────────────────────────────
const counters = { media: 0, generate: 0, polls: 0 };
const cfg = { mediaStatus: 500, pollDelayMs: 1800 };

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8">
    ${css ? `<link rel="stylesheet" href="/assets/${css}">` : ''}
    </head><body><div id="root"></div>
    <script type="module" src="/assets/${bundle}"></script></body></html>`);
});
app.use('/assets', express.static(path.join(distDir, 'assets')));

app.get('/api/v1/media', (req, res) => {
  counters.media += 1;
  if (cfg.mediaStatus === 200) return res.json({ success: true, items: [], total: 0, has_more: false });
  return res.status(cfg.mediaStatus).json({ success: false, error: { code: 'boom', message: 'Could not load the media library.' } });
});

app.post('/api/v1/ai-media/generate', (req, res) => {
  counters.generate += 1;
  res.status(201).json({ success: true, jobs: [{ job_id: 'job_dom_test_1', job_token: 'f'.repeat(64), aspect: '9:16', quality: '1080p' }] });
});

// Deliberately SLOW, so "close the dialog while a poll is in flight" is easy
// to arrange — that is the exact window the old code scheduled its immortal
// next tick from.
app.get('/api/v1/ai-media/jobs/:id', (req, res) => {
  counters.polls += 1;
  setTimeout(() => {
    if (res.writableEnded) return;
    res.json({ success: true, data: { id: req.params.id, status: 'queued', url: null, media: null, aspect: '9:16', quality: '1080p' } });
  }, cfg.pollDelayMs);
});

const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ── 4. drive it ────────────────────────────────────────────────────────────
const { chromium } = await import('playwright');
const browser = await chromium.launch();
const page = await browser.newPage();
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e?.message || e)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Three poll cadences (3s each) — long enough that a missing tick is a signal
// and not jitter.
const WINDOW_MS = 9500;
// Poll requests that ARRIVE at the server in a fixed window. The server's
// counter is the only honest witness here: the client's own state would be
// asking the buggy code to report on itself.
const pollsIn = async (ms) => {
  const before = counters.polls;
  await sleep(ms);
  return counters.polls - before;
};
const waitUntil = async (fn, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
};

try {
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('text=CLAUDE × HIGGSFIELD', { timeout: 10_000 });
  check('D0 the dialog mounts in a real browser', true);

  // ═════════════════════════════════════════════════════════════════════════
  // D1 — a FAILING /media must be requested once, and the error must render
  // ═════════════════════════════════════════════════════════════════════════
  counters.media = 0;
  await page.click('text=From files');
  await waitUntil(async () => counters.media >= 1, 5000);
  await sleep(4000); // the review measured 3,241 requests in exactly this long

  check(`D1 a failing GET /media is requested ONCE in 4s (got ${counters.media})`,
    counters.media === 1, String(counters.media));

  const errorVisible = await page.isVisible('text=Could not load the media library.');
  check('D1 the error panel is rendered and survives', errorVisible, '');
  const retryVisible = await page.isVisible('button:has-text("Try again")');
  check('D1 the Try again affordance is reachable', retryVisible, '');

  // ═════════════════════════════════════════════════════════════════════════
  // D2 — Try again is an explicit re-entry, worth exactly one request
  // ═════════════════════════════════════════════════════════════════════════
  const beforeRetry = counters.media;
  await page.click('button:has-text("Try again")');
  await sleep(2500);
  check(`D2 Try again issues exactly one more request (got ${counters.media - beforeRetry})`,
    counters.media - beforeRetry === 1, String(counters.media - beforeRetry));

  // A SUCCESSFUL load must also settle at one request, not poll the endpoint.
  cfg.mediaStatus = 200;
  const beforeOk = counters.media;
  await page.click('button:has-text("Try again")');
  await sleep(3000);
  check(`D2 a successful load also settles at one request (got ${counters.media - beforeOk})`,
    counters.media - beforeOk === 1, String(counters.media - beforeOk));

  // ═════════════════════════════════════════════════════════════════════════
  // D3 — polling runs on its documented ~3s cadence while open
  // ═════════════════════════════════════════════════════════════════════════
  await page.click('text=Recent');
  await page.fill('#ai-media-prompt', 'a tactical water filter on a mountain ledge');
  counters.polls = 0;
  await page.click('button:has-text("Generate 1 image")');
  check('D3 the generate call was made', await waitUntil(async () => counters.generate === 1, 5000), String(counters.generate));

  // The BASELINE: what exactly one chain produces in a fixed window. Every
  // later measurement is compared against THIS, not against itself — a leak
  // that doubles the rate passes any assertion whose bound it also sets.
  await waitUntil(async () => counters.polls >= 1, 12_000);
  // The mock answers a poll after `pollDelayMs`, and the next tick is only
  // scheduled once that response lands, so one chain's real period is
  // ~3s + 1.8s. The absolute count is jitter-prone; what the later checks care
  // about is that it is ONE chain's worth, so the bound here is loose and the
  // comparisons below are relative to it.
  const baseline = await pollsIn(WINDOW_MS);
  check(`D3 one chain polls ${baseline}x per ${WINDOW_MS}ms while open`,
    baseline >= 1 && baseline <= 3, String(baseline));

  // ═════════════════════════════════════════════════════════════════════════
  // D4 — closing MID-FLIGHT kills the chain
  // The server answers a poll after 1.8s. Close the dialog the moment a poll
  // ARRIVES, so the response lands on a closed dialog — the precise window the
  // old code used to schedule its next, unreachable timer from.
  // ═════════════════════════════════════════════════════════════════════════
  const mark = counters.polls;
  await waitUntil(async () => counters.polls > mark, 8000);   // a poll is now in flight
  await page.click('#toggle');                                // close, mid-flight
  const stateClosed = await page.textContent('#state');
  check('D4 the dialog is closed', stateClosed === 'closed', String(stateClosed));

  const afterClose = await pollsIn(WINDOW_MS); // three cadences' worth
  check(`D4 ZERO polls after closing mid-flight (got ${afterClose} in ${WINDOW_MS}ms)`,
    afterClose === 0, String(afterClose));

  // ═════════════════════════════════════════════════════════════════════════
  // D5 — reopening arms ONE chain, not one more per cycle
  // ═════════════════════════════════════════════════════════════════════════
  await page.click('#toggle');                                // reopen
  await page.waitForSelector('text=CLAUDE × HIGGSFIELD');
  const rate1 = await pollsIn(WINDOW_MS);
  check(`D5 a reopen re-arms polling (got ${rate1})`, rate1 >= 1, String(rate1));
  check(`D5 one reopen is still ONE chain (${rate1} vs baseline ${baseline})`,
    rate1 <= baseline + 1, `${rate1} vs ${baseline}`);

  // Close/reopen twice more. A leak COMPOUNDS — each cycle strands another
  // chain — so three cycles is where a rate compared against a fixed baseline
  // stops being ambiguous.
  for (let i = 0; i < 2; i += 1) {
    await page.click('#toggle');
    await sleep(400);
    await page.click('#toggle');
    await page.waitForSelector('text=CLAUDE × HIGGSFIELD');
    await sleep(300);
  }
  const rate3 = await pollsIn(WINDOW_MS);
  check(`D5 after three open/close cycles the rate is STILL one chain (${rate3} vs baseline ${baseline})`,
    rate3 <= baseline + 1, `${rate3} vs baseline ${baseline}`);

  check('D5 no uncaught page errors during the whole run',
    consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 300));
} finally {
  await browser.close();
  server.close();
  cleanup();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
