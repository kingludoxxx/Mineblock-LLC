#!/usr/bin/env node
// fleet — read and drive the Render services listed in scripts/fleet.services.json.
//
//   node scripts/fleet.mjs status
//   node scripts/fleet.mjs deploy <name> --commit <sha> [--dry-run]
//   node scripts/fleet.mjs rollback <name> [--dry-run]
//   node scripts/fleet.mjs env-diff <a> <b>
//
// Exit codes:  0 ok · 1 the operation ran and failed · 2 refused (usage, missing
// credential, a deploy without --commit).
//
// Rules this file enforces, not just documents:
//   R37  a deploy ALWAYS carries an explicit commitId. `deploy` without
//        --commit is refused before anything touches the network. A ref
//        (`HEAD`, a branch name) is refused too: only a hex sha is a commit.
//   R11  `pushed` is not `built` is not `live`. Everything printed here comes
//        from Render's deploy records, never from git.
//   R20  the API key is write-only. It is read at call time from
//        ~/.claude/settings.json, travels ONLY in an Authorization header, is
//        never interpolated into a URL, and every line this script prints is
//        scrubbed of it before it reaches stdout.
//   R15  no service name, id or host lives in this file. They are data.
//
// The module exports `main(argv, deps)` so the argument handling, the refusal
// paths and the request shapes can be tested with a mocked fetch and no network
// (server/tests/fleet/*.mjs).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SERVICES_PATH = path.join(HERE, 'fleet.services.json');

const TERMINAL = new Set(['live', 'build_failed', 'update_failed', 'canceled', 'deactivated', 'pre_deploy_failed']);
const ROLLBACK_OK = new Set(['live', 'deactivated']);
const POLL_INTERVAL_MS = 10_000;
const POLL_MAX = 120;                       // 20 minutes

const USAGE = [
  'usage: node scripts/fleet.mjs <command>',
  '',
  '  status                              live commit / status / finishedAt per service (read-only)',
  '  deploy <name> --commit <sha>        deploy an explicit commit (R37); --dry-run prints the request',
  '  rollback <name>                     redeploy the previous good commit; --dry-run prints the request',
  '  env-diff <a> <b>                    env KEY NAMES only, never values',
  '',
  '  --dry-run    print the request instead of sending it',
  '  --json       machine-readable output (status only)',
].join('\n');

// ── credentials ────────────────────────────────────────────────────────────
// The key lives in the Claude settings file, NOT in the repo and NOT in the
// environment. Read it late, use it once, never print it.
export function readKeyFromSettings() {
  const file = path.join(os.homedir(), '.claude', 'settings.json');
  let raw;
  try { raw = readFileSync(file, 'utf8'); }
  catch { throw new Error(`RENDER_API_KEY unavailable: cannot read ${file}`); }
  let key;
  try { key = JSON.parse(raw)?.mcpServers?.render?.env?.RENDER_API_KEY; }
  catch { throw new Error(`RENDER_API_KEY unavailable: ${file} is not valid JSON`); }
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error(`RENDER_API_KEY not found in ${file} (mcpServers.render.env.RENDER_API_KEY)`);
  }
  return key.trim();
}

// ── helpers ────────────────────────────────────────────────────────────────
const isSha = (s) => typeof s === 'string' && /^[0-9a-f]{7,40}$/i.test(s);
const short = (s) => (typeof s === 'string' ? s.slice(0, 7) : '—');
const pad = (s, n) => String(s == null ? '—' : s).padEnd(n);

function loadServices(file = SERVICES_PATH) {
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(cfg.services)) throw new Error(`${file}: no services array`);
  return cfg;
}

// Render list endpoints answer [{ deploy: {...}, cursor }]; single reads answer
// the object itself. Accept both rather than guessing.
const unwrapDeploy = (row) => (row && row.deploy ? row.deploy : row);
const unwrapEnv = (row) => (row && row.envVar ? row.envVar : row);

