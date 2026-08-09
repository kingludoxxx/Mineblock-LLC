// DELIVERY-PATCH verification — drives the REAL deliverToPixel /
// resolveEndpoint / fireUpsellPurchaseConversion against embedded PG plus a
// local mock relay (TRACKING_RELAY_OVERRIDE_URL), like the money-path
// harnesses.
//
// Proves by execution: the duplicate branch now LOGS status='deduped';
// the Meta endpoint defaults to v23.0 with a per-pixel graph_version
// override (bad values fall back); a 'gcm1:'-encrypted capi_token decrypts
// on send (Bearer header + body access_token carry the PLAINTEXT, the
// ciphertext never leaves) while legacy plaintext rows pass through; a
// corrupt ciphertext fails RETRYABLE (queued, healable) without throwing;
// the upsell Purchase mints a distinct deterministic event_id and the claim
// dedupes a double-fire; and the consent-gated runtime emits a valid fbq
// base loader only for native/hybrid meta pixels.
//
// Run:  node server/tests/tracking/delivery-patches.mjs
process.env.DATABASE_URL = 'postgres://puure@127.0.0.1:5433/puure_shoporder';
process.env.NODE_ENV = 'development';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me';
delete process.env.TRACKING_RELAY_OVERRIDE_URL; // endpoint tests need the real builder

import http from 'http';

const NM = '/Users/ludo/Mineblock-LLC/node_modules';
const postgres = (await import(`${NM}/postgres/src/index.js`)).default;
const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });

const { deliverToPixel, resolveEndpoint, graphVersion } = await import('../../src/services/trackingDelivery.js');
const { encryptSecret } = await import('../../src/services/gatewayConfigs.js');
const { fireUpsellPurchaseConversion, firePurchaseConversion } = await import('../../src/services/trackingService.js');
const { ensureTrackingTables } = await import('../../src/services/trackingSchema.js');
const { ensureCheckoutTables } = await import('../../src/services/checkoutSchema.js');
const { trackingHeadScript } = await import('../../src/services/trackingRuntime.js');
await ensureTrackingTables();
await ensureCheckoutTables();

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}  ${extra}`); } };

const RUN = Date.now().toString(36);
const FID = 'fnl_trkdel';
const IDK = ['em', 'fbp'];
const UD = { em: 'hash_em', fbp: 'fb.1.1.abc' };

// mock relay — records every request; response controllable per-call
const captured = [];
let nextStatus = 200;
const relay = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => { b += d; });
  req.on('end', () => {
    captured.push({ url: req.url, auth: req.headers.authorization || '', body: b });
    const status = nextStatus; nextStatus = 200;
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(status === 200 ? { events_received: 1 } : { error: { message: 'boom' } }));
  });
});
await new Promise((r) => relay.listen(0, '127.0.0.1', r));
const RELAY = `http://127.0.0.1:${relay.address().port}/events`;

// clean slate
await sql`DELETE FROM lb_tracking_events WHERE funnel_id IN (${FID}, 'fnl_updel')`;
await sql`DELETE FROM lb_tracking_sent WHERE pixel_id LIKE 'PXDEL%'`;
await sql`DELETE FROM lb_postback_queue WHERE funnel_id IN (${FID}, 'fnl_updel')`;
await sql`DELETE FROM lb_postback_breakers WHERE funnel_id IN (${FID}, 'fnl_updel')`;
await sql`DELETE FROM lb_pixels WHERE funnel_id = 'fnl_updel'`;
await sql`DELETE FROM co_sessions WHERE id LIKE 'sess_updel%'`;

// ── T1: graph version — default, override, bad-value fallback ───────────────
{
  check('T1 graphVersion default v23.0', graphVersion({}) === 'v23.0', graphVersion({}));
  check('T1 graphVersion override honored', graphVersion({ graph_version: 'v19.0' }) === 'v19.0');
  check('T1 graphVersion bad value falls back', graphVersion({ graph_version: 'v19.0-bad' }) === 'v23.0');
  const url = resolveEndpoint({ kind: 'meta_pixel', pixel_id: '555', config: { capi_token: 'x' } });
  check('T1 built URL carries v23.0 default', url === 'https://graph.facebook.com/v23.0/555/events', url);
  const url2 = resolveEndpoint({ kind: 'meta_pixel', pixel_id: '555', config: { capi_token: 'x', graph_version: 'v19.0' } });
  check('T1 built URL carries per-pixel override', url2 === 'https://graph.facebook.com/v19.0/555/events', url2);
  const url3 = resolveEndpoint({ kind: 'meta_pixel', pixel_id: '555', config: {} });
  check('T1 no token still → not_configured (empty url)', url3 === '', url3);
}

// everything below goes through the mock relay
process.env.TRACKING_RELAY_OVERRIDE_URL = RELAY;

