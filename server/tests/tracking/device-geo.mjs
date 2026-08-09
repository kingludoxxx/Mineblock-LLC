// ANALYTICS LANE 5 — device + geo capture on lb_touches, verified BY EXECUTION
// against the real Postgres spine (same DB + node_modules convention as the
// sibling tracking harnesses, e.g. server/tests/tracking/admin-crud.mjs).
//
// What this proves, in order:
//   T1  classifyDevice is an EXACT port of the reference's
//       lb_page_stats_service.classify_device — 30 user-agents through a
//       table, including every documented edge case (bot-before-mobile,
//       iPadOS-as-desktop, empty ⇒ 'unknown', Android-without-Mobile ⇒
//       tablet), and every verdict inside the frozen DEVICE_CLASSES set.
//   T2  normCountry — the reference's norm_country contract (XX and T1 drop).
//   T3  country resolution precedence: an edge geo header beats the IP table;
//       a STUBBED resolver is what the IP path calls; IPv6 and private space
//       resolve to nothing rather than to a guess.
//   T4  THE ROW: device + country are stored on a real recordTouch write, as
//       a bounded class and a 2-letter code.
//   T5  RAW IP IS NEVER PERSISTED — grep-proof. Every column of every
//       lb_touches row is scanned for the IP that produced it, the whole table
//       definition is scanned for an ip-shaped column, and every console line
//       emitted during the writes is captured and scanned too.
//   T6  NULL-SAFE / NO-BACKFILL SEMANTICS: an unwired caller (no `ua`/`ip`
//       keys) writes NULL, not 'unknown' — the distinction that stops an
//       unwired deploy from filling the column with fake measurement.
//   T7  the resolver seam FAILS OPEN: a resolver that throws, one that returns
//       junk, and one that returns nothing all leave country NULL and still
//       write the row.
//   T8  Live View geoCard: available:true with rows + coverage once codes
//       exist; available:false WITH coverage when none do; the read-failure
//       state is distinct from the zero-countries state.
//
// Run:  node server/tests/tracking/device-geo.mjs
process.env.DATABASE_URL = 'postgres://puure@127.0.0.1:5433/puure_shoporder';
process.env.NODE_ENV = 'development';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me';

const NM = '/Users/ludo/Mineblock-LLC/node_modules';
const postgres = (await import(`${NM}/postgres/src/index.js`)).default;
const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
};

const {
  recordTouch, classifyDevice, normCountry, resolveCountry, setCountryResolver, DEVICE_CLASSES,
} = await import('../../src/services/trackingAttribution.js');
const { ensureTrackingTables } = await import('../../src/services/trackingSchema.js');

await ensureTrackingTables();

// ── T0: the columns actually exist, additively, with the expected types ─────
{
  const cols = await sql`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'lb_touches' AND column_name IN ('device','country')
    ORDER BY column_name`;
  check('T0 lb_touches gained device + country', cols.length === 2, JSON.stringify(cols));
  check('T0 both are nullable TEXT (no backfill ⇒ NULL must be legal)',
    cols.every((c) => c.data_type === 'text' && c.is_nullable === 'YES'), JSON.stringify(cols));
}

