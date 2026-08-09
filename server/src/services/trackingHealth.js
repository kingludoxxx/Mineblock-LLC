// Tracking health — the PURE shaping layer behind
// GET /api/v1/funnels/:id/tracking/health.
//
// Zero imports, zero I/O on purpose: fixture rows in, per-pixel verdicts out,
// so the classification can be exercised by `node` directly
// (server/tests/tracking/health-shape.mjs). Every SQL read lives in
// routes/funnelTrackingExtras.js; nothing here touches a connection.
//
// WHY A STATE MACHINE AT ALL (divergence from the reference tool): funnel-os's
// LBTrackingHealthDashboard is a TALLY view — it renders counts and tints them,
// and a configured pixel that has never emitted simply does not appear. That
// cannot answer the only question an operator actually asks ("is my Meta pixel
// broken right now?"), because it cannot tell SILENT apart from NOT CONFIGURED.
// This module classifies instead, from real delivery records only.
//
// THE HONESTY RULES (these are the whole point — do not "simplify" them):
//   1. Zero traffic is NOT a failure. A pixel with no rows in the window reads
//      'no_traffic', never 'failing'. An empty funnel is not a broken funnel.
//   2. 'skipped' is NOT a failure. trackingDelivery logs status='skipped' for
//      HARD_ERRORS — no_identity, skipped_window, no_click_id, kind_not_wired,
//      pixel_gone — which mean "we correctly declined to send this event",
//      not "the endpoint is down". The existing /tracking-admin summary folds
//      skipped into failed_24h; this surface deliberately does NOT, and reports
//      skips separately with their reason. Conflating them makes a healthy
//      funnel with out-of-window replays look broken.
//   3. An outage reads as an outage. The circuit breaker (lb_postback_breakers,
//      5 consecutive endpoint failures → 15 min open) and a live retry backlog
//      (lb_postback_queue status queued/sending) are the two real signals that
//      delivery is DOWN as opposed to individual events being declined.
//   4. Never invent a status. Every verdict below is a function of rows that
//      exist; absence of rows produces 'no_traffic', never a green check.

// The breaker opens after this many CONSECUTIVE endpoint failures and stays
// open for a cooldown. Mirrors BREAKER_FAILS in services/trackingDelivery.js
// (:22) — kept as a named constant here so the operator copy can state the
// threshold instead of hard-coding "5" into a sentence.
export const BREAKER_FAIL_THRESHOLD = 5;

// Severity ordering — drives the funnel-level roll-up (worst pixel wins) and
// the client's sort. Higher is worse.
export const STATUS_RANK = {
  healthy: 0,
  no_traffic: 1,
  disabled: 1,
  not_active: 2,
  no_deliveries: 2,
  degraded: 3,
  misconfigured: 4,
  failing: 5,
  outage: 6,
};

// Operator-facing wording. `tone` maps onto the modal's existing pill tones.
export const STATUS_META = {
  healthy: { label: 'Firing', tone: 'success' },
  no_traffic: { label: 'No traffic', tone: 'default' },
  no_deliveries: { label: 'Nothing sent', tone: 'warning' },
  disabled: { label: 'Disabled', tone: 'default' },
  not_active: { label: 'Not delivering', tone: 'warning' },
  degraded: { label: 'Degraded', tone: 'warning' },
  misconfigured: { label: 'Not ready', tone: 'warning' },
  failing: { label: 'Failing', tone: 'danger' },
  outage: { label: 'Outage', tone: 'danger' },
  no_pixels: { label: 'No pixels', tone: 'default' },
};

// lb_tracking_events.platform is the lb_pixels.kind minus the '_pixel' suffix
// (trackingDelivery.deliverOne). One helper, so the join rule lives in exactly
// one place on this surface.
export const platformOfKind = (kind) => String(kind || '').replace(/_pixel$/, '');

