// PURE verification for the outbound postback TEMPLATE ENGINE and its two
// SSRF gates. No Postgres, no network except the one DNS lookup endpointAllowed
// performs — so every refusal rule here is provable in isolation.
//
// What this harness is for: the macro renderer is the one place operator text
// and attacker-controlled values meet in a string that becomes a URL. Every
// case below is a way that string could be turned into something other than
// what the operator wrote.
//
// Run:  node server/tests/tracking/postback-template.mjs
process.env.NODE_ENV = 'development';

const {
  renderPostback, postbackContext, validateTemplateShape, MACRO_NAMES,
} = await import('../../src/services/trackingPostbackTemplate.js');
const { slugOf, validateNetworkBody, readEventNames, parseJsonColumn } =
  await import('../../src/services/trackingCustomNetworks.js');
const { presetBodyFor, NETWORK_DIRECTORY, adUrlFor } =
  await import('../../src/services/trackingNetworkDirectory.js');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
};

// ── T1. plain macro expansion ───────────────────────────────────────────────
{
  const ctx = postbackContext({
    eventName: 'Purchase', eventId: 'pur_co_1', clickId: 'CLICK123',
    value: 49.5, currency: 'usd', orderId: 'co_1', vid: 'v_abc',
    funnelId: 'f_1', pageUrl: 'https://shop.example/thanks',
    subs: { sub1: 'ad_9', sub3: 'placement_x' }, nowMs: 1_700_000_000_000,
  });
  const url = renderPostback(
    'https://t.example.com/pb?cid={click_id}&amt={payout}&cur={currency}&e={event}&o={order_id}&s1={sub1}&s3={sub3}&ts={timestamp}',
    ctx
  );
  ok('T1 macros expand', url ===
    'https://t.example.com/pb?cid=CLICK123&amt=49.50&cur=USD&e=purchase&o=co_1&s1=ad_9&s3=placement_x&ts=1700000000', url);
  ok('T1 value and payout are the same 2dp number', ctx.value === '49.50' && ctx.payout === '49.50', JSON.stringify(ctx.value));
  ok('T1 event is lower-cased', ctx.event === 'purchase', ctx.event);
  ok('T1 currency is upper-cased', ctx.currency === 'USD', ctx.currency);
  ok('T1 status defaults to approved', ctx.status === 'approved', ctx.status);
  ok('T1 unset subs render EMPTY, not undefined', ctx.sub7 === '', JSON.stringify(ctx.sub7));
}