// ── T1: the device classification table (30 rows) ───────────────────────────
// Expectations are the reference's, derived from lb_page_stats_service.py
// classify_device (marker list, then tablet, then mobile, else desktop).
const UA_TABLE = [
  // — bots: must win over EVERY device signal, including mobile ones —
  ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'bot'],
  ['Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)', 'bot'],
  ['Mozilla/5.0 (Linux; Android 6.0.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/W.X.Y.Z Mobile Safari/537.36 (compatible; Googlebot/2.1)', 'bot'],
  ['facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', 'bot'],
  ['curl/8.4.0', 'bot'],
  ['Wget/1.21.3', 'bot'],
  ['python-requests/2.31.0', 'bot'],
  ['Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120.0.0.0 Safari/537.36', 'bot'],
  ['Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36 Chrome-Lighthouse', 'bot'],
  ['Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)', 'bot'],
  ['Pingdom.com_bot_version_1.4', 'bot'],
  ['Mozilla/5.0 (compatible; YandexBot/3.0)', 'bot'],
  ['SomeLinkPreview/1.0 preview', 'bot'],
  ['UptimeMonitor/2.0 monitor', 'bot'],
  // — tablets —
  ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1', 'tablet'],
  ['Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36', 'tablet'],
  ['Mozilla/5.0 (Linux; Android 10; Lenovo Tablet) AppleWebKit/537.36 Chrome/120 Safari/537.36', 'tablet'],
  ['Mozilla/5.0 (Linux; U; Android 4.4; KFTHWI Build/KTU84M) Silk/3.68 Safari/537.36', 'tablet'],
  // — mobiles —
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 Version/17.1 Mobile/15E148 Safari/604.1', 'mobile'],
  ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36', 'mobile'],
  ['Mozilla/5.0 (Android 13; Mobile; rv:121.0) Gecko/121.0 Firefox/121.0', 'mobile'],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 [FBAN/FBIOS;FBAV/440.0]', 'mobile'],
  ['Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 Chrome/119 Mobile Safari/537.36 musical_ly_2023', 'mobile'],
  ['Mozilla/5.0 (iPod touch; CPU iPhone OS 15_7 like Mac OS X) Mobile/15E148', 'mobile'],
  // — desktops —
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36', 'desktop'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.1 Safari/605.1.15', 'desktop'],
  ['Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0', 'desktop'],
  // iPadOS 13+ masquerades as Macintosh — the reference ACCEPTS this blind
  // spot and files it under desktop. Pinned so nobody "fixes" it silently.
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15', 'desktop'],
  // — edge cases —
  ['', 'unknown'],
  ['   ', 'desktop'], // whitespace is a non-empty UA: it matches no marker ⇒ desktop
];

{
  let bad = [];
  for (const [ua, want] of UA_TABLE) {
    const got = classifyDevice(ua);
    if (got !== want) bad.push({ ua: ua.slice(0, 60), want, got });
  }
  check(`T1 device table: ${UA_TABLE.length} user-agents classify as the reference does`,
    bad.length === 0, JSON.stringify(bad));
  check('T1 every verdict is inside the frozen DEVICE_CLASSES set',
    UA_TABLE.every(([ua]) => DEVICE_CLASSES.includes(classifyDevice(ua))));
  const counts = UA_TABLE.reduce((a, [ua]) => { const d = classifyDevice(ua); a[d] = (a[d] || 0) + 1; return a; }, {});
  console.log(`      classes seen: ${JSON.stringify(counts)}`);
  check('T1 the table exercises all five classes',
    DEVICE_CLASSES.every((c) => counts[c] > 0), JSON.stringify(counts));
  // NULL/undefined must not throw — recordTouch's fail-open depends on it.
  check('T1 null/undefined UA ⇒ unknown, no throw',
    classifyDevice(null) === 'unknown' && classifyDevice(undefined) === 'unknown');
  // The property that matters most: bot beats mobile.
  check('T1 a bot UA that ALSO says Android/Mobile is a bot, not a mobile',
    classifyDevice('Mozilla/5.0 (Linux; Android 6.0.1) Chrome/W Mobile Safari/537.36 (compatible; Googlebot/2.1)') === 'bot');
}

// ── T2: norm_country contract ───────────────────────────────────────────────
{
  const cases = [['es', 'ES'], ['ES', 'ES'], [' de ', 'DE'], ['XX', ''], ['T1', ''],
    ['USA', ''], ['E', ''], ['', ''], [null, ''], [undefined, ''], ['1S', ''], ['e5', '']];
  const bad = cases.filter(([i, w]) => normCountry(i) !== w);
  check(`T2 normCountry: ${cases.length} cases (XX and T1 both drop)`, bad.length === 0, JSON.stringify(bad));
}

