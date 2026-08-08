// Verification harness for the split-testing subsystem. Runs the real service
// code against the embedded Postgres (127.0.0.1:5433, db puure_split) and
// asserts the five money-adjacent guarantees BY EXECUTION.
//
//   node scripts/verifySplitTesting.mjs
//
// Uses an INJECTED query fn (no app boot, no env dependency) — the services all
// accept { query } exactly so they can be exercised in isolation.
import postgres from 'postgres';
import { ensureSplitTables } from '../server/src/services/splitTestSchema.js';
import { pickArm, hashFraction, resolveArm } from '../server/src/services/splitResolver.js';
import { recordExposure, creditConversion, voidCredit, readResults, creditSessionConversions, voidSessionRefund, retrySplitPendingCredits } from '../server/src/services/splitCredits.js';

const DB = process.env.SPLIT_TEST_DB_URL || 'postgresql://puure@127.0.0.1:5433/puure_split';
const sql = postgres(DB, { max: 10, idle_timeout: 5 });
const query = (text, params = []) => sql.unsafe(text, params);
const deps = { query, sql };

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed += 1; console.log(`  PASS  ${msg}`); }
  else { failed += 1; console.log(`  FAIL  ${msg}`); }
}
const hr = (t) => console.log(`\n=== ${t} ===`);