// ── T2. HOSTILE MACRO VALUES ────────────────────────────────────────────────
// Every value below is attacker-reachable: a click id is whatever the ad
// network put in the URL, an order id can come from an inbound postback.
{
  const tmpl = 'https://t.example.com/pb?cid={click_id}&amt={payout}';

  // 2a. A click id that tries to ADD a parameter.
  const inject = renderPostback(tmpl, postbackContext({ clickId: 'x&amt=99999&admin=1', value: 1 }));
  ok('T2a `&` in a macro value cannot add a query parameter',
    inject === 'https://t.example.com/pb?cid=x%26amt%3D99999%26admin%3D1&amt=1.00', inject);

  // 2b. A click id that tries to END the query and start a path/fragment.
  const frag = renderPostback(tmpl, postbackContext({ clickId: '#/../../etc/passwd?x=1', value: 1 }));
  ok('T2b `#`, `?` and `/` in a macro value are percent-encoded',
    !frag.includes('#') && !frag.slice('https://t.example.com/pb?'.length).includes('?') && frag.includes('%23'), frag);

  // 2c. A macro value CONTAINING A MACRO must not be re-expanded. This is the
  // template-injection primitive: replace() with a callback never rescans.
  const nested = renderPostback(tmpl, postbackContext({ clickId: '{payout}{currency}', value: 7 }));
  ok('T2c a macro value containing {payout} is NOT re-expanded',
    nested === 'https://t.example.com/pb?cid=%7Bpayout%7D%7Bcurrency%7D&amt=7.00', nested);

  // 2d. CRLF in a value cannot split the request line.
  const crlf = renderPostback(tmpl, postbackContext({ clickId: 'a\r\nHost: evil.com', value: 1 }));
  ok('T2d CRLF in a macro value is percent-encoded',
    !/[\r\n]/.test(crlf) && crlf.includes('%0D%0A'), JSON.stringify(crlf));

  // 2e. PROTOTYPE MACROS. `{constructor}` / `{tostring}` would resolve through
  // the prototype chain on a plain object literal and String() a function onto
  // the wire. The context is null-prototype AND the renderer uses hasOwnProperty.
  const proto = renderPostback(
    'https://t.example.com/pb?a={constructor}&b={tostring}&c={valueof}&d={__proto__}',
    postbackContext({ clickId: 'x' })
  );
  ok('T2e prototype-chain names render EMPTY',
    proto === 'https://t.example.com/pb?a=&b=&c=&d=', proto);

  // 2f. An unknown macro renders empty (tracker convention) rather than
  // leaving the literal `{whatever}` on the wire.
  const unknown = renderPostback('https://t.example.com/pb?z={not_a_macro}', postbackContext({}));
  ok('T2f unknown macro renders empty', unknown === 'https://t.example.com/pb?z=', unknown);

  // 2g. A raw object/array supplied as a sub must never become '[object Object]'.
  const objSub = renderPostback('https://t.example.com/pb?s={sub1}',
    postbackContext({ subs: { sub1: { evil: 1 } } }));
  ok('T2g an object-valued sub renders empty', objSub === 'https://t.example.com/pb?s=', objSub);

  // 2h. NaN / Infinity payout must NOT render 'NaN' — an empty param is right.
  const nan = renderPostback('https://t.example.com/pb?v={payout}', postbackContext({ value: 'not-a-number' }));
  const inf = renderPostback('https://t.example.com/pb?v={payout}', postbackContext({ value: Infinity }));
  ok('T2h NaN payout renders empty', nan === 'https://t.example.com/pb?v=', nan);
  ok('T2h Infinity payout renders empty', inf === 'https://t.example.com/pb?v=', inf);
  // …but an explicit 0 is a legitimate value and must SURVIVE.
  const zero = renderPostback('https://t.example.com/pb?v={payout}', postbackContext({ value: 0 }));
  ok('T2h an explicit 0 payout survives as 0.00', zero === 'https://t.example.com/pb?v=0.00', zero);

  // 2i. A macro in the PATH is legitimate and still encoded.
  const path = renderPostback('https://t.example.com/pb/{order_id}/done', postbackContext({ orderId: 'a/b' }));
  ok('T2i a macro in the path is encoded (no extra segment)',
    path === 'https://t.example.com/pb/a%2Fb/done', path);
}

// ── T3. TEMPLATE SHAPE — the save-time refusals ─────────────────────────────
{
  const REFUSE = [
    ['', 'template_required', 'empty'],
    ['   ', 'template_required', 'whitespace only'],
    ['not a url', 'template_not_a_url', 'garbage'],
    ['ftp://example.com/x', 'template_bad_scheme', 'non-http scheme'],
    ['javascript:alert(1)', 'template_bad_scheme', 'javascript: scheme'],
    ['file:///etc/passwd', 'template_bad_scheme', 'file: scheme'],
    ['https://user:pw@example.com/x', 'template_userinfo', 'userinfo credentials'],
    // THE ONE THIS RULE EXISTS FOR: a macro in the authority means the host
    // validated at save time is not the host contacted at fire time.
    ['https://{click_id}.evil.example/x', 'template_macro_in_host', 'macro in host'],
    // A macro in the PORT is caught one gate earlier than the macro-in-host
    // rule: WHATWG URL refuses a non-numeric port outright, so `new URL()`
    // throws and the verdict is template_not_a_url. Refused either way — this
    // case is pinned so a future parser change that starts ACCEPTING it is
    // caught by the macro_in_host rule rather than silently allowed.
    ['https://a.example:{sub1}/x', 'template_not_a_url', 'macro in port'],
    ['https://{sub1}/x', 'template_macro_in_host', 'whole host is a macro'],
  ];
  for (const [tmpl, code, label] of REFUSE) {
    const r = validateTemplateShape(tmpl);
    ok(`T3 REFUSED (${code}): ${label}`, r.ok === false && r.code === code, JSON.stringify(r));
  }
  // A control character (request-splitting shape) is refused.
  const ctl = validateTemplateShape(`https://a.example/x?y=${String.fromCharCode(13)}${String.fromCharCode(10)}z`);
  ok('T3 REFUSED (template_control_chars): CRLF in the template',
    ctl.ok === false && ctl.code === 'template_control_chars', JSON.stringify(ctl));

  const ACCEPT = [
    'https://trc.taboola.com/actions-handler/log/3/s2s-action?click-id={click_id}&name={event}',
    'https://a.example.com/pb/{order_id}?v={payout}#{event_id}',
    'http://127.0.0.1:8099/pb?cid={click_id}',
  ];
  for (const tmpl of ACCEPT) {
    const r = validateTemplateShape(tmpl);
    ok(`T3 ACCEPTED: ${tmpl.slice(0, 52)}…`, r.ok === true, JSON.stringify(r));
  }
  const long = validateTemplateShape(`https://a.example/x?q=${'a'.repeat(2100)}`);
  ok('T3 REFUSED (template_too_long): >2048 chars', long.ok === false && long.code === 'template_too_long', JSON.stringify(long));
}

