// Verification harness for the split-testing DELIVERY half
// (services/splitDelivery.js + the funnelPublic/checkoutPublic wiring).
// Drives the REAL resolvePageSplit/recordView/resolveOfferArmOverride against
// embedded PG. Asserts: sticky same-arm serving, cross-visitor distribution,
// dark-arm re-pick, entry-arm fallback for id-less visitors, disabled/archived
// no-op, nested-path refusal, view idempotency, visitors in readResults, and
// fail-open on a broken DB.
//
// Run:  node server/tests/money-path/split-delivery.mjs
process.env.DATABASE_URL = 'postgres://puure@127.0.0.1:5433/puure_shoporder';
process.env.NODE_ENV = 'development';
process.env.MONEY_SWEEP_DISABLED = '1';

const NM = '/Users/ludo/Mineblock-LLC/node_modules';
const postgres = (await import(`${NM}/postgres/src/index.js`)).default;
const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });
// pgQuery-shaped adapter over the harness connection.
const q = (text, params = []) => sql.unsafe(text, params);

const { resolvePageSplit, recordView } = await import('../../src/services/splitDelivery.js');
const { ensureSplitTables } = await import('../../src/services/splitTestSchema.js');
const { readResults } = await import('../../src/services/splitCredits.js');
const { pickArm, SPLIT_DELIVERY_WIRED } = await import('../../src/services/splitResolver.js');