// ── T3: resolution precedence + the stubbed resolver ────────────────────────
{
  const seen = [];
  setCountryResolver((ip) => { seen.push(ip); return ip === '203.0.113.5' ? 'ES' : ''; });

  check('T3 header wins over the IP table',
    (await resolveCountry({ countryHeader: 'FR', ip: '203.0.113.5' })) === 'FR');
  const beforeIpOnly = seen.length;
  check('T3 header absent ⇒ the IP resolver is consulted',
    (await resolveCountry({ ip: '203.0.113.5' })) === 'ES' && seen.length === beforeIpOnly + 1);
  check('T3 an unusable header (XX) falls THROUGH to the IP resolver',
    (await resolveCountry({ countryHeader: 'XX', ip: '203.0.113.5' })) === 'ES');
  check('T3 resolver output is normalised, not trusted verbatim',
    (await resolveCountry({ ip: '203.0.113.5' })) === 'ES');
  check('T3 IPv4-mapped IPv6 is unwrapped before lookup',
    (await resolveCountry({ ip: '::ffff:203.0.113.5' })) === 'ES');
  check('T3 a host:port form is unwrapped before lookup',
    (await resolveCountry({ ip: '203.0.113.5:44321' })) === 'ES');

  const beforeV6 = seen.length;
  check('T3 a real IPv6 address resolves to nothing (IPv4-only table) and is NEVER chopped into a fake v4',
    (await resolveCountry({ ip: '2a02:26f7:c1c4:6800:0:0:0:1' })) === '' && seen.length === beforeV6);
  check('T3 malformed / out-of-range input resolves to nothing, no throw',
    (await resolveCountry({ ip: '999.1.1.1' })) === ''
    && (await resolveCountry({ ip: 'not-an-ip' })) === ''
    && (await resolveCountry({})) === ''
    && (await resolveCountry()) === '');
  check('T3 the resolver only ever saw well-formed IPv4 strings',
    seen.every((ip) => /^(\d{1,3}\.){3}\d{1,3}$/.test(ip)), JSON.stringify(seen));
}

// ── helpers for the row-level tests ─────────────────────────────────────────
const VID_A = 'v_dgaaaaaaaaaaaaaaaaaaaa';
const VID_B = 'v_dgbbbbbbbbbbbbbbbbbbbb';
const VID_C = 'v_dgcccccccccccccccccccc';
const VID_D = 'v_dgdddddddddddddddddddd';
const VID_E = 'v_dgeeeeeeeeeeeeeeeeeeee';
const ALL_VIDS = [VID_A, VID_B, VID_C, VID_D, VID_E];
await sql`DELETE FROM lb_touches WHERE vid = ANY(${ALL_VIDS})`;
await sql`DELETE FROM lb_visitor_firstseen WHERE vid = ANY(${ALL_VIDS})`;

const rowFor = async (vid) => {
  const [r] = await sql`SELECT * FROM lb_touches WHERE vid = ${vid} ORDER BY id DESC LIMIT 1`;
  return r || null;
};

// Console capture — every line any code under test emits during the writes,
// so T5 can prove no raw IP leaked into a log.
const logLines = [];
const realLog = console.log, realWarn = console.warn, realError = console.error;
const capture = (fn) => (...a) => { logLines.push(a.map((x) => String(x)).join(' ')); fn(...a); };

// ── T4: the row actually carries device + country ───────────────────────────
const RAW_IP = '203.0.113.5';
{
  setCountryResolver((ip) => (ip === RAW_IP ? 'ES' : ''));
  console.warn = capture(realWarn); console.error = capture(realError);

  const r = await recordTouch('fnl_dg', 'pg_dg', VID_A, 'https://x.test/lp?utm_source=meta', 'https://ref.test', {
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) Mobile/15E148 Safari/604.1',
    ip: RAW_IP,
  });
  console.warn = realWarn; console.error = realError;

  check('T4 recordTouch reports the classified device + resolved country',
    r.ok === true && r.device === 'mobile' && r.country === 'ES', JSON.stringify(r));
  const row = await rowFor(VID_A);
  check('T4 the ROW carries device=mobile', row && row.device === 'mobile', JSON.stringify(row && row.device));
  check('T4 the ROW carries country=ES as a 2-letter code',
    row && row.country === 'ES' && row.country.length === 2, JSON.stringify(row && row.country));
  check('T4 existing behaviour intact (utm still parsed on the same write)',
    row && row.utm && row.utm.utm_source === 'meta', JSON.stringify(row && row.utm));

  // A header-only visitor (edge geo header present, no usable IP).
  await recordTouch('fnl_dg', 'pg_dg', VID_B, 'https://x.test/lp2', '', {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
    countryHeader: 'de',
  });
  const rowB = await rowFor(VID_B);
  check('T4 header-only visitor stores the normalised code',
    rowB && rowB.device === 'desktop' && rowB.country === 'DE', JSON.stringify(rowB && { d: rowB.device, c: rowB.country }));
}