async function main() {
  // Clean slate BEFORE the first ensure (the ensure memo caches success).
  await query(`DROP TABLE IF EXISTS lb_split_pending_credits CASCADE`);
  await query(`DROP TABLE IF EXISTS lb_split_credits CASCADE`);
  await query(`DROP TABLE IF EXISTS lb_split_arms CASCADE`);
  await query(`DROP TABLE IF EXISTS lb_split_tests CASCADE`);
  await ensureSplitTables(query);
  console.log('Tables created in', DB.replace(/\/\/.*@/, '//***@'));

  // ── 1. Sticky deterministic assignment + even distribution ───────────────
  hr('1. Sticky + deterministic + even distribution (N=1000)');
  const testId = 'lbsg_test1';
  const arms2 = [
    { arm_key: 'a', weight: 50, is_control: true, archived: false },
    { arm_key: 'b', weight: 50, is_control: false, archived: false },
  ];
  // Sticky: the same visitor id resolves to the SAME arm on every call.
  const vid = 'v_sticky_check';
  const first = pickArm(vid, testId, arms2).arm_key;
  let stable = true;
  for (let i = 0; i < 200; i += 1) if (pickArm(vid, testId, arms2).arm_key !== first) stable = false;
  assert(stable, `same visitor id → same arm across 200 calls (got '${first}')`);
  // Determinism is independent of arm array order.
  const shuffled = [arms2[1], arms2[0]];
  assert(pickArm(vid, testId, shuffled).arm_key === first, 'assignment independent of arm list order');
  // Seed includes test id: a visitor can land differently across tests.
  const other = pickArm(vid, 'lbsg_other', arms2).arm_key;
  assert(hashFraction(vid, testId) !== hashFraction(vid, 'lbsg_other'), 'hash seeded by BOTH visitor and test id');

  // Even distribution over 1000 distinct visitors (equal weights).
  const counts = { a: 0, b: 0 };
  for (let i = 0; i < 1000; i += 1) counts[pickArm(`v_${i}`, testId, arms2).arm_key] += 1;
  console.log(`  distribution 50/50: a=${counts.a} b=${counts.b}`);
  assert(counts.a >= 440 && counts.a <= 560, `equal weights → ~even split (a=${counts.a}/1000, tol 440-560)`);

  // Weighted 80/20 tracks the weights.
  const armsW = [
    { arm_key: 'a', weight: 80, is_control: true, archived: false },
    { arm_key: 'b', weight: 20, is_control: false, archived: false },
  ];
  const cw = { a: 0, b: 0 };
  for (let i = 0; i < 1000; i += 1) cw[pickArm(`v_${i}`, testId, armsW).arm_key] += 1;
  console.log(`  distribution 80/20: a=${cw.a} b=${cw.b}`);
  assert(cw.a >= 760 && cw.a <= 840, `weighted 80/20 → arm a ~800 (got ${cw.a})`);

  // ── seed a real test in the DB for the crediting proofs ──────────────────
  await query(`INSERT INTO lb_split_tests (id, name, scope, enabled) VALUES ($1,$2,'offer',TRUE)`, [testId, 'T1']);
  await query(`INSERT INTO lb_split_arms (id, test_id, arm_key, weight, is_control) VALUES ('lbsa_a',$1,'a',50,TRUE)`, [testId]);
  await query(`INSERT INTO lb_split_arms (id, test_id, arm_key, weight, is_control) VALUES ('lbsa_b',$1,'b',50,FALSE)`, [testId]);

  // ── 2. Crediting is exactly-once + charge-id keying ──────────────────────
  hr('2. Exactly-once crediting (idempotent + concurrent) + charge-id keying');
  const session = 'co_sess_1';
  // Denominator first: this buyer was shown arm 'a'.
  const exp = await recordExposure({ sessionId: session, testId, armKey: 'a', currency: 'USD' }, deps);
  assert(exp === 'recorded', `exposure recorded (${exp})`);
  const exp2 = await recordExposure({ sessionId: session, testId, armKey: 'a' }, deps);
  assert(exp2 === 'duplicate', `second exposure for same (session,group) is a no-op (${exp2})`);

  // Credit charge A twice sequentially → one row.
  const c1 = await creditConversion({ sessionId: session, testId, chargeId: 'chgA', value: 30 }, deps);
  const c1b = await creditConversion({ sessionId: session, testId, chargeId: 'chgA', value: 30 }, deps);
  assert(c1 === 'credited' && c1b === 'duplicate', `same (session,group,charge) twice → 1 credit (${c1}, ${c1b})`);

  // Credit charge A 8x CONCURRENTLY → exactly one 'credited'.
  const conc = await Promise.all(
    Array.from({ length: 8 }, () => creditConversion({ sessionId: session, testId, chargeId: 'chgConc', value: 12 }, deps))
  );
  const nCredited = conc.filter((r) => r === 'credited').length;
  const nDup = conc.filter((r) => r === 'duplicate').length;
  console.log(`  concurrent results: ${JSON.stringify(conc)}`);
  assert(nCredited === 1 && nDup === 7, `8 concurrent credits of one leg → exactly 1 credited, 7 duplicate`);
  const [{ n: concRows }] = await query(
    `SELECT COUNT(*)::int AS n FROM lb_split_credits WHERE kind='credit' AND session_id=$1 AND charge_id='chgConc'`, [session]
  );
  assert(concRows === 1, `exactly ONE credit row exists for the concurrently-credited leg (rows=${concRows})`);

  // Different charges on the SAME session → DISTINCT rows (charge-id keying).
  // This is the session-only-key regression guard: a session-keyed ledger would
  // drop chgB (only the first leg would survive).
  const c2 = await creditConversion({ sessionId: session, testId, chargeId: 'chgB', value: 120 }, deps);
  assert(c2 === 'credited', `a DIFFERENT charge on the same session credits its own row (${c2})`);
  const [{ n: legRows }] = await query(
    `SELECT COUNT(*)::int AS n FROM lb_split_credits WHERE kind='credit' AND session_id=$1`, [session]
  );
  assert(legRows === 3, `same session, 3 distinct charges (chgA/chgConc/chgB) → 3 credit rows (got ${legRows})`);

  // No denominator ⇒ no credit (never above 100% take rate).
  const noExp = await creditConversion({ sessionId: 'co_no_exposure', testId, chargeId: 'x', value: 99 }, deps);
  assert(noExp === 'no_exposure', `credit with no exposure row is refused (${noExp})`);

  // ── 3. Refund nets in the ledger (append void, original intact) ───────────
  hr('3. Refund nets against the credit (append negative, original untouched)');
  const before = await query(
    `SELECT value FROM lb_split_credits WHERE kind='credit' AND session_id=$1 AND charge_id='chgB'`, [session]
  );
  const refund = await voidCredit({ sessionId: session, testId, chargeId: 'chgB', amount: 40, refundKey: 'rf1' }, deps);
  assert(refund === 'netted', `partial refund netted (${refund})`);
  const after = await query(
    `SELECT value FROM lb_split_credits WHERE kind='credit' AND session_id=$1 AND charge_id='chgB'`, [session]
  );
  assert(Number(before[0].value) === Number(after[0].value) && Number(after[0].value) === 120,
    `original credit row UNCHANGED after refund (still ${after[0].value})`);
  const voidRow = await query(
    `SELECT value FROM lb_split_credits WHERE kind='void' AND session_id=$1 AND charge_id='chgB'`, [session]
  );
  assert(voidRow.length === 1 && Number(voidRow[0].value) === -40, `a single NEGATIVE void row (-40) was appended`);

  // Idempotent refund: same refundKey again → no second void.
  const refDup = await voidCredit({ sessionId: session, testId, chargeId: 'chgB', amount: 40, refundKey: 'rf1' }, deps);
  assert(refDup === 'duplicate', `same refund event (refundKey) is idempotent (${refDup})`);

  // Cap: a further refund can never exceed the leg's remaining value.
  const refOver = await voidCredit({ sessionId: session, testId, chargeId: 'chgB', amount: 1000, refundKey: 'rf2' }, deps);
  const [{ total: totalVoided }] = await query(
    `SELECT COALESCE(-SUM(value),0)::numeric AS total FROM lb_split_credits WHERE kind='void' AND session_id=$1 AND charge_id='chgB'`, [session]
  );
  assert(refOver === 'netted' && Number(totalVoided) === 120,
    `over-refund is capped at leg value (total voided = ${totalVoided}, never > 120)`);
  const refNothing = await voidCredit({ sessionId: session, testId, chargeId: 'chgB', amount: 5, refundKey: 'rf3' }, deps);
  assert(refNothing === 'nothing_to_net', `a fully-refunded leg nets nothing more (${refNothing})`);

  // Structural money guards (CHECK constraints) — a denominator can never carry
  // money, a credit can never be negative, a void can never be positive.
  let expoMoneyRejected = false;
  try {
    await query(`INSERT INTO lb_split_credits (entry_id,kind,session_id,group_id,arm_key,charge_id,value,credited)
                 VALUES ('bad_exp','exposure','s','g','a','__exposure__',5,TRUE)`);
  } catch { expoMoneyRejected = true; }
  assert(expoMoneyRejected, 'DB CHECK rejects an exposure row carrying money (default-off enforced structurally)');

  // ── 4. Resolver failure → default/control arm, no throw (fail-open) ───────
  hr('4. Fail-open serving (resolver failure → control arm, never throws)');
  // pickArm with hostile arms (getter throws) must not raise.
  let threw = false;
  let armOnError = null;
  try {
    const hostile = [
      { arm_key: 'a', is_control: true, archived: false, get weight() { throw new Error('boom'); } },
      { arm_key: 'b', is_control: false, archived: false, weight: 1 },
    ];
    armOnError = pickArm('v_x', testId, hostile);
  } catch { threw = true; }
  assert(!threw && armOnError && armOnError.arm_key === 'a', `pickArm swallows a thrown error and returns control arm 'a'`);

  // resolveArm with a query fn that throws → failedOpen, no throw.
  const badQuery = () => { throw new Error('db exploded'); };
  let resolveThrew = false;
  let r;
  try { r = await resolveArm({ visitorId: 'v_x', testId }, { query: badQuery }); }
  catch { resolveThrew = true; }
  assert(!resolveThrew && r.failedOpen === true && r.armKey === null,
    `resolveArm on DB failure returns {failedOpen:true, armKey:null} without throwing`);

  // A paused test resolves outside the splitter (no error, not fail-open).
  await query(`UPDATE lb_split_tests SET enabled=FALSE WHERE id=$1`, [testId]);
  const paused = await resolveArm({ visitorId: 'v_x', testId }, deps);
  assert(paused.armKey === null && paused.failedOpen === false, 'a disabled test resolves to no arm (serve default), not an error');
  await query(`UPDATE lb_split_tests SET enabled=TRUE WHERE id=$1`, [testId]);

  // ── 5. Results read = exposures vs netted credited conversions per arm ────
  hr('5. Results read (exposures vs netted credited conversions per arm)');
  // Add a second buyer on arm 'b' with an exposure and one credit, to show both arms.
  await recordExposure({ sessionId: 'co_sess_2', testId, armKey: 'b' }, deps);
  await creditConversion({ sessionId: 'co_sess_2', testId, chargeId: 'chgC', value: 50 }, deps);
  const results = await readResults({ testId }, deps);
  console.log('  ' + JSON.stringify(results, null, 2).replace(/\n/g, '\n  '));
  const armA = results.arms.find((a) => a.arm_key === 'a');
  const armB = results.arms.find((a) => a.arm_key === 'b');
  // Arm A: session co_sess_1 exposed once; 3 credited legs (chgA 30, chgConc 12,
  // chgB 120) → gross 162, refunded 120 (chgB fully) → net 42; conversions =
  // 1 DISTINCT session (not 3 legs).
  assert(armA.exposures === 1, `arm a exposures = 1 (got ${armA.exposures})`);
  assert(armA.conversions === 1, `arm a conversions = 1 DISTINCT session, not 3 legs (got ${armA.conversions})`);
  assert(armA.credited_legs === 3, `arm a credited_legs = 3 (got ${armA.credited_legs})`);
  assert(armA.gross_revenue === 162 && armA.refunded === 120 && armA.net_revenue === 42,
    `arm a gross=162 refunded=120 net=42 (got ${armA.gross_revenue}/${armA.refunded}/${armA.net_revenue})`);
  assert(armB.exposures === 1 && armB.conversions === 1 && armB.net_revenue === 50,
    `arm b exposures=1 conversions=1 net=50 (got ${armB.exposures}/${armB.conversions}/${armB.net_revenue})`);
  assert(armA.take_rate === 1 && armB.take_rate === 1, `take rate derived per arm (a=${armA.take_rate}, b=${armB.take_rate})`);

  // ── 6. Scope-aware settle-hook wrappers ──────────────────────────────────
  hr('6. creditSessionConversions / voidSessionRefund (scope-aware settle hooks)');
  await query(`INSERT INTO lb_split_tests (id, name, scope, enabled) VALUES ('lbsg_page','P','page',TRUE)`);
  await query(`INSERT INTO lb_split_arms (id,test_id,arm_key,weight,is_control) VALUES ('lbsa_pa','lbsg_page','a',1,TRUE)`);
  await query(`INSERT INTO lb_split_tests (id, name, scope, enabled) VALUES ('lbsg_offer','O','offer',TRUE)`);
  await query(`INSERT INTO lb_split_arms (id,test_id,arm_key,weight,is_control) VALUES ('lbsa_oa','lbsg_offer','a',1,TRUE)`);
  const ms = 'co_multi';
  await recordExposure({ sessionId: ms, testId: 'lbsg_page', armKey: 'a' }, deps);
  await recordExposure({ sessionId: ms, testId: 'lbsg_offer', armKey: 'a' }, deps);
  // Base order settle → only the PAGE test gets credited.
  const baseCredit = await creditSessionConversions({ sessionId: ms, chargeId: `base:${ms}`, value: 49, scope: 'page' }, deps);
  console.log('  base settle credited:', JSON.stringify(baseCredit));
  assert(baseCredit.length === 1 && baseCredit[0].testId === 'lbsg_page' && baseCredit[0].status === 'credited',
    'base-order settle credits ONLY the page-scope test');
  // Upsell leg settle → only the OFFER test gets credited.
  const upCredit = await creditSessionConversions({ sessionId: ms, chargeId: 'ux_1', value: 29, scope: 'offer' }, deps);
  console.log('  upsell settle credited:', JSON.stringify(upCredit));
  assert(upCredit.length === 1 && upCredit[0].testId === 'lbsg_offer' && upCredit[0].status === 'credited',
    'upsell-leg settle credits ONLY the offer-scope test');
  // Refund of the upsell leg nets across the tests that credited it.
  const rf = await voidSessionRefund({ sessionId: ms, chargeId: 'ux_1', amount: 29, refundKey: 'g_ref_1' }, deps);
  assert(rf.length === 1 && rf[0].status === 'netted', 'voidSessionRefund nets the leg across its crediting test(s)');
  const pageRes = await readResults({ testId: 'lbsg_page' }, deps);
  const offerRes = await readResults({ testId: 'lbsg_offer' }, deps);
  assert(pageRes.totals.net_revenue === 49, `page test net = 49 (got ${pageRes.totals.net_revenue})`);
  assert(offerRes.totals.net_revenue === 0 && offerRes.totals.refunded === 29,
    `offer test net = 0 after full refund (refunded=${offerRes.totals.refunded})`);

  // ── 7. HIGH fix: refund-cap TOCTOU under concurrency (loop x20) ──────────
  hr('7. Concurrent distinct-key refunds are capped at the leg value (20 iterations)');
  let toctouOk = true;
  let worstVoided = 0;
  for (let iter = 0; iter < 20; iter += 1) {
    const s7 = `co_toctou_${iter}`;
    await recordExposure({ sessionId: s7, testId, armKey: 'a' }, deps);
    await creditConversion({ sessionId: s7, testId, chargeId: 'leg100', value: 100 }, deps);
    // Six CONCURRENT partial refunds of 40, each with a DISTINCT refundKey —
    // the exact probe from the review (unfixed: up to 240 voided).
    await Promise.all(
      Array.from({ length: 6 }, (_, k) =>
        voidCredit({ sessionId: s7, testId, chargeId: 'leg100', amount: 40, refundKey: `rk_${k}` }, deps)
      )
    );
    const [{ total }] = await query(
      `SELECT COALESCE(-SUM(value),0)::numeric AS total FROM lb_split_credits
       WHERE kind='void' AND session_id=$1 AND charge_id='leg100'`, [s7]
    );
    const voidedTotal = Number(total);
    worstVoided = Math.max(worstVoided, voidedTotal);
    if (voidedTotal !== 100) { toctouOk = false; console.log(`  iter ${iter}: voided ${voidedTotal} (EXPECTED 100)`); }
  }
  assert(toctouOk, `6 concurrent distinct-key 40s on a 100 leg → total voided EXACTLY 100, 20/20 iterations (worst=${worstVoided})`);
  const [{ neg }] = await query(
    `SELECT COUNT(*)::int AS neg FROM (
       SELECT session_id, charge_id, SUM(value) AS net FROM lb_split_credits
       WHERE kind IN ('credit','void') AND session_id LIKE 'co_toctou_%'
       GROUP BY session_id, charge_id) t WHERE net < 0`
  );
  assert(neg === 0, `no leg's net is negative after the concurrent refund storm (negative legs=${neg})`);

  // ── 8. MEDIUM fix: settle-races-exposure parks + retries to ONE credit ───
  hr('8. Pending credits: settle racing exposure is parked, retried, credited exactly once');
  await query(`INSERT INTO lb_split_tests (id, name, scope, enabled) VALUES ('lbsg_race','R','offer',TRUE)`);
  await query(`INSERT INTO lb_split_arms (id,test_id,arm_key,weight,is_control) VALUES ('lbsa_ra','lbsg_race','a',1,TRUE)`);
  // Deterministic worst case: the settle lands FIRST (no exposure at all yet).
  const rs = 'co_race_1';
  const parked = await creditSessionConversions({ sessionId: rs, chargeId: 'ux_race', value: 33, scope: 'offer' }, deps);
  assert(parked.length === 1 && parked[0].status === 'pending', `settle before exposure parks the leg (${JSON.stringify(parked)})`);
  const [{ n: pend1 }] = await query(
    `SELECT COUNT(*)::int AS n FROM lb_split_pending_credits WHERE session_id=$1 AND resolved_at IS NULL`, [rs]
  );
  assert(pend1 === 1, `one pending row exists (${pend1})`);
  // Retry BEFORE the exposure exists → nothing credits, row stays pending.
  const r0 = await retrySplitPendingCredits({}, deps);
  const [{ n: credAfter0 }] = await query(
    `SELECT COUNT(*)::int AS n FROM lb_split_credits WHERE kind='credit' AND session_id=$1`, [rs]
  );
  assert(credAfter0 === 0, `retry with no exposure yet credits nothing (scanned=${r0.scanned})`);
  // The exposure lands; the retry pass now credits EXACTLY once.
  await recordExposure({ sessionId: rs, testId: 'lbsg_race', armKey: 'a' }, deps);
  const r1 = await retrySplitPendingCredits({}, deps);
  const r2 = await retrySplitPendingCredits({}, deps); // second pass must not double-credit
  const [{ n: credAfter }] = await query(
    `SELECT COUNT(*)::int AS n FROM lb_split_credits WHERE kind='credit' AND session_id=$1`, [rs]
  );
  assert(credAfter === 1 && r1.resolved === 1, `after retry: exactly ONE credit, pending resolved (credits=${credAfter}, resolved=${r1.resolved}, second pass scanned=${r2.scanned})`);
  // Truly CONCURRENT exposure + settle, then retry → still exactly one credit.
  const rs2 = 'co_race_2';
  await Promise.all([
    recordExposure({ sessionId: rs2, testId: 'lbsg_race', armKey: 'a' }, deps),
    creditSessionConversions({ sessionId: rs2, chargeId: 'ux_race2', value: 21, scope: 'offer' }, deps),
  ]);
  await retrySplitPendingCredits({}, deps);
  await retrySplitPendingCredits({}, deps);
  const [{ n: credRace }] = await query(
    `SELECT COUNT(*)::int AS n FROM lb_split_credits WHERE kind='credit' AND session_id=$1`, [rs2]
  );
  assert(credRace === 1, `concurrent exposure+settle → eventually exactly ONE credit, never two (got ${credRace})`);
  // A session with NO live test of scope does not park (table stays bounded).
  const noPark = await creditSessionConversions({ sessionId: 'co_nopark', chargeId: 'x', value: 5, scope: 'page' }, deps);
  const pageLive = await query(`SELECT 1 FROM lb_split_tests WHERE enabled AND NOT archived AND scope='page' LIMIT 1`);
  if (!pageLive.length) {
    assert(noPark.length === 0, 'no live test of that scope → no parking');
  } else {
    // page-scope test exists from section 6 — parking is the correct behavior.
    assert(noPark.length === 1 && noPark[0].status === 'pending', 'live page test exists → parked (bounded by live-test gate)');
  }

  // ── 9. LOW fix: whitespace-only ids are refused ──────────────────────────
  hr('9. Whitespace-only identifiers are refused');
  assert(await creditConversion({ sessionId: '  ', testId, chargeId: 'c', value: 1 }, deps) === 'refused', "sessionId '  ' → refused");
  assert(await creditConversion({ sessionId: 's', testId, chargeId: '  ', value: 1 }, deps) === 'refused', "chargeId '  ' → refused");
  assert(await voidCredit({ sessionId: 's', testId: '  ', chargeId: 'c', amount: 1 }, deps) === 'refused', "voidCredit testId '  ' → refused");
  assert(await recordExposure({ sessionId: 's', testId, armKey: ' ' }, deps) === 'refused', "armKey ' ' → refused");

  // ── 10. LOW fix: archived arms' ledger rows stay in results + totals ─────
  hr('10. Archiving an arm never drops its historical revenue from results');
  const beforeArchive = await readResults({ testId }, deps);
  await query(`UPDATE lb_split_arms SET archived = TRUE WHERE test_id = $1 AND arm_key = 'b'`, [testId]);
  const afterArchive = await readResults({ testId }, deps);
  const archB = afterArchive.arms.find((a) => a.arm_key === 'b');
  assert(archB && archB.archived === true && archB.net_revenue === 50,
    `archived arm b still listed (flagged) with its net 50 (got ${archB && archB.net_revenue})`);
  assert(afterArchive.totals.net_revenue === beforeArchive.totals.net_revenue,
    `totals unchanged by archiving (before=${beforeArchive.totals.net_revenue}, after=${afterArchive.totals.net_revenue})`);
  await query(`UPDATE lb_split_arms SET archived = FALSE WHERE test_id = $1 AND arm_key = 'b'`, [testId]);

  hr(`RESULT: ${passed} passed, ${failed} failed`);
  await sql.end();
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error('HARNESS ERROR:', e);
  try { await sql.end(); } catch { /* noop */ }
  process.exit(2);
});