// ── T4. the FIRE-TIME SSRF gate, on RENDERED urls ───────────────────────────
// The shape check cannot see a host that merely RESOLVES somewhere private.
// endpointAllowed is the existing guard (server/tests/money-path/ssrf-guard.mjs
// covers it for CAPI endpoints); these cases prove it is applied to the
// template path too — including through a rendered macro.
{
  process.env.NODE_ENV = 'production'; // http + loopback must be refused here
  const { endpointAllowed } = await import('../../src/services/trackingDelivery.js');
  const BLOCK = [
    ['https://169.254.169.254/pb?cid=x', 'cloud metadata'],
    ['https://metadata.google.internal/pb', 'GCP metadata hostname'],
    ['https://127.0.0.1/pb', 'loopback v4'],
    ['https://[::1]/pb', 'loopback v6'],
    ['https://10.0.0.5/pb', 'private 10/8'],
    ['https://192.168.1.9/pb', 'private 192.168/16'],
    ['https://100.64.1.1/pb', 'CGNAT'],
    ['https://[::ffff:169.254.169.254]/pb', 'IPv4-mapped metadata'],
    ['http://example.com/pb', 'plaintext http in production'],
  ];
  for (const [url, label] of BLOCK) {
    const verdict = await endpointAllowed(url);
    ok(`T4 fire-time BLOCKED: ${label}`, verdict !== true, `got ${JSON.stringify(verdict)}`);
  }
  // A rendered template whose macro tried to reach metadata still cannot: the
  // macro is in the PATH, so the host stays the operator's.
  const rendered = renderPostback('https://example.com/pb?next={click_id}',
    postbackContext({ clickId: 'http://169.254.169.254/latest/' }));
  ok('T4 a metadata URL inside a macro stays in the query, host unchanged',
    new URL(rendered).hostname === 'example.com', rendered);
  process.env.NODE_ENV = 'development';
}

// ── T5. custom-network body validation ──────────────────────────────────────
{
  ok('T5 slugOf normalises a label', slugOf('  My Weird  Network!! ') === 'my-weird-network', slugOf('  My Weird  Network!! '));
  ok('T5 slugOf never returns empty', slugOf('!!!') === 'custom', slugOf('!!!'));

  const good = validateNetworkBody({
    label: 'Partner X', url_template: 'https://p.example/pb?c={click_id}',
    click_id_param: 'pxclid', method: 'post', event_names: ['Purchase', 'Purchase', 'Lead'],
  }, { isCreate: true });
  ok('T5 a good create body validates', good.ok === true, JSON.stringify(good));
  ok('T5 method is upper-cased', good.ok && good.fields.method === 'POST', JSON.stringify(good.fields));
  ok('T5 event_names de-dupe', good.ok && good.fields.event_names.join() === 'Purchase,Lead', JSON.stringify(good.fields.event_names));
  ok('T5 key is derived from the label', good.ok && good.fields.key === 'partner-x', JSON.stringify(good.fields.key));

  const REFUSE_BODY = [
    [{}, 'label_required', 'create with no label'],
    [{ label: 'a'.repeat(61), url_template: 'https://a.example/' }, 'label_too_long', 'over-long label'],
    [{ label: 'X' }, 'template_required', 'create with no template'],
    [{ label: 'X', url_template: 'https://a.example/', method: 'DELETE' }, 'invalid_method', 'unsupported method'],
    [{ label: 'X', url_template: 'https://a.example/', event_names: 'Purchase' }, 'invalid_event_names', 'event_names not an array'],
    [{ label: 'X', url_template: 'https://a.example/', event_names: ['Nope'] }, 'unknown_event_name', 'unknown event name'],
    [{ label: 'X', url_template: 'https://a.example/', click_id_param: 'has space' }, 'invalid_click_id_param', 'bad click-id param'],
    [{ label: 'X', url_template: 'https://a.example/', enabled: 'false' }, 'invalid_enabled', 'string "false" for enabled'],
    [null, 'invalid_body', 'null body'],
    [['a'], 'invalid_body', 'array body'],
  ];
  for (const [body, code, label] of REFUSE_BODY) {
    const r = validateNetworkBody(body, { isCreate: true });
    ok(`T5 REFUSED (${code}): ${label}`, r.ok === false && r.code === code, JSON.stringify(r));
  }
  // A PARTIAL update carries only what was sent — it can never blank a field
  // it never showed.
  const partial = validateNetworkBody({ enabled: false }, { isCreate: false });
  ok('T5 a partial update carries ONLY the sent key',
    partial.ok && Object.keys(partial.fields).join() === 'enabled', JSON.stringify(partial.fields));
  const empty = validateNetworkBody({}, { isCreate: false });
  ok('T5 an empty update is refused', empty.ok === false && empty.code === 'nothing_to_update', JSON.stringify(empty));
}