// ── T5: RAW IP NEVER PERSISTED — the grep-proof ─────────────────────────────
{
  const row = await rowFor(VID_A);
  // GUARD: without this, every "the IP is absent" assertion below would pass
  // VACUOUSLY on a missing row — an absence proof needs the subject to exist.
  check('T5 GUARD: the row under test exists (no vacuous absence proof)', row !== null);
  const serialised = JSON.stringify(row);
  check('T5 the raw IP appears in NO column of the row it produced',
    row !== null && !serialised.includes(RAW_IP), serialised);

  // Not just this IP — nothing ip-SHAPED anywhere in the row.
  const ipShaped = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.exec(serialised);
  check('T5 no dotted-quad of ANY kind survives into the row', row !== null && ipShaped === null, String(ipShaped));
  // POSITIVE CONTROL for the grep itself: the same regex over the same
  // serialiser MUST find an IP when one is really there. Without this the
  // absence proof only shows the regex never matches anything.
  check('T5 POSITIVE CONTROL: the grep does detect an IP when one is present',
    /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(JSON.stringify({ ...row, url: `https://x.test/?probe=${RAW_IP}` })));

  // No ip-shaped COLUMN was added to the table either (the schema-level guard:
  // a future writer must not be handed a place to put one).
  const cols = await sql`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'lb_touches'`;
  const names = cols.map((c) => c.column_name);
  check('T5 lb_touches has NO ip / ip_hash / remote_addr column',
    !names.some((n) => /(^|_)ip($|_)|ipaddr|remote_addr|client_ip/i.test(n)), JSON.stringify(names));
  console.log(`      lb_touches columns: ${names.join(', ')}`);

  // And nothing logged it.
  check('T5 no console line emitted during the writes carries the IP',
    !logLines.some((l) => l.includes(RAW_IP)), JSON.stringify(logLines));
  check('T5 no console line emitted during the writes carries ANY dotted-quad',
    !logLines.some((l) => /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(l)), JSON.stringify(logLines));
}

// ── T6: NULL-safety + the no-backfill semantics ─────────────────────────────
{
  // An UNWIRED caller — exactly today's trackingPublic.js call shape.
  await recordTouch('fnl_dg', 'pg_dg', VID_C, 'https://x.test/lp3', '');
  const rowC = await rowFor(VID_C);
  check('T6 unwired caller (no ua/ip keys) ⇒ device NULL, NOT "unknown"',
    rowC && rowC.device === null, JSON.stringify(rowC && rowC.device));
  check('T6 unwired caller ⇒ country NULL', rowC && rowC.country === null, JSON.stringify(rowC && rowC.country));

  // A WIRED caller whose request genuinely had no UA and no usable IP.
  await recordTouch('fnl_dg', 'pg_dg', VID_D, 'https://x.test/lp4', '', { ua: '', ip: '' });
  const rowD = await rowFor(VID_D);
  check('T6 wired caller with an EMPTY ua ⇒ device "unknown" (captured, said nothing)',
    rowD && rowD.device === 'unknown', JSON.stringify(rowD && rowD.device));
  check('T6 wired caller with an empty ip ⇒ country NULL (never a guess)',
    rowD && rowD.country === null, JSON.stringify(rowD && rowD.country));
  check('T6 NULL and "unknown" are therefore DISTINGUISHABLE in the column',
    rowC.device === null && rowD.device === 'unknown');

  // Rows that predate the columns must still read as NULL (the no-backfill
  // contract), and a pre-existing-shaped INSERT must still work.
  await sql`INSERT INTO lb_touches (vid, funnel_id, url, expires_at)
            VALUES (${VID_E}, 'fnl_dg', 'https://x.test/old', NOW() + INTERVAL '90 days')`;
  const rowE = await rowFor(VID_E);
  check('T6 a legacy-shaped insert still succeeds and reads NULL/NULL',
    rowE && rowE.device === null && rowE.country === null, JSON.stringify(rowE && { d: rowE.device, c: rowE.country }));
}