const mkPixel = (id, cfg) => ({ id: `pxrow_${id}_${RUN}`, funnel_id: FID, kind: 'meta_pixel', pixel_id: `PXDEL_${id}`, mode: 's2s', config: cfg });
const deliver = (pixel, eventId) => deliverToPixel({
  funnelId: FID, pixel, eventName: 'Purchase', eventId,
  userData: UD, idk: IDK, customData: { value: 10, currency: 'USD' }, source: 'webhook',
});

// ── T2: gcm1-encrypted token decrypts on send ───────────────────────────────
{
  const cipher = encryptSecret('SECRET_PLAIN_TOK');
  const px = mkPixel('enc', { capi_token: cipher, test_event_code: 'TE1' });
  const r = await deliver(px, `ev_enc_${RUN}`);
  const c = captured.pop();
  check('T2 encrypted-token delivery sent', r === 'sent', r);
  check('T2 Bearer header carries PLAINTEXT', c?.auth === 'Bearer SECRET_PLAIN_TOK', c?.auth);
  const body = JSON.parse(c.body);
  check('T2 body access_token is plaintext', body.access_token === 'SECRET_PLAIN_TOK');
  check('T2 ciphertext never leaves the server', !c.body.includes('gcm1:') && !c.auth.includes('gcm1:'));
  check('T2 test_event_code rides the payload', body.test_event_code === 'TE1', c.body.slice(0, 200));
}

// ── T3: legacy plaintext token passes through unchanged ─────────────────────
{
  const px = mkPixel('plain', { capi_token: 'LEGACY_TOK' });
  const r = await deliver(px, `ev_plain_${RUN}`);
  const c = captured.pop();
  check('T3 legacy plaintext still sends', r === 'sent', r);
  check('T3 Bearer carries the legacy token as-is', c?.auth === 'Bearer LEGACY_TOK', c?.auth);
}

// ── T4: duplicate branch now LOGS status=deduped ────────────────────────────
{
  const px = mkPixel('dup', { capi_token: 'LEGACY_TOK' });
  const eid = `ev_dup_${RUN}`;
  const r1 = await deliver(px, eid);
  const r2 = await deliver(px, eid);
  check('T4 first send sent, second duplicate', r1 === 'sent' && r2 === 'duplicate', JSON.stringify({ r1, r2 }));
  const rows = await sql`SELECT status FROM lb_tracking_events WHERE funnel_id = ${FID} AND event_id = ${eid} ORDER BY id`;
  const statuses = rows.map((x) => x.status);
  check('T4 ledger holds sent + deduped', statuses.length === 2 && statuses[0] === 'sent' && statuses[1] === 'deduped', JSON.stringify(statuses));
  const claims = await sql`SELECT COUNT(*)::int AS n FROM lb_tracking_sent WHERE event_id = ${eid}`;
  check('T4 exactly one claim row', claims[0].n === 1, String(claims[0].n));
}