// ── T6. jsonb BOTH-SHAPE reads ──────────────────────────────────────────────
// A column can hold an object OR a double-encoded JSON string (a legacy
// writer, a hand-insert). Both must read; anything else degrades, never throws.
{
  ok('T6 array column reads', readEventNames(['Purchase', 'Lead']).join() === 'Purchase,Lead');
  ok('T6 DOUBLE-ENCODED string column reads', readEventNames('["Purchase","Lead"]').join() === 'Purchase,Lead');
  ok('T6 unknown names are dropped, not thrown on', readEventNames(['Purchase', 'Bogus']).join() === 'Purchase');
  ok('T6 null degrades to []', readEventNames(null).length === 0);
  ok('T6 malformed json degrades to []', readEventNames('{not json').length === 0);
  ok('T6 an object where an array belongs degrades to []', readEventNames({ a: 1 }).length === 0);
  ok('T6 parseJsonColumn object shape', parseJsonColumn({ a: 1 }, {}).a === 1);
  ok('T6 parseJsonColumn double-encoded object', parseJsonColumn('{"a":2}', {}).a === 2);
  ok('T6 parseJsonColumn scalar degrades to fallback', parseJsonColumn(7, { z: 1 }).z === 1);
}

// ── T7. directory presets ───────────────────────────────────────────────────
// Every preset must survive the SAME validation a hand-typed template gets —
// a preset is a convenience, never a bypass.
{
  const presetKeys = NETWORK_DIRECTORY.filter((n) => n.preset).map((n) => n.key);
  ok('T7 five postback-class presets exist',
    presetKeys.join() === 'taboola,outbrain,newsbreak,revcontent,mgid', presetKeys.join());
  for (const key of presetKeys) {
    const body = presetBodyFor(key);
    const r = validateNetworkBody(body, { isCreate: true });
    ok(`T7 preset ${key} passes create validation`, r.ok === true, JSON.stringify(r));
    const shape = validateTemplateShape(body.url_template);
    ok(`T7 preset ${key} template shape is legal`, shape.ok === true, JSON.stringify(shape));
    // A preset carrying a credential placeholder MUST land disabled.
    const net = NETWORK_DIRECTORY.find((n) => n.key === key);
    if (net.preset.needs_credential) {
      ok(`T7 preset ${key} (needs a credential) lands DISABLED`, body.enabled === false, String(body.enabled));
      ok(`T7 preset ${key} carries an ALL-CAPS placeholder`,
        /YOUR_[A-Z_]+/.test(body.url_template), body.url_template);
    } else {
      ok(`T7 preset ${key} (no credential) lands ENABLED`, body.enabled === true, String(body.enabled));
    }
    // The preset renders to a real URL with a real click id.
    const fired = renderPostback(body.url_template, postbackContext({
      eventName: 'Purchase', clickId: 'CID', value: 12.3, currency: 'USD', orderId: 'o1',
    }));
    ok(`T7 preset ${key} renders to a parseable URL`, (() => {
      try { new URL(fired); return true; } catch { return false; }
    })(), fired);
    ok(`T7 preset ${key} carries the click id`, fired.includes('CID'), fired);
  }
  ok('T7 an unknown preset key returns null', presetBodyFor('nope') === null);
  ok('T7 adUrlFor builds a funnel ad URL',
    adUrlFor('meta', 'https://shop.example/f/x') === 'https://shop.example/f/x?utm_source=meta&campaignid={{campaign.id}}&sub1={{ad.id}}&sub2={{adset.id}}&sub3={{site_source_name}}',
    adUrlFor('meta', 'https://shop.example/f/x'));
  ok('T7 adUrlFor joins with & when the base already has a query',
    adUrlFor('meta', 'https://shop.example/p?a=1').includes('?a=1&utm_source=meta'),
    adUrlFor('meta', 'https://shop.example/p?a=1'));
  ok('T7 adUrlFor with no base returns empty', adUrlFor('meta', '') === '');
  ok('T7 adUrlFor for a macro-less network returns empty', adUrlFor('applovin', 'https://x.example') === '');
  // Every directory card declares an honest wiring state.
  const states = new Set(NETWORK_DIRECTORY.map((n) => n.wired));
  ok('T7 every card declares wired ∈ {server,preset,stub}',
    [...states].every((s) => ['server', 'preset', 'stub'].includes(s)), [...states].join());
  ok('T7 exactly ONE card claims a server adapter (meta)',
    NETWORK_DIRECTORY.filter((n) => n.wired === 'server').map((n) => n.key).join() === 'meta',
    NETWORK_DIRECTORY.filter((n) => n.wired === 'server').map((n) => n.key).join());
  ok('T7 twelve cards', NETWORK_DIRECTORY.length === 12, String(NETWORK_DIRECTORY.length));
}

