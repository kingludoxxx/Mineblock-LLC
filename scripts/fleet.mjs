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
//   R1/R3 a protected store (see `protection` in fleet.services.json) refuses
//        deploy and rollback unless the operator types the store name on the
//        command line: --i-typed-the-store-name=<Store>, matched EXACTLY,
//        case-sensitively. The bracket itself (snapshots, robot purchase,
//        30 min observed) stays a human process; this only enforces the
//        "typed store name" half of it.
//   R11  every real deploy prints a ROLLBACK ANCHOR first: the deploy id and
//        commit that are LIVE right now, read from Render, so the way back is
//        on the operator's screen before the way forward is taken.
//   R20  the key travels ONLY to the Render API host. A health check against an
//        app host is unauthenticated: `url` is data, and data must never be able
//        to redirect a credential.
//   R15  no service name, id, host or STORE name lives in this file. They are data.
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
const REQUEST_TIMEOUT_MS = 30_000;          // per request, so a hung call cannot hang a deploy

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
  '  --i-typed-the-store-name=<Store>   required to deploy or roll back a protected store (R1/R3)',
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
// A full, lowercase, 40-character sha and nothing else. A short or uppercase id
// is accepted by git and by a human eye, but Render's handling of one is
// unverified, and "resolve it first" is a one-command fix (git rev-parse HEAD).
const isSha = (s) => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
const SHA_HELP = 'must be a full 40-character lowercase hex sha (git rev-parse <ref>)';
const short = (s) => (typeof s === 'string' ? s.slice(0, 7) : '—');
const pad = (s, n) => String(s == null ? '—' : s).padEnd(n);

// R1/R3, as data. The code knows the RULE; fleet.services.json knows the store.
export function protectionFor(cfg, svc) {
  if (!svc) return null;
  const rules = Array.isArray(cfg.protection) ? cfg.protection : [];
  const byPrefix = rules.find((r) => r && r.prefix && String(svc.name).startsWith(r.prefix));
  if (byPrefix) return byPrefix;
  if (svc.protected) return { prefix: svc.name, store: svc.store || svc.name, rule: svc.notes || 'protected service' };
  return null;
}

// Returns a refusal message, or null when the command may proceed.
// The match is EXACT and CASE-SENSITIVE: a flag naming another store, or the
// right store in the wrong case, authorises nothing.
export function protectionRefusal({ cfg, svc, typedName, command }) {
  const p = protectionFor(cfg, svc);
  if (!p) return null;
  const how = `Re-run with --i-typed-the-store-name=${p.store} once the bracket is done`
    + ' (snapshots, robot purchase before and after, health, 30 min observed) and Ludo has typed the store name in chat.';
  if (typedName === undefined || typedName === '') {
    return `fleet: refusing to ${command} ${svc.name}: it belongs to a protected store (R1/R3). ${how}\n  ${p.rule}`;
  }
  if (typedName !== p.store) {
    return `fleet: --i-typed-the-store-name=${typedName} does not name the store that owns ${svc.name}.`
      + ` The match is exact and case-sensitive, and a flag copied from another command authorises nothing. ${how}`;
  }
  return null;
}

function loadServices(file = SERVICES_PATH) {
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(cfg.services)) throw new Error(`${file}: no services array`);
  return cfg;
}

// Render list endpoints answer [{ deploy: {...}, cursor }]; single reads answer
// the object itself. Accept both rather than guessing.
const unwrapDeploy = (row) => (row && row.deploy ? row.deploy : row);
const unwrapEnv = (row) => (row && row.envVar ? row.envVar : row);