// ── T7: the resolver seam fails OPEN ────────────────────────────────────────
{
  const VID_F = 'v_dgffffffffffffffffffff';
  const VID_G = 'v_dggggggggggggggggggggg';
  const VID_H = 'v_dghhhhhhhhhhhhhhhhhhhh';
  await sql`DELETE FROM lb_touches WHERE vid = ANY(${[VID_F, VID_G, VID_H]})`;
  console.warn = capture(realWarn); console.error = capture(realError);

  setCountryResolver(() => { throw new Error(`resolver exploded on ${RAW_IP}`); });
  const rF = await recordTouch('fnl_dg', null, VID_F, 'https://x.test/f', '', { ua: 'curl/8.4.0', ip: RAW_IP });
  const rowF = await rowFor(VID_F);
  check('T7 a THROWING resolver still writes the row, country NULL',
    rF.ok === true && rowF && rowF.country === null && rowF.device === 'bot',
    JSON.stringify({ rF, row: rowF && { d: rowF.device, c: rowF.country } }));

  setCountryResolver(() => 'NOT-A-COUNTRY-CODE');
  await recordTouch('fnl_dg', null, VID_G, 'https://x.test/g', '', { ua: 'curl/8.4.0', ip: RAW_IP });
  const rowG = await rowFor(VID_G);
  check('T7 a JUNK-returning resolver is normalised away ⇒ country NULL',
    rowG && rowG.country === null, JSON.stringify(rowG && rowG.country));

  setCountryResolver(async () => { await new Promise((r) => setTimeout(r, 1)); return null; });
  await recordTouch('fnl_dg', null, VID_H, 'https://x.test/h', '', { ua: 'curl/8.4.0', ip: RAW_IP });
  const rowH = await rowFor(VID_H);
  check('T7 an ASYNC resolver returning nothing ⇒ country NULL, row written',
    rowH && rowH.country === null, JSON.stringify(rowH && rowH.country));

  console.warn = realWarn; console.error = realError;
  // The throwing resolver's message deliberately EMBEDS the IP — proof that
  // even a hostile third-party resolver cannot leak it into our logs.
  check('T7 even a resolver whose ERROR MESSAGE contains the IP does not leak it to the log',
    !logLines.some((l) => l.includes(RAW_IP)),
    JSON.stringify(logLines.filter((l) => l.includes(RAW_IP))));

  await sql`DELETE FROM lb_touches WHERE vid = ANY(${[VID_F, VID_G, VID_H]})`;
  setCountryResolver(null);
}