// The breaker scope is `${funnelId}:${pixelRowId}` (trackingDelivery.deliverOne
// line ~686). Breakers are therefore PER PIXEL ROW, which is what lets this
// surface show breaker state per pixel rather than per funnel.
export const breakerScopeId = (funnelId, pixelRowId) => `${funnelId || ''}:${pixelRowId}`;

// postgres.js returns a jsonb column as a parsed object, but a value written by
// an older path (or double-encoded by a JSON.stringify that should never have
// happened) can come back as a STRING. Read both shapes, never throw.
// Mirrors the same defensive read in middleware/rbac.js.
export function asObject(v) {
  if (v == null) return {};
  if (typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

const int = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

const ZERO_WINDOW = { sent: 0, failed: 0, skipped: 0, deduped: 0, queued: 0 };

const windowFrom = (row) => ({
  sent: int(row && row.sent),
  failed: int(row && row.failed),
  skipped: int(row && row.skipped),
  deduped: int(row && row.deduped),
  queued: int(row && row.queued),
});

// Any delivery record at all in the window — the test for "no traffic".
const windowTotal = (w) => w.sent + w.failed + w.skipped + w.deduped + w.queued;

const msOf = (v) => {
  if (v == null) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};

// The server channel can actually fire: enabled, an id (unless the kind allows
// none), the kind's stored secret, AND a mode that relays server events.
// 'native' is browser-only, so it is NOT a server channel — and a browser-only
// pixel must never be called misconfigured for lacking a server credential.
// Same rule as trackingAdmin's server_channel_ready, kept in sync deliberately.
export function serverChannelReady(pixel, spec) {
  const cfg = asObject(pixel && pixel.config);
  const s = spec || {};
  return Boolean(
    !s.notActive
    && pixel
    && pixel.enabled
    && (pixel.pixel_id || s.idOptional)
    && (!s.readySecret || cfg[s.readySecret])
    && (pixel.mode === 's2s' || pixel.mode === 'hybrid')
  );
}

// ── the classifier ──────────────────────────────────────────────────────────
// Order is the semantics. Each branch answers a DIFFERENT question, and the
// earlier ones explain the later ones away: there is no point calling a
// disabled pixel "no traffic", or a pixel behind an open breaker "failing" —
// the breaker IS the reason.
//
// PRECEDENCE TABLE (first match wins). The grouping is deliberate:
//
//   #  status         condition                              why it sits here
//   1  disabled       enabled === false                      operator intent — nothing is expected
//   2  not_active     spec.notActive                         no adapter exists; counters are meaningless
//   -- HARD EVIDENCE OF BROKEN DELIVERY (red) ------------------------------
//   3  outage         breaker open                           circuit tripped; explains the backlog below
//   4  outage         queuedNow > 0 && sent === 0            live backlog, nothing getting through
//   5  failing        failed  > 0 && sent === 0              every attempt failed
//   -- CONFIGURATION (amber) ------------------------------------------------
//   6  misconfigured  server channel required but not ready  cause of a FUTURE zero, not of a live failure
//   -- QUIET ----------------------------------------------------------------
//   7  no_traffic     no ledger rows AND no live backlog     silence is not failure
//   -- PARTIAL / OK ---------------------------------------------------------
//   8  degraded       (failed > 0 || queuedNow > 0)          implies sent > 0 by now
//   9  healthy        sent > 0                               deliveries landing, nothing failing
//  10  no_deliveries  only skips and/or dedupes              traffic, but nothing was sent
//
// WHY 3-5 OUTRANK 6 (fixed after review — this was inverted): `misconfigured`
// is inferred from CONFIG SHAPE, while failing/outage are measured from real
// delivery records. When both are true the records win, because they are
// evidence and the config check is only a prediction. With the old order a
// pixel sitting on 400 failed sends and 500 stranded conversions rendered as a
// calm amber "Not ready" — the single most under-alarming state this surface
// could produce. Regression probes: T16a/T16b.
//
// WHY 4 OUTRANKS 5: when a backlog exists AND sends are failing, 'outage' is
// both more accurate and more actionable — it tells the operator delivery is
// down AND that the events are preserved for retry rather than lost.
export function classifyPixel({ pixel, spec, h24, breakerOpen, queuedNow }) {
  const s = spec || {};
  const w = h24 || ZERO_WINDOW;

  // 1. The operator turned it off. Nothing is expected to fire.
  if (pixel && pixel.enabled === false) {
    return { status: 'disabled', reason: 'This pixel is switched off — nothing is sent for it.' };
  }
  // 2. Registered but no delivery adapter exists (today: google_ads). A fire
  //    dead-letters as kind_not_wired in one pass. Never imply it is working.
  if (s.notActive) {
    return {
      status: 'not_active',
      reason: 'Credentials are stored but there is no delivery adapter — nothing is being sent for this network.',
    };
  }
  // 3. The breaker is open: five consecutive ENDPOINT failures tripped the
  //    circuit. This is an outage, and it explains any queue backlog below it.
  if (breakerOpen) {
    return {
      status: 'outage',
      reason: 'The circuit breaker is open after repeated endpoint failures — events are being queued, not sent.',
    };
  }
  // 4. A live retry backlog with nothing getting through. Ahead of both
  //    `failing` and `misconfigured`: real stranded conversions outrank a
  //    config prediction, and 'outage' says the events are preserved.
  if (queuedNow > 0 && w.sent === 0) {
    return {
      status: 'outage',
      reason: 'Events are backed up in the retry queue and nothing has been delivered in this window.',
    };
  }
  // 5. There WAS activity and every delivery attempt failed.
  if (w.failed > 0 && w.sent === 0) {
    return { status: 'failing', reason: 'Every delivery attempt in this window failed.' };
  }
  // 6. Enabled and expected to relay, but the server channel cannot fire.
  //    Ahead of `no_traffic` because zero sends is the SYMPTOM and the missing
  //    credential is the cause — reporting "no traffic" would send the operator
  //    looking at their ad spend instead of their token. BEHIND the two
  //    branches above: see the precedence note in the header.
  if (!serverChannelReady(pixel, s) && (pixel.mode === 's2s' || pixel.mode === 'hybrid')) {
    const cfg = asObject(pixel && pixel.config);
    const missing = [];
    if (!pixel.pixel_id && !s.idOptional) missing.push(s.idField || 'pixel_id');
    if (s.readySecret && !cfg[s.readySecret]) missing.push(s.readySecret);
    return {
      status: 'misconfigured',
      reason: missing.length
        ? `The server channel cannot fire — missing: ${missing.join(', ')}.`
        : 'The server channel is not ready to fire.',
      missing,
    };
  }
  // 7. Nothing at all happened in the window. NOT a failure — this is the
  //    honest reading for a funnel with no traffic, a paused campaign, or a
  //    brand-new pixel. The 7d counters and last_sent_at carry the nuance.
  //
  //    `queuedNow` is load-bearing here and is NOT part of windowTotal: the
  //    window counts the EVENT LEDGER (lb_tracking_events), while queuedNow is
  //    the LIVE backlog (lb_postback_queue). Those diverge in exactly the case
  //    that matters — events queued before the window opened are still stuck
  //    retrying, but their ledger rows have aged out of 24h. Without this
  //    clause a pixel with a live backlog and a quiet ledger reported "No
  //    traffic — nothing to judge" while conversions sat undelivered. Caught by
  //    the E2E harness (extras-e2e.mjs E7); the pure fixture had put the
  //    backlog in the ledger, which is not a shape the real system produces.
  if (windowTotal(w) === 0 && queuedNow === 0) {
    return { status: 'no_traffic', reason: 'No delivery records in this window — nothing to judge.' };
  }
  // 8. Partial trouble: some sends land, some fail or are waiting on a retry.
  //    Branches 4 and 5 already returned unless sent > 0, so this is genuinely
  //    the mixed case.
  if (w.failed > 0 || queuedNow > 0) {
    return { status: 'degraded', reason: 'Some events are delivering and some are failing or awaiting retry.' };
  }
  // 9. Sends landed and nothing failed.
  if (w.sent > 0) {
    return { status: 'healthy', reason: 'Events are being delivered.' };
  }
  // 10. Rows exist, none of them failed, and none of them was a SEND — the
  //     window is entirely skips and/or dedupes. Calling this 'healthy' would
  //     paint a green light over a pixel that delivered nothing (rule 2: a skip
  //     is a decline, not a failure — but it is also not a delivery).
  if (w.skipped > 0) {
    return {
      status: 'no_deliveries',
      reason: 'Events reached this pixel but every one was declined before sending — nothing was delivered.',
    };
  }
  return {
    status: 'no_deliveries',
    reason: 'Every event in this window was already delivered by another channel and deduplicated — nothing new was sent.',
  };
}

// The breaker block, INCLUDING its operator sentence.
//
// The copy lives here rather than in the client because the client cannot see
// the contradiction it used to render: with fails >= the threshold but the
// cooldown already lapsed, the state is 'closed' while the fail counter still
// reads 7, producing "7 consecutive failures — the breaker opens at 5" next to
// a calm closed state. `cooldown_lapsed` names that third state explicitly, and
// `note` is the single string the UI prints — so the wording is assertable in a
// harness instead of being re-derived in JSX.
export function breakerView(br, isOpen) {
  const fails = int(br && br.fails);
  const openUntil = br && br.open_until ? br.open_until : null;
  // Tripped at some point, but the open window has already elapsed: delivery is
  // allowed to try again and the next result decides. Not open, not clean.
  const cooldownLapsed = !isOpen && fails >= BREAKER_FAIL_THRESHOLD && Boolean(openUntil);
  let note = null;
  if (isOpen) {
    note = `Circuit breaker open after ${fails} consecutive endpoint failures — events are queued, not sent.`;
  } else if (cooldownLapsed) {
    note = `Cooldown lapsed after ${fails} consecutive failures — delivery is retrying.`;
  } else if (fails > 0) {
    note = `${fails} consecutive failure${fails === 1 ? '' : 's'} recorded — the breaker opens at ${BREAKER_FAIL_THRESHOLD}.`;
  }
  return {
    state: isOpen ? 'open' : 'closed',
    fails,
    open_until: openUntil,
    cooldown_lapsed: cooldownLapsed,
    note,
  };
}

// ── the join + roll-up ───────────────────────────────────────────────────────
// All arguments are PLAIN ROWS. `specs` is the registry knowledge (notActive /
// readySecret / idOptional / label) passed in as data so this module never has
// to import the route that owns the registry.
export function shapeTrackingHealth({
  funnelId = '',
  pixels = [],
  specs = {},
  counts = [],
  lasts = [],
  breakers = [],
  queueDepth = [],
  now = Date.now(),
} = {}) {
  const nowMs = typeof now === 'number' ? now : msOf(now) || Date.now();

  // counts rows: { platform, window: 'h24' | 'd7', sent, failed, skipped, deduped, queued }
  const countIdx = new Map();
  for (const r of counts) {
    countIdx.set(`${r.window}:${r.platform}`, windowFrom(r));
  }
  // lasts rows: { platform, last_sent_at, last_failed_at, last_error, last_any_at }
  const lastIdx = new Map(lasts.map((r) => [r.platform, r]));
  const breakerIdx = new Map(breakers.map((r) => [r.scope_id, r]));
  // queueDepth rows: { kind, n } — the LIVE depth (queued/sending), not a ledger.
  const queueIdx = new Map(queueDepth.map((r) => [r.kind, int(r.n)]));

  const out = pixels.map((pixel) => {
    const kind = pixel.kind;
    const spec = specs[kind] || {};
    const platform = platformOfKind(kind);
    const h24 = countIdx.get(`h24:${platform}`) || { ...ZERO_WINDOW };
    const d7 = countIdx.get(`d7:${platform}`) || { ...ZERO_WINDOW };
    const last = lastIdx.get(platform) || {};
    const br = breakerIdx.get(breakerScopeId(funnelId, pixel.id)) || null;
    const openUntilMs = msOf(br && br.open_until);
    const breakerIsOpen = Boolean(openUntilMs && openUntilMs > nowMs);
    const queuedNow = queueIdx.get(kind) || 0;

    const verdict = classifyPixel({ pixel, spec, h24, breakerOpen: breakerIsOpen, queuedNow });

    return {
      kind,
      label: spec.label || kind,
      // The kind's own name for its identity column (GA4 calls it
      // measurement_id, Google Ads customer_id) — so the UI never mislabels.
      id_field: spec.idField || 'pixel_id',
      pixel_id: pixel.pixel_id || null,
      mode: pixel.mode || null,
      enabled: pixel.enabled !== false,
      status: verdict.status,
      status_label: (STATUS_META[verdict.status] || {}).label || verdict.status,
      tone: (STATUS_META[verdict.status] || {}).tone || 'default',
      reason: verdict.reason,
      ...(verdict.missing && verdict.missing.length ? { missing: verdict.missing } : {}),
      server_channel_ready: serverChannelReady(pixel, spec),
      ...(spec.notActive ? { not_active: true } : {}),
      breaker: breakerView(br, breakerIsOpen),
      queued_now: queuedNow,
      windows: { h24, d7 },
      last_sent_at: last.last_sent_at || null,
      last_failed_at: last.last_failed_at || null,
      // Already token-redacted upstream by trackingDelivery.redactTokens before
      // it ever reached lb_tracking_events.error.
      last_error: last.last_error || null,
      last_skip_reason: last.last_skip_reason || null,
    };
  });

  // Worst pixel wins. An empty funnel is its own state — NOT 'healthy', which
  // would be a green light over nothing at all.
  let overall = 'no_pixels';
  for (const p of out) {
    if (overall === 'no_pixels' || (STATUS_RANK[p.status] || 0) > (STATUS_RANK[overall] || 0)) {
      overall = p.status;
    }
  }

  // totals_24h is a LEDGER SUM — every field is a count of lb_tracking_events
  // rows inside the 24h window, `queued` included (rows logged with
  // status='queued' when an event was escalated to the retry queue).
  //
  // `queued_now` is a DIFFERENT QUANTITY and is deliberately NOT in that
  // object: it is an INSTANTANEOUS gauge of lb_postback_queue depth, with no
  // window at all. Summing a 24h count and a right-now depth under one "last 24
  // hours" heading invited exactly the wrong reading (that N events queued
  // today), so the two are returned as separate, separately-labelled figures.
  const totals = out.reduce((a, p) => ({
    sent: a.sent + p.windows.h24.sent,
    failed: a.failed + p.windows.h24.failed,
    skipped: a.skipped + p.windows.h24.skipped,
    deduped: a.deduped + p.windows.h24.deduped,
    queued: a.queued + p.windows.h24.queued,
  }), { sent: 0, failed: 0, skipped: 0, deduped: 0, queued: 0 });
  const queuedNowTotal = out.reduce((a, p) => a + p.queued_now, 0);

  return {
    overall,
    overall_label: (STATUS_META[overall] || {}).label || overall,
    pixels: out.sort((a, b) => (STATUS_RANK[b.status] || 0) - (STATUS_RANK[a.status] || 0)),
    totals_24h: totals,
    // Right-now retry-queue depth across all pixels. No window — see above.
    queued_now: queuedNowTotal,
    // Stated, never implied — the client renders these verbatim so an operator
    // is never left guessing what "recent" meant.
    windows: { h24: '24 hours', d7: '7 days' },
    generated_at: new Date(nowMs).toISOString(),
  };
}

export default { shapeTrackingHealth, classifyPixel, serverChannelReady, asObject, STATUS_RANK, STATUS_META };
