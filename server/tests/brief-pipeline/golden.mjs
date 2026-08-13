#!/usr/bin/env node
/**
 * Brief Pipeline golden-set regression harness.
 *
 * Runs every fixture through the LIVE generation path and asserts properties of
 * the result. It deliberately drives the real HTTP API rather than importing the
 * generator: the defects this exists to catch have all lived in the wiring
 * between steps, not in a function. A harness that passes a component mock data
 * proves the component renders, not that anything feeds it.
 *
 *   node server/tests/brief-pipeline/golden.mjs
 *   BASE=https://puure-dashboard.onrender.com EMAIL=... PASSWORD=... node ...
 *
 * Exit code is non-zero on any failure, so it can gate a deploy.
 *
 * Every assertion here exists because the corresponding defect reached the
 * operator at least once:
 *   - spec hooks ....... "Others use one red light. Ours uses three."
 *   - hook count ....... padding to five on a story that had four doors
 *   - frame retention .. "Three reasons why you SHOULDN'T" -> "...this works"
 *   - channel swap ..... "TikTok Shop" cloned into our own script, 3 times
 *   - body present ..... an 11,516-char source died as "body must be non-empty"
 *   - score present .... a hardcoded 8.4 on 41 of 41 briefs
 */

import { FIXTURES, SPEC_HOOK_RX } from './golden.fixtures.mjs';

const BASE = process.env.BASE || 'https://puure-dashboard.onrender.com';
const EMAIL = process.env.EMAIL || process.env.PUURE_EMAIL;
const PASSWORD = process.env.PASSWORD || process.env.PUURE_PASSWORD;
const PRODUCT_ID = Number(process.env.PRODUCT_ID || 37);
const PRODUCT_CODE = process.env.PRODUCT_CODE || 'PUURE';
const KEEP = process.env.KEEP === '1';   // leave briefs in the Kanban for inspection