await ensureSplitTables(q);
// Minimal funnel_pages for the serve-side lookup (IF NOT EXISTS — harmless if
// the full funnels DDL already ran on this database).
await q(`CREATE TABLE IF NOT EXISTS funnel_pages (
  id TEXT PRIMARY KEY, funnel_id TEXT, slug TEXT, type TEXT, title TEXT,
  status TEXT DEFAULT 'draft', archived BOOLEAN DEFAULT FALSE, is_home BOOLEAN DEFAULT FALSE
)`);
await q(`CREATE TABLE IF NOT EXISTS co_upsells (
  id TEXT PRIMARY KEY, funnel_id TEXT, page_id TEXT, variant_id TEXT DEFAULT '',
  price NUMERIC(12,2), title TEXT, enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
)`);

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}  ${extra}`); } };

const FID = 'fnl_splitdel';
async function reseed({ bStatus = 'published', enabled = true, archived = false, entryArm = null } = {}) {
  await q(`DELETE FROM lb_split_views WHERE test_id = 'tst_del'`);
  await q(`DELETE FROM lb_split_arms WHERE test_id = 'tst_del'`);
  await q(`DELETE FROM lb_split_tests WHERE id = 'tst_del'`);
  await q(`DELETE FROM funnel_pages WHERE funnel_id = $1`, [FID]);
  await q(`INSERT INTO funnel_pages (id, funnel_id, slug, type, status) VALUES
    ('pg_a', $1, '/lp-a', 'lead', 'published'),
    ('pg_b', $1, '/lp-b', 'lead', $2)`, [FID, bStatus]);
  await q(`INSERT INTO lb_split_tests (id, funnel_id, name, scope, handle, enabled, archived)
           VALUES ('tst_del', $1, 'del test', 'page', 'lp1', $2, $3)`, [FID, enabled, archived]);
  await q(`INSERT INTO lb_split_arms (id, test_id, arm_key, weight, page_id, is_control, is_entry) VALUES
    ('arm_a', 'tst_del', 'a', 1, 'pg_a', TRUE,  $1),
    ('arm_b', 'tst_del', 'b', 1, 'pg_b', FALSE, $2)`,
  [entryArm === 'a', entryArm === 'b']);
}

// ── T0: the flag is flipped in this same change set ─────────────────────────
check('T0 SPLIT_DELIVERY_WIRED is true', SPLIT_DELIVERY_WIRED === true);

// ── T1: sticky — one visitor always gets the same page ──────────────────────
{
  await reseed();
  const first = await resolvePageSplit({ funnelId: FID, relPath: '/lp1', visitorId: 'v_sticky' }, { query: q });
  check('T1 handle resolves to an arm page', !!first && ['pg_a', 'pg_b'].includes(first.page.id), JSON.stringify(first?.page?.id));
  let stable = true;
  for (let i = 0; i < 10; i++) {
    const r = await resolvePageSplit({ funnelId: FID, relPath: '/lp1', visitorId: 'v_sticky' }, { query: q });
    if (!r || r.page.id !== first.page.id) { stable = false; break; }
  }
  check('T1 same visitor → same page ×10', stable);
}

// ── T2: distribution — many visitors land on BOTH arms, roughly evenly ──────
{
  await reseed();
  const counts = { pg_a: 0, pg_b: 0 };
  for (let i = 0; i < 200; i++) {
    const r = await resolvePageSplit({ funnelId: FID, relPath: '/lp1', visitorId: `v_dist_${i}` }, { query: q });
    if (r) counts[r.page.id] = (counts[r.page.id] || 0) + 1;
  }
  check('T2 both arms served', counts.pg_a > 0 && counts.pg_b > 0, JSON.stringify(counts));
  const ratio = counts.pg_a / 200;
  check('T2 ~50/50 at n=200 (35–65% tolerance)', ratio > 0.35 && ratio < 0.65, JSON.stringify(counts));
}

// ── T3: dark arm — unpublished page is re-picked, traffic never 404s ────────
{
  await reseed({ bStatus: 'draft' });
  let allA = true;
  for (let i = 0; i < 60; i++) {
    const r = await resolvePageSplit({ funnelId: FID, relPath: '/lp1', visitorId: `v_dark_${i}` }, { query: q });
    if (!r || r.page.id !== 'pg_a') { allA = false; break; }
  }
  check('T3 dark arm b → every visitor re-picked to live arm a', allA);
}

// ── T4: no visitor id → the ENTRY arm, deterministically ────────────────────
{
  await reseed({ entryArm: 'b' });
  const r = await resolvePageSplit({ funnelId: FID, relPath: '/lp1', visitorId: '' }, { query: q });
  check('T4 id-less visitor gets the entry arm', r?.arm?.arm_key === 'b', JSON.stringify(r?.arm));
  await reseed(); // no entry flag → control (a)
  const r2 = await resolvePageSplit({ funnelId: FID, relPath: '/lp1', visitorId: '' }, { query: q });
  check('T4 no entry flag → control arm', r2?.arm?.arm_key === 'a', JSON.stringify(r2?.arm));
}

// ── T5: paused keeps the route (entry serve); only ARCHIVE releases it ──────
{
  await reseed({ enabled: false });
  const rp = await resolvePageSplit({ funnelId: FID, relPath: '/lp1', visitorId: 'v_x' }, { query: q });
  check('T5 paused test still serves (entry/control, paused flag)', rp !== null && rp.paused === true && rp.arm.arm_key === 'a', JSON.stringify(rp?.arm));
  await reseed({ archived: true });
  check('T5 archived test → null (route released)', (await resolvePageSplit({ funnelId: FID, relPath: '/lp1', visitorId: 'v_x' }, { query: q })) === null);
}

// ── T6: path discipline ─────────────────────────────────────────────────────
{
  await reseed();
  check('T6 wrong handle → null', (await resolvePageSplit({ funnelId: FID, relPath: '/nope', visitorId: 'v_x' }, { query: q })) === null);
  check('T6 nested path → null', (await resolvePageSplit({ funnelId: FID, relPath: '/lp1/deep', visitorId: 'v_x' }, { query: q })) === null);
  check('T6 root → null (home pin wins)', (await resolvePageSplit({ funnelId: FID, relPath: '/', visitorId: 'v_x' }, { query: q })) === null);
  check('T6 case-insensitive handle', (await resolvePageSplit({ funnelId: FID, relPath: '/LP1', visitorId: 'v_x' }, { query: q })) !== null);
}

// ── T7: recordView idempotency + visitors in readResults ────────────────────
{
  await reseed();
  const a = await recordView({ testId: 'tst_del', armKey: 'a', visitorId: 'v_view1' }, { query: q });
  const b = await recordView({ testId: 'tst_del', armKey: 'a', visitorId: 'v_view1' }, { query: q });
  const c = await recordView({ testId: 'tst_del', armKey: 'b', visitorId: 'v_view2' }, { query: q });
  check('T7 first view recorded, repeat duplicate', a === 'recorded' && b === 'duplicate' && c === 'recorded', JSON.stringify({ a, b, c }));
  const res = await readResults({ testId: 'tst_del' }, { query: q });
  const armA = res.arms.find((x) => x.arm_key === 'a');
  const armB = res.arms.find((x) => x.arm_key === 'b');
  check('T7 readResults reports visitors per arm', armA?.visitors === 1 && armB?.visitors === 1, JSON.stringify({ a: armA?.visitors, b: armB?.visitors }));
  check('T7 totals include visitors', res.totals.visitors === 2, JSON.stringify(res.totals));
  check('T7 refused on empty args', (await recordView({ testId: '', armKey: 'a', visitorId: 'v' }, { query: q })) === 'refused');
}

// ── T8: offer-scope override — the arm's offer replaces the shown one ───────
{
  const { _splitInternals } = await import('../../src/routes/checkoutPublic.js');
  await q(`DELETE FROM lb_split_arms WHERE test_id = 'tst_off'`);
  await q(`DELETE FROM lb_split_tests WHERE id = 'tst_off'`);
  await q(`DELETE FROM co_upsells WHERE id IN ('up_x', 'up_y', 'up_dis', 'up_other')`);
  await q(`INSERT INTO co_upsells (id, funnel_id, variant_id, price, title, enabled) VALUES
    ('up_x', $1, '111', 19.00, 'Offer X', TRUE),
    ('up_y', $1, '222', 29.00, 'Offer Y', TRUE),
    ('up_dis', $1, '333', 39.00, 'Disabled', FALSE)`, [FID]);
  await q(`INSERT INTO lb_split_tests (id, funnel_id, name, scope, target_offer_id, enabled) VALUES ('tst_off', $1, 'offer test', 'offer', 'up_x', TRUE)`, [FID]);
  await q(`INSERT INTO lb_split_arms (id, test_id, arm_key, weight, offer_id, is_control) VALUES
    ('armo_x', 'tst_off', 'a', 1, 'up_x', TRUE),
    ('armo_y', 'tst_off', 'b', 1, 'up_y', FALSE)`);
  // NOTE: _splitInternals uses the app's pgQuery (same DATABASE_URL) — works
  // because this harness DB is the app DB for this process.
  const seen = new Set();
  for (let i = 0; i < 100; i++) {
    const o = await _splitInternals.resolveOfferArmOverride({ funnelId: FID, visitorId: `v_off_${i}`, shownOfferId: 'up_x' });
    if (o) seen.add(o.id);
  }
  check('T8 both arm offers get shown across visitors', seen.has('up_x') && seen.has('up_y'), JSON.stringify([...seen]));
  const o1 = await _splitInternals.resolveOfferArmOverride({ funnelId: FID, visitorId: 'v_off_sticky', shownOfferId: 'up_x' });
  const o2 = await _splitInternals.resolveOfferArmOverride({ funnelId: FID, visitorId: 'v_off_sticky', shownOfferId: 'up_x' });
  check('T8 override is sticky per visitor', o1 && o2 && o1.id === o2.id, JSON.stringify({ o1: o1?.id, o2: o2?.id }));
  check('T8 no visitor id → null (default offer stands)', (await _splitInternals.resolveOfferArmOverride({ funnelId: FID, visitorId: '', shownOfferId: 'up_x' })) === null);
  // SCOPE GUARD (review finding 4): an offer OUTSIDE the test — a second
  // upsell, a downsell — must never be hijacked by the override.
  await q(`DELETE FROM co_upsells WHERE id = 'up_other'`);
  await q(`INSERT INTO co_upsells (id, funnel_id, variant_id, price, title, enabled) VALUES ('up_other', $1, '444', 59.00, 'Other step', TRUE)`, [FID]);
  check('T8 out-of-scope offer NOT hijacked', (await _splitInternals.resolveOfferArmOverride({ funnelId: FID, visitorId: 'v_off_sticky', shownOfferId: 'up_other' })) === null);
  // First in-scope override stamped the offer test's delivery epoch.
  const [eo] = await q(`SELECT delivery_epoch_at FROM lb_split_tests WHERE id = 'tst_off'`);
  check('T8 offer epoch stamped on first override', eo.delivery_epoch_at !== null);
  // Arm pointing at a DISABLED offer must not be swapped in.
  await q(`UPDATE lb_split_arms SET offer_id = 'up_dis' WHERE id = 'armo_y'`);
  let disabledServed = false;
  for (let i = 0; i < 60; i++) {
    const o = await _splitInternals.resolveOfferArmOverride({ funnelId: FID, visitorId: `v_off2_${i}`, shownOfferId: 'up_x' });
    if (o && o.id === 'up_dis') { disabledServed = true; break; }
  }
  check('T8 disabled arm offer never shown', !disabledServed);
  // DISPLAYABILITY GUARD: an arm offer with no price and no variant is
  // undisplayable — the default must stand rather than 422 the page.
  await q(`UPDATE co_upsells SET price = NULL, variant_id = '' WHERE id = 'up_y'`);
  await q(`UPDATE lb_split_arms SET offer_id = 'up_y' WHERE id = 'armo_y'`);
  let undisplayableServed = false;
  for (let i = 0; i < 60; i++) {
    const o = await _splitInternals.resolveOfferArmOverride({ funnelId: FID, visitorId: `v_off3_${i}`, shownOfferId: 'up_x' });
    if (o && o.id === 'up_y') { undisplayableServed = true; break; }
  }
  check('T8 undisplayable arm offer never swapped in', !undisplayableServed);
}

// ── T9: fail-open — a broken DB yields null, never a throw ──────────────────
{
  const boom = async () => { throw new Error('db down'); };
  const r = await resolvePageSplit({ funnelId: FID, relPath: '/lp1', visitorId: 'v_x' }, { query: boom });
  check('T9 resolvePageSplit fail-open null on DB error', r === null);
  const v = await recordView({ testId: 'tst_del', armKey: 'a', visitorId: 'v_boom' }, { query: boom });
  check('T9 recordView fail-open failed on DB error', v === 'failed');
}

// ── T10: pure pickArm sanity retained (weights respected at the picker) ─────
{
  const arms = [
    { arm_key: 'a', weight: 3, is_control: true },
    { arm_key: 'b', weight: 1 },
  ];
  let aCount = 0;
  for (let i = 0; i < 400; i++) if (pickArm(`v${i}`, 't', arms).arm_key === 'a') aCount++;
  const frac = aCount / 400;
  check('T10 3:1 weights ≈ 75% (65–85% tolerance)', frac > 0.65 && frac < 0.85, String(frac));
}

// ── T11 (review): first delivered view stamps the DELIVERY EPOCH once ──────
{
  await reseed();
  const [before] = await q(`SELECT delivery_epoch_at FROM lb_split_tests WHERE id = 'tst_del'`);
  await recordView({ testId: 'tst_del', armKey: 'a', visitorId: 'v_epoch1' }, { query: q });
  const [after1] = await q(`SELECT delivery_epoch_at FROM lb_split_tests WHERE id = 'tst_del'`);
  await new Promise((r) => setTimeout(r, 20));
  await recordView({ testId: 'tst_del', armKey: 'b', visitorId: 'v_epoch2' }, { query: q });
  const [after2] = await q(`SELECT delivery_epoch_at FROM lb_split_tests WHERE id = 'tst_del'`);
  check('T11 epoch NULL before first view', before.delivery_epoch_at === null);
  check('T11 epoch stamped by first view', after1.delivery_epoch_at !== null);
  check('T11 epoch never re-stamped', String(after1.delivery_epoch_at) === String(after2.delivery_epoch_at));
}

// ── T12 (review): a PAUSED test keeps its route — entry arm, unbranched ─────
{
  await reseed({ enabled: false, entryArm: 'b' });
  const results = new Set();
  for (let i = 0; i < 20; i++) {
    const r = await resolvePageSplit({ funnelId: FID, relPath: '/lp1', visitorId: `v_pause_${i}` }, { query: q });
    if (r) { results.add(r.arm.arm_key); if (!r.paused) results.add('NOT_PAUSED'); }
    else results.add('NULL');
  }
  check('T12 paused test serves ONLY the entry arm, flagged paused', results.size === 1 && results.has('b'), [...results].join(','));
}

// ── T13 (review): a null page_id arm is re-picked, not a bail ───────────────
{
  await reseed();
  await q(`UPDATE lb_split_arms SET page_id = NULL WHERE id = 'arm_b'`);
  let allA = true;
  for (let i = 0; i < 40; i++) {
    const r = await resolvePageSplit({ funnelId: FID, relPath: '/lp1', visitorId: `v_null_${i}` }, { query: q });
    if (!r || r.page.id !== 'pg_a') { allA = false; break; }
  }
  check('T13 null page_id arm → re-picked to the live arm', allA);
}
// cleanup
await q(`DELETE FROM lb_split_views WHERE test_id = 'tst_del'`);
await q(`DELETE FROM lb_split_arms WHERE test_id IN ('tst_del', 'tst_off')`);
await q(`DELETE FROM lb_split_tests WHERE id IN ('tst_del', 'tst_off')`);
await q(`DELETE FROM funnel_pages WHERE funnel_id = $1`, [FID]);
await q(`DELETE FROM co_upsells WHERE id IN ('up_x', 'up_y', 'up_dis', 'up_other')`);
await sql.end();
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