function makeClient({ fetch, key, api, log }) {
  const scrub = (s) => String(s).split(key).join('«REDACTED»');
  return async function call(url, { method = 'GET', body } = {}) {
    if (String(url).includes(key)) {
      // Never send a credential in a URL, whatever the caller thinks it is doing.
      throw new Error('refusing to build a URL that contains the API key');
    }
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = scrub(JSON.stringify(await res.json())).slice(0, 200); } catch { detail = ''; }
      const err = new Error(`HTTP ${res.status} ${detail}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  };
}

// ── commands ───────────────────────────────────────────────────────────────
async function cmdStatus({ cfg, call, log, json }) {
  const live = cfg.services.filter((s) => s.live && s.id);
  const rows = [];
  let failed = 0;
  for (const svc of live) {
    try {
      const list = await call(`${cfg.api}/services/${svc.id}/deploys?limit=1`);
      const d = unwrapDeploy(Array.isArray(list) ? list[0] : list);
      rows.push({ name: svc.name, id: svc.id, commit: d?.commit?.id || null, status: d?.status || 'unknown', finishedAt: d?.finishedAt || null, deployId: d?.id || null });
    } catch (e) {
      failed += 1;
      rows.push({ name: svc.name, id: svc.id, commit: null, status: `ERROR ${e.message}`, finishedAt: null, deployId: null });
    }
  }
  const placeholders = cfg.services.filter((s) => !s.live || !s.id);

  if (json) {
    log(JSON.stringify({ rows, placeholders: placeholders.map((p) => p.name) }, null, 2));
  } else {
    log(`${pad('SERVICE', 22)}${pad('COMMIT', 10)}${pad('STATUS', 22)}FINISHED (source: Render deploy record, R11)`);
    for (const r of rows) log(`${pad(r.name, 22)}${pad(short(r.commit), 10)}${pad(r.status, 22)}${r.finishedAt || '—'}`);
    for (const p of placeholders) log(`${pad(p.name, 22)}${pad('—', 10)}${pad('not provisioned', 22)}—`);
  }
  return failed ? 1 : 0;
}

async function cmdDeploy({ cfg, call, log, sleep, name, commit, dryRun }) {
  const svc = cfg.services.find((s) => s.name === name);
  if (!svc) { log(`fleet: unknown service "${name}". Known: ${cfg.services.map((s) => s.name).join(', ')}`); return 2; }
  if (!svc.id) { log(`fleet: "${name}" is a placeholder with no Render id — nothing to deploy`); return 2; }
  if (!commit) { log(`fleet: refusing to deploy ${name} without --commit <sha>. R37: every API deploy carries an explicit commitId, or it builds branch HEAD.`); return 2; }
  if (!isSha(commit)) { log(`fleet: --commit must be a hex sha, got "${commit}". R37: a ref is not a commit — resolve it first (git rev-parse).`); return 2; }

  const url = `${cfg.api}/services/${svc.id}/deploys`;
  const body = { commitId: commit, clearCache: 'do_not_clear' };
  if (dryRun) {
    log(`DRY RUN — would send:`);
    log(`POST ${url}`);
    log(`Authorization: Bearer «RENDER_API_KEY, not printed»`);
    log(JSON.stringify(body));
    return 0;
  }

  log(`POST ${url}  commitId=${commit}`);
  const created = await call(url, { method: 'POST', body });
  const deployId = created?.id || unwrapDeploy(created)?.id;
  if (!deployId) { log(`fleet: Render accepted the request but returned no deploy id`); return 1; }

  let state = created?.status || 'created';
  for (let i = 0; i < POLL_MAX && !TERMINAL.has(state); i += 1) {
    await sleep(POLL_INTERVAL_MS);
    const d = unwrapDeploy(await call(`${cfg.api}/services/${svc.id}/deploys/${deployId}`));
    if (d?.status && d.status !== state) { state = d.status; log(`  ${state}`); }
    else state = d?.status || state;
  }
  log(`deploy ${deployId} finished in state: ${state}`);
  if (state !== 'live') { log(`fleet: ${name} did NOT reach live (${state})`); return 1; }

  const health = await healthCheck({ call, svc, log });
  return health ? 0 : 1;
}

async function healthCheck({ call, svc, log }) {
  if (!svc.url) { log(`health: no url for ${svc.name}, skipped`); return true; }
  const url = `${svc.url}${svc.healthPath || '/api/health'}`;
  try {
    const body = await call(url);
    log(`health ${url} → ${JSON.stringify(body).slice(0, 200)}`);
    return true;
  } catch (e) {
    log(`health ${url} → FAILED: ${e.message}`);
    return false;
  }
}

async function cmdRollback({ cfg, call, log, sleep, name, dryRun }) {
  const svc = cfg.services.find((s) => s.name === name);
  if (!svc) { log(`fleet: unknown service "${name}". Known: ${cfg.services.map((s) => s.name).join(', ')}`); return 2; }
  if (!svc.id) { log(`fleet: "${name}" is a placeholder with no Render id — nothing to roll back`); return 2; }

  const list = (await call(`${cfg.api}/services/${svc.id}/deploys?limit=20`)).map(unwrapDeploy);
  if (!list.length) { log(`fleet: ${name} has no deploy history`); return 1; }
  const current = list[0];
  const target = list.slice(1).find((d) => ROLLBACK_OK.has(d.status) && d?.commit?.id && d.commit.id !== current?.commit?.id);
  if (!target) {
    log(`fleet: no earlier live/deactivated deploy of ${name} with a different commit than ${short(current?.commit?.id)} — refusing to "roll back" to the commit already running`);
    return 1;
  }
  log(`current  ${short(current?.commit?.id)}  ${current?.status}`);
  log(`rollback ${short(target.commit.id)}  ${target.status}  (deploy ${target.id}, ${target.finishedAt || 'no finishedAt'})`);
  return cmdDeploy({ cfg, call, log, sleep, name, commit: target.commit.id, dryRun });
}

async function cmdEnvDiff({ cfg, call, log, a, b }) {
  const pick = (n) => cfg.services.find((s) => s.name === n);
  const [sa, sb] = [pick(a), pick(b)];
  for (const [n, s] of [[a, sa], [b, sb]]) {
    if (!s) { log(`fleet: unknown service "${n}". Known: ${cfg.services.map((x) => x.name).join(', ')}`); return 2; }
    if (!s.id) { log(`fleet: "${n}" is a placeholder with no Render id`); return 2; }
  }
  // KEY NAMES ONLY. Values are read from the wire and immediately dropped: they
  // are never held in a variable that reaches a log line (R20).
  const keysOf = async (s) => {
    const rows = await call(`${cfg.api}/services/${s.id}/env-vars?limit=100`);
    return new Set(rows.map((r) => unwrapEnv(r)?.key).filter(Boolean).sort());
  };
  const [ka, kb] = [await keysOf(sa), await keysOf(sb)];
  const onlyA = [...ka].filter((k) => !kb.has(k));
  const onlyB = [...kb].filter((k) => !ka.has(k));
  const both = [...ka].filter((k) => kb.has(k));

  log(`env-diff ${a} vs ${b} — KEY NAMES ONLY, values are never read into output`);
  log(`  shared: ${both.length}`);
  log(`  only on ${a} (${onlyA.length}):`);
  for (const k of onlyA) log(`    ${k}`);
  log(`  only on ${b} (${onlyB.length}):`);
  for (const k of onlyB) log(`    ${k}`);
  log(`  asymmetric keys: ${onlyA.length + onlyB.length}`);
  return 0;
}

// ── entry point ────────────────────────────────────────────────────────────
export async function main(argv, deps = {}) {
  const log = deps.log || ((s) => console.log(s));
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const doFetch = deps.fetch || globalThis.fetch;

  const args = [...argv];
  const flag = (f) => { const i = args.indexOf(f); if (i < 0) return false; args.splice(i, 1); return true; };
  const value = (f) => {
    const i = args.indexOf(f);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, v === undefined ? 1 : 2);
    return v;
  };

  const dryRun = flag('--dry-run');
  const json = flag('--json');
  const hasCommitFlag = args.includes('--commit');
  const commitRaw = value('--commit');
  const cmd = args.shift();

  if (!cmd || cmd === '--help' || cmd === '-h') { log(USAGE); return cmd ? 0 : 2; }

  let cfg;
  try { cfg = loadServices(deps.servicesPath || SERVICES_PATH); }
  catch (e) { log(`fleet: ${e.message}`); return 2; }

  // Refusals that must never reach the network are decided BEFORE the key is read.
  if (cmd === 'deploy') {
    const name = args[0];
    if (!name) { log('fleet: deploy needs a service name\n' + USAGE); return 2; }
    const svc = cfg.services.find((s) => s.name === name);
    if (!svc) { log(`fleet: unknown service "${name}". Known: ${cfg.services.map((s) => s.name).join(', ')}`); return 2; }
    if (!hasCommitFlag || commitRaw === undefined || commitRaw.startsWith('--')) {
      log(`fleet: refusing to deploy ${name} without --commit <sha>. R37: every API deploy carries an explicit commitId, or it builds branch HEAD.`);
      return 2;
    }
    if (!isSha(commitRaw)) {
      log(`fleet: --commit must be a hex sha, got "${commitRaw}". R37: a ref is not a commit — resolve it first (git rev-parse).`);
      return 2;
    }
  }
  if (cmd === 'rollback' && !args[0]) { log('fleet: rollback needs a service name\n' + USAGE); return 2; }
  if (cmd === 'env-diff' && args.length < 2) { log('fleet: env-diff needs two service names\n' + USAGE); return 2; }
  if (!['status', 'deploy', 'rollback', 'env-diff'].includes(cmd)) { log(`fleet: unknown command "${cmd}"\n${USAGE}`); return 2; }
  if (cmd === 'deploy' && dryRun) {
    // dry-run prints the request and stops; no credential is needed to do that
    const name = args[0];
    const svc = cfg.services.find((s) => s.name === name);
    log('DRY RUN — would send:');
    log(`POST ${cfg.api}/services/${svc.id}/deploys`);
    log('Authorization: Bearer «RENDER_API_KEY, not printed»');
    log(JSON.stringify({ commitId: commitRaw, clearCache: 'do_not_clear' }));
    return 0;
  }

  let key;
  try { key = (deps.readKey || readKeyFromSettings)(); }
  catch (e) { log(`fleet: ${e.message}`); return 2; }

  const call = makeClient({ fetch: doFetch, key, api: cfg.api, log });
  const scrubbedLog = (s) => log(String(s).split(key).join('«REDACTED»'));

  try {
    if (cmd === 'status') return await cmdStatus({ cfg, call, log: scrubbedLog, json });
    if (cmd === 'deploy') return await cmdDeploy({ cfg, call, log: scrubbedLog, sleep, name: args[0], commit: commitRaw, dryRun });
    if (cmd === 'rollback') return await cmdRollback({ cfg, call, log: scrubbedLog, sleep, name: args[0], dryRun });
    if (cmd === 'env-diff') return await cmdEnvDiff({ cfg, call, log: scrubbedLog, a: args[0], b: args[1] });
  } catch (e) {
    scrubbedLog(`fleet: ${e.message}`);
    return 1;
  }
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}