// ── T5: corrupt ciphertext — retryable, never a throw, never logs the token ─
{
  captured.length = 0; // T4's first (successful) send legitimately hit the wire
  const px = mkPixel('bad', { capi_token: 'gcm1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
  const r = await deliver(px, `ev_bad_${RUN}`);
  check('T5 decrypt failure → queued (retryable, healable)', String(r).startsWith('queued:token_decrypt_failed'), r);
  const [qrow] = await sql`SELECT last_error FROM lb_postback_queue WHERE funnel_id = ${FID} AND pixel_row_id = ${px.id}`;
  check('T5 queue row parked with the classified error', qrow?.last_error === 'token_decrypt_failed', qrow?.last_error);
  check('T5 nothing hit the wire for it', !captured.length, JSON.stringify(captured));
}

// ── T6: relay 5xx with encrypted token still queues (no regression) ─────────
{
  nextStatus = 500;
  const px = mkPixel('e500', { capi_token: encryptSecret('SECRET_PLAIN_TOK') });
  const r = await deliver(px, `ev_500_${RUN}`);
  captured.pop();
  check('T6 http 500 → queued', String(r).startsWith('queued:http_500'), r);
}

// ── T7: upsell Purchase — deterministic id, claim idempotency, gating ───────
{
  const SID = `sess_updel_${RUN}`;
  await sql`INSERT INTO co_sessions (id, funnel_id, status, total, currency, customer, tracking_net, click_vault)
            VALUES (${SID}, 'fnl_updel', 'paid', 100, 'USD',
                    ${sql.json({ email: 'buyer@x.test', first_name: 'B' })},
                    ${sql.json({ fbp: 'fb.1.1.zz', url: 'https://f.example/checkout' })},
                    ${sql.json({ fbclid: 'CLK123' })})`;
  await sql`INSERT INTO lb_pixels (id, funnel_id, kind, pixel_id, mode, enabled, config)
            VALUES (${`pxup_${RUN}`}, 'fnl_updel', 'meta_pixel', ${`PXDEL_UP_${RUN}`}, 's2s', TRUE, ${sql.json({ capi_token: encryptSecret('SECRET_PLAIN_TOK') })})`;

  const r1 = await fireUpsellPurchaseConversion(SID, 'upc_1', 49.5);
  check('T7 upsell fired with deterministic id', r1.ok === true && r1.event_id === `pur_${SID}_u_upc_1` && r1.results?.[0]?.result === 'sent', JSON.stringify(r1));
  const c = captured.pop();
  const sent = JSON.parse(c.body).data[0];
  check('T7 payload: event_id + upsell value + order_id suffix',
    sent.event_id === `pur_${SID}_u_upc_1` && sent.custom_data.value === 49.5 && sent.custom_data.order_id === `${SID}_u_upc_1`, JSON.stringify(sent.custom_data));

  const r2 = await fireUpsellPurchaseConversion(SID, 'upc_1', 49.5); // double-fire
  check('T7 double-fire dedupes via the claim', r2.ok === true && r2.results?.[0]?.result === 'duplicate', JSON.stringify(r2));
  const claims = await sql`SELECT COUNT(*)::int AS n FROM lb_tracking_sent WHERE event_id = ${`pur_${SID}_u_upc_1`}`;
  check('T7 exactly one claim for the upsell id', claims[0].n === 1, String(claims[0].n));

  const r3 = await fireUpsellPurchaseConversion(SID, 'upc_2', 19.0); // second charge = second conversion
  check('T7 a DIFFERENT charge row mints a new id and sends', r3.ok === true && r3.event_id === `pur_${SID}_u_upc_2` && r3.results?.[0]?.result === 'sent', JSON.stringify(r3));
  captured.pop();

  const rMain = await firePurchaseConversion(SID);
  check('T7 main Purchase id stays distinct and un-suppressed', rMain.ok === true && rMain.event_id === `pur_${SID}` && rMain.results?.[0]?.result === 'sent', JSON.stringify(rMain));
  captured.pop();

  // gating edge cases — must refuse cleanly, never throw
  await sql`UPDATE co_sessions SET status = 'processing' WHERE id = ${SID}`;
  const g1 = await fireUpsellPurchaseConversion(SID, 'upc_3', 10);
  check('T7 not-paid session refused', g1.ok === false && String(g1.reason).startsWith('not_paid'), JSON.stringify(g1));
  await sql`UPDATE co_sessions SET status = 'paid' WHERE id = ${SID}`;
  const g2 = await fireUpsellPurchaseConversion('sess_missing_x', 'upc_1', 10);
  check('T7 missing session refused', g2.ok === false && g2.reason === 'session_not_found', JSON.stringify(g2));
  const g3 = await fireUpsellPurchaseConversion(SID, '', 10);
  check('T7 missing charge row refused', g3.ok === false && g3.reason === 'no_charge_row', JSON.stringify(g3));
  const g4 = await fireUpsellPurchaseConversion(SID, 'upc_4', 'NaN-ish');
  check('T7 non-finite value refused', g4.ok === false && g4.reason === 'bad_value', JSON.stringify(g4));
}

// ── T8: runtime fbq base loader — emitted, valid JS, house rules kept ───────
{
  process.env.TRACKING_ENABLED = '1';
  const frag = trackingHeadScript({ funnel_id: FID, page_id: 'pg1' });
  const inner = frag.replace(/^<script>/, '').replace(/<\/script>$/, '');
  check('T8 loader present with fbevents.js src', inner.includes('loadFbq') && inner.includes('https://connect.facebook.net/en_US/fbevents.js'));
  check('T8 native|hybrid mode gate present', inner.includes("px.mode==='native'||px.mode==='hybrid'"));
  check('T8 loader only reachable via consent-gated pipeline', inner.indexOf('function runPipeline') !== -1 && inner.includes('firePixels(vid,url)'));
  let parses = true;
  try { new Function(inner); } catch (e) { parses = false; console.log('   parse error:', e.message); }
  check('T8 emitted script is valid JS (template-literal safe)', parses);
  // the ADDED segment obeys the house rule: no backtick, no ${, no backslash
  const seg = inner.slice(inner.indexOf('function loadFbq'), inner.indexOf('function deny'));
  check('T8 added segment: no backticks / ${ / backslashes', seg.length > 0 && !seg.includes('`') && !seg.includes('${') && !seg.includes('\\'), seg.slice(0, 80));
}

// cleanup
await sql`DELETE FROM lb_tracking_events WHERE funnel_id IN (${FID}, 'fnl_updel')`;
await sql`DELETE FROM lb_tracking_sent WHERE pixel_id LIKE 'PXDEL%'`;
await sql`DELETE FROM lb_postback_queue WHERE funnel_id IN (${FID}, 'fnl_updel')`;
await sql`DELETE FROM lb_postback_breakers WHERE funnel_id IN (${FID}, 'fnl_updel')`;
await sql`DELETE FROM lb_pixels WHERE funnel_id = 'fnl_updel'`;
await sql`DELETE FROM co_sessions WHERE id LIKE 'sess_updel%'`;
await sql.end();
relay.close();
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