// ── T8. the macro list the UI advertises is the list the engine defines ─────
{
  const ctx = postbackContext({});
  const missing = MACRO_NAMES.filter((m) => !Object.prototype.hasOwnProperty.call(ctx, m));
  ok('T8 every advertised macro exists in the context', missing.length === 0, missing.join());
  const undeclared = Object.keys(ctx).filter((k) => !MACRO_NAMES.includes(k));
  ok('T8 every context key is advertised', undeclared.length === 0, undeclared.join());
}

// ── T9. PERSISTED-ERROR SANITIZATION (review M1) ────────────────────────────
// Postback trackers echo the request URL in their error bodies, and an
// operator's template carries their credential — in the query OR in a path
// segment. errOf is the single chokepoint into lb_tracking_events.error and
// lb_postback_queue.last_error, so the proof lives on it.
{
  const { errOf, stripUrls, sanitizeForPersist, redactTokens } =
    await import('../../src/services/trackingDelivery.js');

  // 9a. THE REVIEWER'S REPRO: a partner 400 that quotes the credentialed URL.
  const echoed = 'Bad Request: could not process https://tracker.example.com/pb?api_key=SK_LIVE_9f3a2b&cid=abc — invalid click id';
  const persisted = errOf({ ok: false, status: 400, body: { raw: echoed } });
  ok('T9a the credential does NOT survive into the persisted error',
    !persisted.includes('SK_LIVE_9f3a2b'), persisted);
  ok('T9a no URL survives into the persisted error',
    !persisted.includes('://') && persisted.includes('[url-redacted]'), persisted);
  ok('T9a the status still survives', persisted.startsWith('http_400'), persisted);
  // POSITIVE CONTROL — the diagnostic prose must NOT be collateral damage.
  ok('T9a the partner’s actual diagnostic survives', persisted.includes('invalid click id'), persisted);

  // 9b. PATH-SEGMENT credential (the MGID preset shape). No `key=` to anchor
  // on — only wholesale URL stripping catches this.
  const mgid = errOf({ ok: false, status: 500, body: { raw: 'upstream error for https://a.mgid.com/postback/PB_SECRET_77/?c=x' } });
  ok('T9b a PATH-segment credential does not survive', !mgid.includes('PB_SECRET_77'), mgid);

  // 9c. A credential OUTSIDE a URL (a JSON error body) still needs key
  // redaction — URL stripping alone would miss it.
  const jsonBody = errOf({ ok: false, status: 401, body: { error: 'unauthorized', api_key: 'AK_abc123', token: 'TK_zzz' } });
  ok('T9c a JSON-body api_key is redacted', !jsonBody.includes('AK_abc123'), jsonBody);
  ok('T9c a JSON-body token is redacted', !jsonBody.includes('TK_zzz'), jsonBody);
  ok('T9c the non-secret field survives', jsonBody.includes('unauthorized'), jsonBody);

  // 9d. The generic key list catches the names an operator's partner uses,
  // including prefixed forms a `\b`-anchored bare word cannot reach.
  for (const [k, v] of [['api_key', 'V1'], ['apikey', 'V2'], ['access_key', 'V3'],
    ['x-api-key', 'V4'], ['partner_token', 'V5'], ['secret', 'V6'],
    ['password', 'V7'], ['sig', 'V8']]) {
    const s = sanitizeForPersist(`upstream said ${k}=${v}_LEAK is bad`);
    ok(`T9d generic redaction covers ${k}=`, !s.includes(`${v}_LEAK`), s);
  }

  // 9e. The transport-error branch is sanitized too — an undici message can
  // quote the request target.
  const netErr = errOf({ ok: false, error: 'network:connect ECONNREFUSED for https://t.example/pb?key=NOPE123' });
  ok('T9e the transport-error branch strips the URL', !netErr.includes('NOPE123') && !netErr.includes('://'), netErr);
  ok('T9e it keeps the error CLASS so retryable() can still classify it',
    netErr.startsWith('network:'), netErr);

  // 9f. The classifier still sees the exact strings it branches on. If
  // sanitization mangled these, hard errors would start retrying forever.
  for (const e of ['not_configured', 'no_identity', 'kind_not_wired', 'pixel_gone',
    'unsafe_url:blocked_host', 'unsafe_url:dns_resolution_failed',
    'token_decrypt_failed', 'template_decrypt_failed']) {
    ok(`T9f sentinel survives sanitization: ${e}`, errOf({ ok: false, error: e }) === e, errOf({ ok: false, error: e }));
  }

  // 9g. Bounds + idempotency.
  const long = errOf({ ok: false, status: 500, body: { raw: 'x'.repeat(5000) } });
  ok('T9g the excerpt is capped at 200 chars', long.length <= 'http_500: '.length + 200, String(long.length));
  ok('T9g sanitizeForPersist is idempotent',
    sanitizeForPersist(sanitizeForPersist(echoed)) === sanitizeForPersist(echoed), '');
  ok('T9g stripUrls leaves non-URL text alone',
    stripUrls('plain diagnostic, no links') === 'plain diagnostic, no links', '');

  // 9h. redactTokens ITSELF must still return a usable URL — the
  // google-adapter/delivery-patches regressions depend on it, so the URL
  // stripping deliberately lives in errOf and NOT in redactTokens.
  const rt = redactTokens('https://x/y?refresh_token=RF_AAA&z=1');
  ok('T9h redactTokens still masks in place and keeps the URL',
    rt.includes('https://x/y') && !rt.includes('RF_AAA') && rt.includes('z=1'), rt);
}