function makeClient({ fetch, key, api }) {
  const scrub = (s) => String(s).split(key).join('«REDACTED»');
  return async function call(url, { method = 'GET', body } = {}) {
    const u = String(url);
    if (u.includes(key)) {
      // Never send a credential in a URL, whatever the caller thinks it is doing.
      throw new Error('refusing to build a URL that contains the API key');
    }
    // The Authorization header is attached ONLY for the Render API origin.
    // `url` comes from fleet.services.json, which is data: an edited or
    // compromised entry must not be able to make this script hand the platform
    // key to a host of its choosing.
    const toApi = u.startsWith(api);
    const res = await fetch(u, {
      method,
      headers: {
        ...(toApi ? { Authorization: `Bearer ${key}` } : {}),
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      let detail = '';
      // An env-vars error body can carry a VALUE. Report the status, nothing else.
      if (!u.includes('/env-vars')) {
        try { detail = scrub(JSON.stringify(await res.json())).slice(0, 200); } catch { detail = ''; }
      }
      const err = new Error(`HTTP ${res.status} ${detail}`.trim());
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
      // limit=5, not 1: the NEWEST deploy record is not necessarily the one
      // serving traffic. A failed or in-flight build sits in front of the live
      // one, and a column headed "live commit" must not print it (R11).
      const raw = await call(`${cfg.api}/services/${svc.id}/deploys?limit=5`);
      const arr = (Array.isArray(raw) ? raw : [raw]).map(unwrapDeploy).filter(Boolean);
      const newest = arr[0];
      const live = arr.find((x) => x.status === 'live');
      const d = live || newest;
      const newer = live && newest && newest.id !== live.id ? { commit: newest?.commit?.id || null, status: newest?.status || 'unknown' } : null;
      rows.push({ name: svc.name, id: svc.id, commit: d?.commit?.id || null, status: d?.status || 'unknown', finishedAt: d?.finishedAt || null, deployId: d?.id || null, isLive: !!live, newer });
    } catch (e) {
      failed += 1;
      rows.push({ name: svc.name, id: svc.id, commit: null, status: `ERROR ${e.message}`, finishedAt: null, deployId: null });
    }
  }
  const placeholders = cfg.services.filter((s) => !s.live || !s.id);

  if (json) {
    log(JSON.stringify({ rows, placeholders: placeholders.map((p) => p.name) }, null, 2));
  } else {
    log(`${pad('SERVICE', 22)}${pad('LIVE', 10)}${pad('STATUS', 22)}FINISHED (source: Render deploy record, R11)`);
    for (const r of rows) {
      log(`${pad(r.name, 22)}${pad(short(r.commit), 10)}${pad(r.status, 22)}${r.finishedAt || '—'}`);
      if (r.newer) log(`${' '.repeat(22)}newest deploy record is ${short(r.newer.commit)} (${r.newer.status}) — NOT what is serving traffic`);
    }
    for (const p of placeholders) log(`${pad(p.name, 22)}${pad('—', 10)}${pad('not provisioned', 22)}—`);
  }
  return failed ? 1 : 0;
}

// The way back, printed before the way forward is taken: the deploy id and
// commit that are LIVE right now, straight from Render (R11 — never from git).
async function liveAnchor({ cfg, call, svc }) {
  const raw = await call(`${cfg.api}/services/${svc.id}/deploys?limit=20`);
  const arr = (Array.isArray(raw) ? raw : [raw]).map(unwrapDeploy).filter(Boolean);
  const live = arr.find((d) => d.status === 'live');
  return live ? { id: live.id, commit: live?.commit?.id || null, finishedAt: live.finishedAt || null } : null;
}

async function cmdDeploy({ cfg, call, rawFetch, log, sleep, name, commit, dryRun, typedName, anchor }) {
  const svc = cfg.services.find((s) => s.name === name);
  if (!svc) { log(`fleet: unknown service "${name}". Known: ${cfg.services.map((s) => s.name).join(', ')}`); return 2; }
  if (!svc.id) { log(`fleet: "${name}" is a placeholder with no Render id — nothing to deploy`); return 2; }
  if (!commit) { log(`fleet: refusing to deploy ${name} without --commit <sha>. R37: every API deploy carries an explicit commitId, or it builds branch HEAD.`); return 2; }
  if (!isSha(commit)) { log(`fleet: --commit ${SHA_HELP}, got "${commit}". R37: a ref is not a commit — resolve it first (git rev-parse).`); return 2; }

  const url = `${cfg.api}/services/${svc.id}/deploys`;
  const body = { commitId: commit, clearCache: 'do_not_clear' };
  if (dryRun) {
    log(`DRY RUN — would send:`);
    log(`POST ${url}`);
    log(`Authorization: Bearer «RENDER_API_KEY, not printed»`);
    log(JSON.stringify(body));
    return 0;
  }

  // Checked again here, not only in main(): `rollback` reaches this function
  // directly, and a guard that only one caller passes through is not a guard.
  const refusal = protectionRefusal({ cfg, svc, typedName, command: 'deploy' });
  if (refusal) { log(refusal); return 2; }

  // R11: print the way back BEFORE taking the way forward.
  const back = anchor !== undefined ? anchor : await liveAnchor({ cfg, call, svc });
  if (back) {
    log(`ROLLBACK ANCHOR  ${name}  deploy ${back.id}  commit ${short(back.commit)}  (${back.finishedAt || 'no finishedAt'})`);
    log(`                 to undo: node scripts/fleet.mjs deploy ${name} --commit=${back.commit}`
      + `${protectionFor(cfg, svc) ? ` --i-typed-the-store-name=${protectionFor(cfg, svc).store}` : ''}`);
  } else {
    log(`ROLLBACK ANCHOR  ${name}: NO deploy record in status live — there is no verified way back.`);
    if (protectionFor(cfg, svc)) {
      log(`fleet: refusing to deploy a protected store with no rollback anchor. Check the Render dashboard first.`);
      return 2;
    }
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

  const health = await healthCheck({ rawFetch, svc, log });
  return health ? 0 : 1;
}

// UNAUTHENTICATED, deliberately: this is an app host, not the Render API, and
// /api/health is public. It uses the raw fetch so there is no code path at all
// by which the platform key could travel here (R20).
async function healthCheck({ rawFetch, svc, log }) {
  if (!svc.url) { log(`health: no url for ${svc.name}, skipped`); return true; }
  const url = `${svc.url}${svc.healthPath || '/api/health'}`;
  try {
    const res = await rawFetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const text = String(await res.text()).slice(0, 200);
    log(`health ${url} → HTTP ${res.status} ${text}`);
    return !!res.ok;
  } catch (e) {
    log(`health ${url} → FAILED: ${e.message}`);
    return false;
  }
}

async function cmdRollback({ cfg, call, rawFetch, log, sleep, name, dryRun, typedName }) {
  const svc = cfg.services.find((s) => s.name === name);
  if (!svc) { log(`fleet: unknown service "${name}". Known: ${cfg.services.map((s) => s.name).join(', ')}`); return 2; }
  if (!svc.id) { log(`fleet: "${name}" is a placeholder with no Render id — nothing to roll back`); return 2; }

  const list = (await call(`${cfg.api}/services/${svc.id}/deploys?limit=20`)).map(unwrapDeploy);
  if (!list.length) { log(`fleet: ${name} has no deploy history`); return 1; }

  // The deploy that is LIVE, never list[0]. After a failed, cancelled or
  // in-flight build the newest record is that build, and rolling back "away
  // from" it selects the commit that is already serving traffic: a no-op deploy
  // reported as a rollback, at the exact moment someone needs a real one.
  const currentIdx = list.findIndex((d) => d.status === 'live');
  if (currentIdx < 0) {
    log(`fleet: ${name} has no deploy record in status live among the last ${list.length}`);
    log(`fleet: refusing to guess what is running. Newest record: ${short(list[0]?.commit?.id)} (${list[0]?.status}). Check the Render dashboard.`);
    return 1;
  }
  const current = list[currentIdx];
  const target = list.slice(currentIdx + 1).find((d) => ROLLBACK_OK.has(d.status) && d?.commit?.id && d.commit.id !== current?.commit?.id);
  if (!target) {
    log(`fleet: no earlier live/deactivated deploy of ${name} with a different commit than ${short(current?.commit?.id)} — refusing to "roll back" to the commit already running`);
    return 1;
  }
  if (currentIdx > 0) log(`note     ${currentIdx} newer deploy record(s) are not live (newest: ${short(list[0]?.commit?.id)} ${list[0]?.status})`);
  log(`current  ${short(current?.commit?.id)}  ${current?.status}  (live, deploy ${current.id})`);
  log(`rollback ${short(target.commit.id)}  ${target.status}  (deploy ${target.id}, ${target.finishedAt || 'no finishedAt'})`);
  // The anchor is already in hand: pass it rather than re-reading the list.
  const anchor = { id: current.id, commit: current?.commit?.id || null, finishedAt: current.finishedAt || null };
  return cmdDeploy({ cfg, call, rawFetch, log, sleep, name, commit: target.commit.id, dryRun, typedName, anchor });
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
  // Both spellings: `--flag value` and `--flag=value`. Refusing the `=` form
  // with a "you forgot the flag" message sends the operator hunting for a
  // mistake they did not make.
  const value = (f) => {
    const iEq = args.findIndex((a) => a.startsWith(`${f}=`));
    if (iEq >= 0) { const v = args[iEq].slice(f.length + 1); args.splice(iEq, 1); return { present: true, value: v }; }
    const i = args.indexOf(f);
    if (i < 0) return { present: false, value: undefined };
    const v = args[i + 1];
    args.splice(i, v === undefined ? 1 : 2);
    return { present: true, value: v };
  };

  const dryRun = flag('--dry-run');
  const json = flag('--json');
  const typed = value('--i-typed-the-store-name');
  const typedName = typed.present ? typed.value : undefined;
  const commitFlag = value('--commit');
  const hasCommitFlag = commitFlag.present;
  const commitRaw = commitFlag.value;
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
      log(`fleet: --commit ${SHA_HELP}, got "${commitRaw}". R37: a ref is not a commit — resolve it first (git rev-parse).`);
      return 2;
    }
  }
  if (cmd === 'rollback' && !args[0]) { log('fleet: rollback needs a service name\n' + USAGE); return 2; }
  if (cmd === 'env-diff' && args.length < 2) { log('fleet: env-diff needs two service names\n' + USAGE); return 2; }
  if (!['status', 'deploy', 'rollback', 'env-diff'].includes(cmd)) { log(`fleet: unknown command "${cmd}"\n${USAGE}`); return 2; }

  // R1/R3, decided BEFORE the key is read and before anything touches the
  // network. --dry-run is exempt: it sends nothing, and reading the request a
  // protected deploy would make is exactly how an operator prepares a bracket.
  if ((cmd === 'deploy' || cmd === 'rollback') && !dryRun) {
    const svc = cfg.services.find((x) => x.name === args[0]);
    const refusal = protectionRefusal({ cfg, svc, typedName, command: cmd });
    if (refusal) { log(refusal); return 2; }
  }

  // A dry run is a deploy that stops before the network, so it goes through
  // cmdDeploy like any other: a second copy of the request-printing code is a
  // second copy of the refusals it is supposed to sit behind.
  if (cmd === 'deploy' && dryRun) {
    return await cmdDeploy({ cfg, call: null, rawFetch: null, log, sleep, name: args[0], commit: commitRaw, dryRun: true, typedName });
  }

  let key;
  try { key = (deps.readKey || readKeyFromSettings)(); }
  catch (e) { log(`fleet: ${e.message}`); return 2; }

  const call = makeClient({ fetch: doFetch, key, api: cfg.api });
  const scrubbedLog = (s) => log(String(s).split(key).join('«REDACTED»'));

  try {
    if (cmd === 'status') return await cmdStatus({ cfg, call, log: scrubbedLog, json });
    if (cmd === 'deploy') return await cmdDeploy({ cfg, call, rawFetch: doFetch, log: scrubbedLog, sleep, name: args[0], commit: commitRaw, dryRun, typedName });
    if (cmd === 'rollback') return await cmdRollback({ cfg, call, rawFetch: doFetch, log: scrubbedLog, sleep, name: args[0], dryRun, typedName });
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
