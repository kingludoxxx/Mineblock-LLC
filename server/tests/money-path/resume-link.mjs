// RECOVERY-LINK RESUME — exercises GET /resume/:token down its real paths
// against a throwaway scratch DB (real router, real token crypto, real rows).
import postgres from 'postgres';

const admin = postgres('postgres://puure@127.0.0.1:5433/postgres', { ssl: false, onnotice: () => {} });
await admin`DROP DATABASE IF EXISTS puure_resume_probe`;
await admin`CREATE DATABASE puure_resume_probe`;
await admin.end();

process.env.DATABASE_URL = 'postgres://puure@127.0.0.1:5433/puure_resume_probe';
process.env.CHECKOUT_RESUME_SECRET = 'resume-probe-secret';
process.env.TRACKING_SWEEPS_DISABLED = '1';
process.env.HEALTH_ALERTS_SWEEP_DISABLED = '1';

const { default: express } = await import('express');
const { pgQuery } = await import('../../src/db/pg.js');
const { signRecoveryToken } = await import('../../src/services/abandonedRecovery.js');
const { default: checkoutPublic } = await import('../../src/routes/checkoutPublic.js');
const { ensureTables } = await import('../../src/routes/funnels.js');
const { ensureCheckoutTables } = await import('../../src/services/checkoutSchema.js');

await ensureTables();
await ensureCheckoutTables();

await pgQuery(`INSERT INTO funnels (id, slug, name, status, archived) VALUES ('fnl_rp1','resume-probe','RP','published',FALSE)`);
await pgQuery(`INSERT INTO funnel_pages (id, funnel_id, slug, title, type, status, archived, is_home, blocks)
               VALUES ('fpg_rp1','fnl_rp1','/','Checkout','checkout','published',FALSE,TRUE,'[]')`);
await pgQuery(`INSERT INTO co_sessions (id, funnel_id, page_id, status, total, currency, customer, line_items)
               VALUES ('cos_open1','fnl_rp1','fpg_rp1','processing',49,'USD','{}','[]')`);
await pgQuery(`INSERT INTO co_sessions (id, funnel_id, page_id, status, total, currency, customer, line_items, paid_at)
               VALUES ('cos_paid1','fnl_rp1','fpg_rp1','paid',49,'USD','{}','[]',NOW())`);

const app = express();
app.use(express.json());
app.use('/api/v1/checkout/public', checkoutPublic);
const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${srv.address().port}/api/v1/checkout/public`;

let pass = 0, fail = 0;
const check = (cond, name, extra = '') => {
  if (cond) pass += 1; else { fail += 1; console.error('FAIL', name, extra); }
};
const hit = async (tok) => {
  const r = await fetch(`${base}/resume/${tok}`, { redirect: 'manual', headers: { host: 'probe.test' } });
  return { status: r.status, loc: r.headers.get('location') || '' };
};

// 1. Forged token -> 302 home
{
  const r = await hit('forged-garbage-token');
  check(r.status === 302 && r.loc === '/', 'forged -> 302 home', JSON.stringify(r));
}
// 2. Valid token, unpaid session -> 302 to the checkout page with resume params
{
  const tok = signRecoveryToken('funnel', 'cos_open1').token;
  const r = await hit(tok);
  check(r.status === 302
    && r.loc.includes('/f/resume-probe')
    && r.loc.includes('resume=cos_open1')
    && r.loc.includes('co_session_id=cos_open1'), 'unpaid -> checkout page w/ params', r.loc);
  const ev = await pgQuery(`SELECT kind FROM co_events WHERE session_id = 'cos_open1' AND kind = 'resume'`);
  check(ev.length === 1, 'resume event logged');
}
// 3. Valid token, PAID session -> never the form (no resume params), home or thank-you
{
  const tok = signRecoveryToken('funnel', 'cos_paid1').token;
  const r = await hit(tok);
  check(r.status === 302 && !r.loc.includes('resume='), 'settled never re-opens the form', r.loc);
}
// 4. Vanished session -> 302 home, indistinguishable from forged
{
  const tok = signRecoveryToken('funnel', 'cos_ghost').token;
  const r = await hit(tok);
  check(r.status === 302 && r.loc === '/', 'vanished ref -> 302 home', JSON.stringify(r));
}
// 5. Expired token -> 302 home
{
  const tok = signRecoveryToken('funnel', 'cos_open1', { now: new Date(Date.now() - 20 * 86400e3) }).token;
  const r = await hit(tok);
  check(r.status === 302 && r.loc === '/', 'expired -> 302 home', JSON.stringify(r));
}
// 6. No status mutation from any of the above
{
  const rows = await pgQuery(`SELECT id, status FROM co_sessions ORDER BY id`);
  check(rows.find((x) => x.id === 'cos_open1').status === 'processing'
    && rows.find((x) => x.id === 'cos_paid1').status === 'paid', 'no session status mutated');
}

srv.close();
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