// ── T10. B1 — EACH NETWORK GETS ITS OWN CLICK ID ────────────────────────────
// The seam audit's blocker. The envelope used to carry ONE click id chosen by
// `Object.values(vault)[0]` — ALPHABETICAL — so a visitor who arrived with both
// an fbclid and a tblci sent Taboola a postback labelled `click-id=` carrying
// the META token, because 'fbclid' sorts before 'ttclid'. Accepted, matched
// nothing, invisible.
{
  const { selectClickId, customPostbackContext } =
    await import('../../src/services/trackingDelivery.js');

  // The exact vault from the audit: two networks' tokens on one visitor.
  const vault = { fbclid: 'FBCLID_AAA', tblci: 'TBLCI_BBB', gclid: 'GCLID_CCC' };
  const env = { event_name: 'Purchase', event_id: 'pur_1', click_ids: vault, custom_data: { value: 10, currency: 'USD' } };

  const taboola = { click_id_param: 'tblci', label: 'Taboola S2S', url_template: '' };
  const meta = { click_id_param: 'fbclid', label: 'Meta-ish', url_template: '' };
  const unknown = { click_id_param: 'zzclid', label: 'Not In Vault', url_template: '' };
  const noParam = { click_id_param: '', label: 'No Param', url_template: '' };

  ok('T10 Taboola gets the TABOOLA id', selectClickId(taboola, env) === 'TBLCI_BBB', selectClickId(taboola, env));
  ok('T10 the Meta-param network gets the META id', selectClickId(meta, env) === 'FBCLID_AAA', selectClickId(meta, env));
  // THE BUG, pinned: alphabetical selection would hand this one FBCLID_AAA.
  ok('T10 a network whose param is ABSENT gets EMPTY, never another network’s id',
    selectClickId(unknown, env) === '', selectClickId(unknown, env));
  ok('T10 …and specifically NOT the alphabetically-first token',
    selectClickId(unknown, env) !== 'FBCLID_AAA', selectClickId(unknown, env));
  ok('T10 a network with NO configured param gets EMPTY, not a platform token',
    selectClickId(noParam, env) === '', selectClickId(noParam, env));
  // …unless the vault carries an explicitly GENERIC click_id, which is the one
  // key that belongs to nobody in particular.
  ok('T10 a NO-param network does take an explicitly generic click_id',
    selectClickId(noParam, { click_ids: { click_id: 'GEN_1' } }) === 'GEN_1', '');
  // With NO vault at all there is nothing to choose wrongly, so the legacy
  // single-value path survives (this is what test-fire uses).
  ok('T10 with no vault the single user_data click_id is still used',
    selectClickId(taboola, { user_data: { click_id: 'LEGACY' } }) === 'LEGACY', '');

  // Assert on the RENDERED URL, which is what actually goes on the wire.
  const tmpl = 'https://trc.taboola.com/pb?click-id={click_id}&key={click_key}&amt={payout}';
  const rendered = renderPostback(tmpl, customPostbackContext({ config: taboola, funnel_id: 'f1' }, env));
  ok('T10 the RENDERED Taboola URL carries the Taboola id',
    rendered.includes('click-id=TBLCI_BBB'), rendered);
  ok('T10 the RENDERED Taboola URL does NOT carry the Meta id',
    !rendered.includes('FBCLID_AAA'), rendered);
  ok('T10 {click_key} and {click_id} agree with each other',
    rendered.includes('key=tblci') && rendered.includes('click-id=TBLCI_BBB'), rendered);
  const renderedUnknown = renderPostback(tmpl, customPostbackContext({ config: unknown, funnel_id: 'f1' }, env));
  ok('T10 an unmatched network renders an EMPTY click id, not a foreign one',
    renderedUnknown.includes('click-id=&') && !renderedUnknown.includes('FBCLID_AAA'), renderedUnknown);
}