if (!EMAIL || !PASSWORD) { console.error('EMAIL/PASSWORD (or PUURE_EMAIL/PUURE_PASSWORD) required'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function login() {
  const r = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const j = await r.json();
  if (!j.accessToken) throw new Error(`login failed (${r.status})`);
  return { authorization: `Bearer ${j.accessToken}`, 'content-type': 'application/json' };
}

async function generate(h, script) {
  const g = await (await fetch(`${BASE}/api/v1/brief-pipeline/generate-from-script`, {
    method: 'POST', headers: h,
    body: JSON.stringify({ script, productId: PRODUCT_ID, productCode: PRODUCT_CODE, mode: 'clone', numVariations: 1, model: 'claude' }),
  })).json();
  if (!g.winner_id) throw new Error(`kickoff failed: ${JSON.stringify(g).slice(0, 160)}`);
  for (let i = 0; i < 45; i++) {
    await sleep(10000);
    const s = await (await fetch(`${BASE}/api/v1/brief-pipeline/generation-status/${g.winner_id}`, { headers: h })).json();
    if (s.status === 'complete') {
      // hooks are enforced and the score is composed POST-insert; without this
      // wait the harness reads a half-finished row and reports false failures.
      await sleep(30000);
      const id = s.briefs?.[0]?.id;
      const b = (await (await fetch(`${BASE}/api/v1/brief-pipeline/generated/${id}`, { headers: h })).json()).brief;
      return { id, brief: b };
    }
    if (/fail|error/i.test(s.status || '')) throw new Error(`generation failed: ${JSON.stringify(s).slice(0, 200)}`);
  }
  throw new Error('generation timed out');
}

function assertions(fx, brief, sourceScript) {
  const out = [];
  const hooks = (brief.hooks || []).map(x => String(x.text || ''));
  const body = String(brief.body || '');
  const sj = typeof brief.scores_json === 'string' ? JSON.parse(brief.scores_json) : (brief.scores_json || {});
  const push = (name, ok, detail = '') => out.push({ name, ok, detail });

  push('body present', body.trim().length > 0, `${body.length} chars`);
  if (fx.minBodyChars) push('body not truncated', body.length >= fx.minBodyChars, `${body.length} >= ${fx.minBodyChars}`);

  push('score is real', typeof brief.overall_score === 'number' || (brief.overall_score && !isNaN(Number(brief.overall_score))),
       `score=${brief.overall_score}`);
  push('score is not the old constant', String(brief.overall_score) !== '8.4', `score=${brief.overall_score}`);

  const spec = hooks.filter(t => SPEC_HOOK_RX.test(t));
  push('no spec hooks', spec.length === 0, spec.join(' | ').slice(0, 90));

  const [lo, hi] = fx.hookCount || [1, 5];
  push(`hook count in [${lo},${hi}]`, hooks.length >= lo && hooks.length <= hi, `${hooks.length} hooks`);

  if (fx.requireHookPattern) {
    const hit = hooks.some(t => fx.requireHookPattern.test(t));
    push('signature device survives into a hook', hit, hit ? '' : `none of ${hooks.length} hooks match ${fx.requireHookPattern}`);
  }
  if (fx.requireAllHooksMatch) {
    const all = hooks.length > 0 && hooks.every(t => fx.requireAllHooksMatch.test(t));
    push('every hook carries the frame', all, all ? '' : hooks.filter(t => !fx.requireAllHooksMatch.test(t)).join(' | ').slice(0, 90));
  }
  if (fx.forbidBodyPattern) {
    const bad = fx.forbidBodyPattern.test(body);
    push("source's channel/date not cloned", !bad, bad ? String(body.match(fx.forbidBodyPattern)) : '');
  }
  if (fx.architecture) {
    const got = String(sj.architecture || brief.hook_architecture || '').toUpperCase();
    push(`architecture = ${fx.architecture}`, got === fx.architecture, `got "${got || 'ABSENT'}"`);
  }

  // length parity: a clone that is half its source dropped beats
  if (sourceScript) {
    const ratio = body.length / sourceScript.length;
    push('length parity 0.5x-2x of source', ratio >= 0.5 && ratio <= 2.0, `${(ratio * 100).toFixed(0)}%`);
  }
  return out;
}

(async () => {
  const h = await login();
  const storyScript = FIXTURES.find(f => f.id === 'story-vsl').script;
  let failed = 0, total = 0;
  const rows = [];

  for (const fx of FIXTURES) {
    let script = fx.script;
    if (fx.buildLong) { script = ''; while (script.length < 11516) script += storyScript + ' '; script = script.slice(0, 11516); }
    process.stdout.write(`\n▶ ${fx.id} (${script.length} chars) … `);
    let res;
    try { res = await generate(h, script); }
    catch (e) { console.log('GENERATION FAILED —', e.message); rows.push({ id: fx.id, pass: 0, fail: 1, notes: e.message }); failed++; total++; continue; }

    const checks = assertions(fx, res.brief, script);
    const bad = checks.filter(c => !c.ok);
    total += checks.length; failed += bad.length;
    console.log(`${checks.length - bad.length}/${checks.length} passed  (score ${res.brief.overall_score})`);
    for (const c of checks) console.log(`    ${c.ok ? '  ok' : 'FAIL'}  ${c.name}${c.detail ? `  — ${c.detail}` : ''}`);
    rows.push({ id: fx.id, pass: checks.length - bad.length, fail: bad.length, notes: bad.map(b => b.name).join(', ') });

    if (!KEEP && res.id) await fetch(`${BASE}/api/v1/brief-pipeline/generated/${res.id}`, { method: 'DELETE', headers: h });
  }

  console.log('\n' + '='.repeat(64));
  for (const r of rows) console.log(`  ${r.fail === 0 ? 'PASS' : 'FAIL'}  ${r.id.padEnd(20)} ${r.pass}/${r.pass + r.fail}${r.notes ? `   ${r.notes}` : ''}`);
  console.log('='.repeat(64));
  console.log(`${total - failed}/${total} assertions passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('harness error:', e.message); process.exit(2); });
