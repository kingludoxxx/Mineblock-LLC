// Domain Hub — background verify poll. Same in-process setInterval pattern
// as moneySweeps.js: single instance (this repo deploys one web service),
// started from the route module at load, DOMAIN_SWEEP_DISABLED=1 turns it
// off without a deploy.
//
// Each tick re-verifies every row still in pending_dns / verifying (bounded
// batch). Fail-open per row: one domain's DNS/API failure never blocks the
// others; error rows park (attachService bounds retries) and are skipped
// until an operator hits verify-now.
import { pgQuery } from '../../db/pg.js';
import { ensureDomainTables } from './schema.js';
import { verifyDomain } from './attachService.js';

// Clamped env tuning (a garbage/"0" value must never tight-loop the DNS
// resolver or the Render API).
function posInt(raw, dflt, min) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : dflt;
}
const TICK_MS = posInt(process.env.DOMAIN_SWEEP_TICK_MS, 60_000, 10_000);
const BATCH = posInt(process.env.DOMAIN_SWEEP_BATCH, 25, 1);

let timer = null;
let running = false;

export async function sweepOnce() {
  const stats = { checked: 0, connected: 0, errors: 0 };
  await ensureDomainTables();
  const rows = await pgQuery(
    `SELECT domain FROM lb_domains
     WHERE status IN ('pending_dns', 'verifying')
     ORDER BY last_check ASC NULLS FIRST
     LIMIT $1`,
    [BATCH]
  );
  for (const { domain } of rows) {
    try {
      const res = await verifyDomain(domain);
      stats.checked++;
      if (res.row?.status === 'connected') stats.connected++;
      if (res.row?.status === 'error') stats.errors++;
    } catch (err) {
      stats.errors++;
      console.error(`[domainSweep] verify failed for ${domain} (fail-open):`, err.message);
    }
  }
  return stats;
}

export function startDomainSweep() {
  if (timer) return timer; // idempotent — a double import must not double-tick
  if (String(process.env.DOMAIN_SWEEP_DISABLED || '') === '1') {
    console.log('[domainSweep] disabled via DOMAIN_SWEEP_DISABLED=1');
    return null;
  }
  timer = setInterval(async () => {
    if (running) return; // a slow tick must not overlap the next
    running = true;
    try {
      await sweepOnce();
    } catch (err) {
      console.error('[domainSweep] tick failed (fail-open):', err.message);
    } finally {
      running = false;
    }
  }, TICK_MS);
  if (timer.unref) timer.unref(); // never keep the process alive for the sweep
  console.log(`[domainSweep] started — tick ${TICK_MS}ms, batch ${BATCH}`);
  return timer;
}

export function stopDomainSweep() {
  if (timer) { clearInterval(timer); timer = null; }
}