// ── T11. B2 — RELAYED custom_data is attacker-supplied ──────────────────────
// A forged /track/collect beacon reaches the custom sender with whatever
// custom_data it likes. sendGa4 has always validated this precisely; the custom
// sender validated NOTHING.
{
  const { sanitizeCustomData, customPostbackContext } =
    await import('../../src/services/trackingDelivery.js');

  const forged = {
    value: 999999999,            // absurd
    currency: 'not-a-currency',
    order_id: 'co_REAL_BUYERS_ORDER',
    status: 'approved',
    subs: { sub1: 'x', sub99: 'y', evil: { a: 1 } },
    extra_field: 'passthrough?',
  };
  const relayed = sanitizeCustomData(forged, { relayed: true });
  ok('T11 an absurd value is DROPPED, not clamped to a wrong number', relayed.value === undefined, JSON.stringify(relayed));
  ok('T11 a malformed currency is dropped', relayed.currency === undefined, JSON.stringify(relayed));
  ok('T11 order_id is dropped on a RELAYED event (no grafting onto a real order)',
    relayed.order_id === undefined, JSON.stringify(relayed));
  ok('T11 unknown fields do not pass through', relayed.extra_field === undefined, JSON.stringify(relayed));
  ok('T11 out-of-range sub keys are dropped', relayed.subs && relayed.subs.sub99 === undefined, JSON.stringify(relayed.subs));
  ok('T11 object-valued subs are dropped', relayed.subs && relayed.subs.evil === undefined, JSON.stringify(relayed.subs));
  ok('T11 a legitimate sub survives', relayed.subs && relayed.subs.sub1 === 'x', JSON.stringify(relayed.subs));

  // A SERVER-side event keeps its order id — the restriction is about trust,
  // not about the field being dangerous in itself.
  const server = sanitizeCustomData({ value: 49.5, currency: 'usd', order_id: 'co_1' }, { relayed: false });
  ok('T11 a SERVER event keeps its order_id', server.order_id === 'co_1', JSON.stringify(server));
  ok('T11 a server value in range survives', server.value === 49.5, JSON.stringify(server));
  ok('T11 currency is upper-cased and kept', server.currency === 'USD', JSON.stringify(server));

  // Negative + non-finite money never reaches the wire, whatever the path.
  for (const bad of [-1, -0.01, Infinity, NaN, 'abc', 1e12]) {
    const s = sanitizeCustomData({ value: bad });
    const url = renderPostback('https://x.example/pb?v={payout}',
      customPostbackContext({ config: {} , funnel_id: 'f' }, { custom_data: { value: bad } }));
    ok(`T11 value ${String(bad)} is refused end-to-end`, s.value === undefined && url === 'https://x.example/pb?v=', `${JSON.stringify(s)} ${url}`);
  }
  // …and an explicit 0 is still legitimate.
  ok('T11 an explicit 0 survives', sanitizeCustomData({ value: 0 }).value === 0);

  // A forged status cannot invent a vocabulary.
  ok('T11 an unknown status is dropped (falls back to approved)',
    sanitizeCustomData({ status: 'PAID_IN_FULL' }).status === undefined, '');
  ok('T11 a known status survives', sanitizeCustomData({ status: 'refund' }).status === 'refund', '');
}