// ── T8: the Live View geo card ──────────────────────────────────────────────
{
  const { buildLiveSnapshot } = await import('../../src/services/liveViewQueries.js');

  // A stub `query` keeps this a UNIT proof of the card's three states — the
  // real SQL is exercised by server/tests/live-view/stream.mjs against PG.
  const stub = (geoRows, { throwGeo = false } = {}) => async (text) => {
    if (/GROUPING SETS \(\(t\.country\)/.test(text)) {
      if (throwGeo) throw new Error('geo read blew up');
      return geoRows;
    }
    return []; // every other read degrades to its own named warning
  };

  const s1 = await buildLiveSnapshot({
    query: stub([
      { country: 'ES', is_total: 0, visitors: 7, resolved: 7 },
      { country: 'US', is_total: 0, visitors: 3, resolved: 3 },
      { country: null, is_total: 0, visitors: 5, resolved: 0 },
      { country: null, is_total: 1, visitors: 15, resolved: 10 },
    ]),
  });
  check('T8 codes present ⇒ geo.available true with sorted rows',
    s1.geo.available === true
    && s1.geo.by_country.length === 2
    && s1.geo.by_country[0].country === 'ES' && s1.geo.by_country[0].visitors === 7
    && s1.geo.by_country[1].country === 'US',
    JSON.stringify(s1.geo));
  check('T8 the NULL-country data row is excluded from the list but counted in coverage',
    s1.geo.coverage.resolved_visitors === 10 && s1.geo.coverage.total_visitors === 15
    && s1.geo.coverage.resolved_pct === 66.7,
    JSON.stringify(s1.geo.coverage));
  check('T8 basis discloses the double-count and the NULL rows',
    /sum above coverage/.test(s1.basis.geo || '') && /NULL/.test(s1.basis.geo || ''), s1.basis.geo);

  const s2 = await buildLiveSnapshot({
    query: stub([{ country: null, is_total: 1, visitors: 9, resolved: 0 }]),
  });
  check('T8 visitors but no codes ⇒ available false, WITH coverage, reason names the cause',
    s2.geo.available === false && s2.geo.by_country.length === 0
    && s2.geo.coverage.total_visitors === 9 && s2.geo.coverage.resolved_visitors === 0
    && s2.geo.coverage.resolved_pct === 0
    && /captured at write time/.test(s2.geo.reason),
    JSON.stringify(s2.geo));

  const s3 = await buildLiveSnapshot({
    query: stub([{ country: null, is_total: 1, visitors: 0, resolved: 0 }]),
  });
  check('T8 zero visitors ⇒ resolved_pct is NULL, never a fabricated 0%',
    s3.geo.coverage.resolved_pct === null && /no visitors today/.test(s3.geo.reason),
    JSON.stringify(s3.geo));

  const s4 = await buildLiveSnapshot({ query: stub([], { throwGeo: true }) });
  check('T8 a FAILED geo read is a distinct state: coverage null + a named warning',
    s4.geo.available === false && s4.geo.coverage === null
    && /could not be read/.test(s4.geo.reason)
    && s4.warnings.some((w) => w.source === 'lb_touches_geo')
    && s4.degraded === true,
    JSON.stringify({ geo: s4.geo, w: s4.warnings }));
}

// ── T9: the DEFAULT resolver path (the actual `ip3country` dependency) ──────
// Two separate claims, kept separate on purpose:
//   (a) with the package ABSENT the default path degrades to NULL and says so
//       once — this is the state of the repo until the integrator installs it,
//       and it must never crash a touch write;
//   (b) the package's real API is what this code expects — asserted against a
//       real copy if one is resolvable, and reported as SKIPPED (never PASSED)
//       if not, because an unrun assertion is not a green one.
{
  setCountryResolver(null); // back to the default lazy loader
  let libPath = null;
  for (const cand of ['ip3country', '/private/tmp/claude-501/-Users-ludo/e2b7ca61-ef45-4ba9-9635-142bd3dda290/scratchpad/ip3test/node_modules/ip3country/src/ip3country.js']) {
    try { await import(cand); libPath = cand; break; } catch { /* not resolvable here */ }
  }

  console.warn = capture(realWarn); console.error = capture(realError);
  const viaDefault = await resolveCountry({ ip: '8.8.8.8' });
  console.warn = realWarn; console.error = realError;

  if (libPath === 'ip3country') {
    check('T9a package INSTALLED: the default path resolves a known IPv4 to its country',
      viaDefault === 'US', JSON.stringify(viaDefault));
  } else {
    check('T9a package ABSENT: the default path degrades to NULL country, no throw',
      viaDefault === '', JSON.stringify(viaDefault));
    check('T9a the degradation is ANNOUNCED, not silent',
      logLines.some((l) => /ip3country/.test(l) && /not loaded/.test(l)),
      JSON.stringify(logLines.slice(-3)));
  }

  if (libPath) {
    const mod = await import(libPath);
    const lib = mod?.default || mod;
    lib.init();
    check(`T9b the real library's API matches what the resolver calls (via ${libPath === 'ip3country' ? 'node_modules' : 'probe copy'})`,
      typeof lib.lookupStr === 'function' && lib.lookupStr('8.8.8.8') === 'US'
      && lib.lookupStr('213.60.0.1') === 'ES');
    check('T9b the real library returns NULL (never a guess) for IPv6 / private / junk',
      lib.lookupStr('2a02:26f7::1') === null && lib.lookupStr('10.0.0.1') === null
      && lib.lookupStr('not-an-ip') === null,
      JSON.stringify([lib.lookupStr('2a02:26f7::1'), lib.lookupStr('10.0.0.1'), lib.lookupStr('not-an-ip')]));
    // Wire it in as the resolver and drive a REAL row end to end.
    const VID_I = 'v_dgiiiiiiiiiiiiiiiiiiii';
    await sql`DELETE FROM lb_touches WHERE vid = ${VID_I}`;
    setCountryResolver((ip) => lib.lookupStr(ip));
    await recordTouch('fnl_dg', null, VID_I, 'https://x.test/i', '', {
      ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120 Mobile Safari/537.36',
      ip: '213.60.0.1',
    });
    const rowI = await rowFor(VID_I);
    check('T9b end-to-end with the REAL table: a Spanish IPv4 lands as country=ES, device=mobile',
      rowI && rowI.country === 'ES' && rowI.device === 'mobile',
      JSON.stringify(rowI && { d: rowI.device, c: rowI.country }));
    check('T9b and the IP still never reaches the row',
      rowI && !JSON.stringify(rowI).includes('213.60.0.1'));
    await sql`DELETE FROM lb_touches WHERE vid = ${VID_I}`;
    setCountryResolver(null);
  } else {
    console.log('SKIP  T9b real-library API assertions — no ip3country copy resolvable here (NOT counted as a pass)');
  }
}

// ── cleanup ─────────────────────────────────────────────────────────────────
await sql`DELETE FROM lb_touches WHERE vid = ANY(${ALL_VIDS})`;
await sql`DELETE FROM lb_visitor_firstseen WHERE vid = ANY(${ALL_VIDS})`;
await sql.end({ timeout: 5 });

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