// ── T12. the {funnel} macro, and live sub-ids ───────────────────────────────
{
  const { customPostbackContext } = await import('../../src/services/trackingDelivery.js');
  const ctx = customPostbackContext(
    { config: { label: 'Taboola S2S', click_id_param: 'tblci' }, funnel_id: 'f_42' },
    {
      event_name: 'Purchase', event_id: 'e1', funnel_name: 'Summer Sale Funnel',
      click_ids: { tblci: 'T1' }, subs: { sub1: 'ad_9', sub2: 'set_3' },
    }
  );
  // MINOR: {funnel} used to render the NETWORK's label, making {funnel} and
  // {network} the same string on every postback.
  ok('T12 {funnel} is the FUNNEL name', ctx.funnel === 'Summer Sale Funnel', ctx.funnel);
  ok('T12 {network} is the NETWORK label', ctx.network === 'Taboola S2S', ctx.network);
  ok('T12 they are no longer the same string', ctx.funnel !== ctx.network, '');
  ok('T12 {funnel_id} is still the id', ctx.funnel_id === 'f_42', ctx.funnel_id);
  // MINOR: sub-ids now arrive from the click vault, not only from the
  // test-fire fixture.
  ok('T12 {sub1}/{sub2} render from the envelope subs', ctx.sub1 === 'ad_9' && ctx.sub2 === 'set_3', `${ctx.sub1}/${ctx.sub2}`);
  ok('T12 an unset sub is still empty', ctx.sub7 === '', JSON.stringify(ctx.sub7));
  // custom_data.subs (server-built) beats the envelope's when both exist.
  const both = customPostbackContext({ config: {}, funnel_id: 'f' },
    { custom_data: { subs: { sub1: 'FROM_CD' } }, subs: { sub1: 'FROM_ENV' } });
  ok('T12 custom_data.subs wins over envelope.subs when both are present',
    both.sub1 === 'FROM_CD', both.sub1);
}

// ── T13. M8 — the event vocabulary and its gates ────────────────────────────
{
  const { CUSTOM_EVENT_NAMES, SERVER_OWNED_EVENTS, EVENT_FLAG_GATE, readEventNames } =
    await import('../../src/services/trackingCustomNetworks.js');
  ok('T13 PageView is NOT selectable for a custom network',
    !CUSTOM_EVENT_NAMES.includes('PageView'), CUSTOM_EVENT_NAMES.join());
  ok('T13 a stored PageView toggle is read back out (never fires)',
    readEventNames(['Purchase', 'PageView']).join() === 'Purchase', readEventNames(['Purchase', 'PageView']).join());
  ok('T13 Purchase and Refund are server-owned',
    SERVER_OWNED_EVENTS.has('Purchase') && SERVER_OWNED_EVENTS.has('Refund'), '');
  ok('T13 a non-money event is NOT server-owned', !SERVER_OWNED_EVENTS.has('Lead'), '');
  ok('T13 AddToCart is gated by fire_addtocart_checkout',
    EVENT_FLAG_GATE.AddToCart === 'fire_addtocart_checkout', '');
  ok('T13 ViewContent is gated by fire_viewcontent_lead',
    EVENT_FLAG_GATE.ViewContent === 'fire_viewcontent_lead', '');
  ok('T13 Purchase is NOT flag-gated (money is not optional)',
    EVENT_FLAG_GATE.Purchase === undefined, '');
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
