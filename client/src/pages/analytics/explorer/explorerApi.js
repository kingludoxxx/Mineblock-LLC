/**
 * explorerApi — the Lane 1 / Lane 2 calls the explorer makes, and the readers
 * that turn their responses into the one shape the UI renders.
 *
 * THE READERS ARE WRITTEN AGAINST THE SHIPPED SERVICES, not against a guess:
 *   Lane 1  server/src/services/funnelMetrics.js      @3e42a8e
 *   Lane 2  server/src/services/funnelAttribution.js  @fd52aac
 * Where a field does not exist server-side it is DERIVED here and said so in a
 * comment; where it does exist it is read by its real name. The previous
 * version of this file read `prev_series`, `result.clicks` and a `by_network`
 * block, none of which any endpoint emits.
 *
 * FENCE: Lane 3 owns client/src/pages/analytics/metricsApi.js. This file does
 * not import it — Lane 4 ships without waiting on Lane 3.
 *
 * Endpoints (api.js carries the /api/v1 baseURL):
 *   POST /funnel-metrics/query
 *   GET  /funnel-metrics/query.csv?q=<url-encoded JSON body>
 *   GET  /funnel-metrics/presets
 *   GET  /funnel-metrics/definitions         (the legality matrix; authority)
 *   GET  /funnel-attribution/roas?funnel_id&days&dimension
 *   GET  /funnel-attribution/clicks?funnel_id&limit&network
 */
import api from '../../../services/api.js';
import { MAX_CLICKS_LIMIT, MAX_ROAS_DAYS } from '../reportConfig.js';

/* ── error mapping ─────────────────────────────────────────────────────── */

/**
 * The two engines refuse in two different vocabularies and both are worth
 * translating rather than swallowing:
 *   Lane 1 → 422 {error: code, message, detail}   (MetricsError)
 *   Lane 2 → 400 {error: code}                    (no message at all)
 * A Lane 2 refusal carries NO prose, so without this table the operator gets
 * "Report failed — try again." for a window they can actually fix.
 */
const ERROR_SENTENCES = {
  // Lane 2 (and the window codes Lane 1 reuses verbatim from parseWindow)
  invalid_days: 'That day count is out of range — pick between 1 and 180 days.',
  invalid_limit: 'That row limit is out of range.',
  invalid_dimension: 'That group-by is not one this report offers.',
  invalid_date: 'That date is not a real calendar day.',
  invalid_date_format: 'Dates must be YYYY-MM-DD.',
  to_before_from: 'The start day is after the end day.',
  window_too_large: 'That window is longer than the engine will read at once.',
  // Lane 1
  metrics_required: 'Pick at least one metric.',
  unknown_metric: 'That metric is not one this deployment serves.',
  too_many_metrics: 'Too many metrics selected.',
  unknown_dimension: 'That group-by is not one this deployment serves.',
  dimension_unavailable: 'That group-by is registered but not collected yet.',
  illegal_metric_for_dimension: 'Those metrics are not measured by that group-by.',
  unknown_granularity: 'That granularity is not one this deployment serves.',
  hour_requires_single_day: 'Hourly buckets need a single-day window.',
  metric_not_available_hourly: 'That metric is not measured hourly.',
  bad_limit: 'That row limit is out of range.',
  bad_body: 'The query was malformed.',
  bad_q: 'The export link was malformed.',
  invalid_window: 'That window was rejected.',
};

/**
 * Turn an axios failure into copy an operator can act on.
 * Order: the server's own prose (always the most specific) → our sentence for
 * its code → a status sentence → the caller's fallback.
 */
export function explorerApiError(err, fallback = 'Query failed — try again.') {
  const res = err && err.response;
  const status = res && res.status;
  const data = (res && res.data) || {};
  const body = typeof data === 'string' ? { error: '', message: data } : data;
  const code = typeof body.error === 'string' ? body.error : '';
  const prose = typeof body.message === 'string' && body.message ? body.message
    : (typeof body.detail === 'string' && body.detail ? body.detail : '');

  const sentence = ERROR_SENTENCES[code] || '';
  if (status === 422 || status === 400) {
    const head = sentence || 'That combination isn’t valid.';
    // The engine's own message names the exact metric or day; ours names the
    // class. Print both when they differ — one is actionable, one is orienting.
    return prose && prose !== head ? `${head} (${prose})` : head;
  }
  if (status === 401 || status === 403) return 'Not authorised to read analytics.';
  if (status === 404) return 'That report endpoint is not deployed yet.';
  if (status >= 500) return 'The analytics engine failed on that query — this is a bug, not your input.';
  if (sentence) return sentence;
  if (prose) return prose;
  return fallback;
}

/* ── calls ─────────────────────────────────────────────────────────────── */

/** POST /funnel-metrics/query — body is the MetricsQueryBody verbatim. */
export async function runQuery(body, config) {
  const { data } = await api.post('/funnel-metrics/query', body, config);
  return data;
}

/**
 * GET /funnel-metrics/definitions — the engine's legality matrix.
 *
 * `/vocabulary` is the earlier spelling of the same payload and is tried only
 * on a 404. A 404 on BOTH is not an error: it means this deployment predates
 * the endpoint, the local fallback table stays in charge, and the engine still
 * refuses anything the two disagree on.
 */
export async function fetchVocabulary(config) {
  try {
    const { data } = await api.get('/funnel-metrics/definitions', config);
    return data;
  } catch (err) {
    if (err?.response?.status !== 404) throw err;
    const { data } = await api.get('/funnel-metrics/vocabulary', config);
    return data;
  }
}

/** GET /funnel-metrics/presets → always an array. */
export async function fetchPresets(config) {
  const { data } = await api.get('/funnel-metrics/presets', config);
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.presets)) return data.presets;
  if (data && Array.isArray(data.reports)) return data.reports;
  return [];
}

/** GET /funnel-attribution/roas. `days` clamped to the documented cap. */
export async function fetchRoas({ funnelId, dimension, days }, config) {
  const { data } = await api.get('/funnel-attribution/roas', {
    ...config,
    params: {
      funnel_id: funnelId,
      dimension,
      days: Math.max(1, Math.min(MAX_ROAS_DAYS, Number(days) || 30)),
    },
  });
  return data;
}

/** GET /funnel-attribution/clicks. `limit` clamped to the documented cap. */
export async function fetchClicks({ funnelId, network, limit = 200 }, config) {
  const params = {
    funnel_id: funnelId,
    limit: Math.max(1, Math.min(MAX_CLICKS_LIMIT, Number(limit) || 200)),
  };
  if (network) params.network = network;
  const { data } = await api.get('/funnel-attribution/clicks', { ...config, params });
  return data;
}

/**
 * GET /funnel-metrics/query.csv — the endpoint takes the EXACT POST body as
 * ONE url-encoded JSON param (?q=). Flat params are a guaranteed 422.
 */
export async function fetchQueryCsvBlob(body, config) {
  const params = new URLSearchParams();
  params.set('q', JSON.stringify(body));
  const { data } = await api.get(`/funnel-metrics/query.csv?${params.toString()}`, {
    ...config,
    responseType: 'blob',
  });
  return data;
}

/* ── response readers (shape-tolerant, never throwing) ─────────────────── */

const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const s = (v) => (typeof v === 'string' ? v : '');
const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Normalise a window echo. Lane 1 puts it at meta.window {start_day,end_day,
 * days} with meta.timezone alongside; Lane 2 puts it at window
 * {start,end,days,timezone}. The UI needs ONE shape, and it needs the SERVER's
 * — printing the picker's window while the server answered a different one is
 * how a report gets read against the wrong dates.
 */
function readWindow(source, fallbackTz) {
  const w = obj(source);
  const start = s(w.start_day) || s(w.start);
  const end = s(w.end_day) || s(w.end);
  return {
    start_day: start,
    end_day: end,
    days: n(w.days),
    timezone: s(w.timezone) || s(fallbackTz),
    // False until the server actually named a window — the caller must not
    // print "the server said" over its own picker values.
    from_server: Boolean(start && end),
  };
}

/**
 * Normalise a /query response.
 *
 * `previous.series` is the ONE spelling Lane 1 emits (runQuery builds
 * out.previous = {series|rows, totals, window, aligned_by}); the top-level
 * `prev_series` this used to read first belongs to the dashboard composite and
 * never arrives here. It is still accepted as a trailing fallback so a future
 * composite reader can share this function.
 */
export function readQueryResult(data) {
  const d = obj(data);
  const previous = obj(d.previous);
  const meta = obj(d.meta);
  const prevSeries = arr(previous.series).length ? arr(previous.series) : arr(d.prev_series);
  const prevRows = arr(previous.rows);
  const prevTotals = obj(previous.totals);
  return {
    kind: 'query',
    series: arr(d.series),
    rows: arr(d.rows),
    totals: obj(d.totals),
    prevSeries,
    prevRows,
    prevTotals,
    // DERIVED FROM WHAT WAS READ, not from the presence of the key: a
    // `previous: {}` that carried nothing usable must not light up delta chips
    // that then have no baseline to compute against.
    hasPrevious: prevSeries.length > 0 || prevRows.length > 0 || Object.keys(prevTotals).length > 0,
    prevWindow: readWindow(previous.window, meta.timezone),
    meta,
    basisLabel: s(meta.basis_label),
    warnings: arr(meta.warnings),
    timezone: s(meta.timezone),
    window: readWindow(meta.window, meta.timezone),
    limit: n(meta.limit),
  };
}

/**
 * Normalise a /funnel-attribution/roas response.
 * Real fields: rows[{key,label,clicks,bot_clicks,conversions,revenue,cost,
 * cost_known,cost_source,cost_unknown_reason,cost_note,cpa,roas}], totals (same
 * minus key/label), rows_total, row_cap, basis, basis_label, cost_sources,
 * window{start,end,days,timezone}, meta.
 */
export function readRoasResult(data) {
  const d = obj(data);
  const meta = obj(d.meta);
  const rows = arr(d.rows);
  return {
    kind: 'roas',
    rows,
    totals: d.totals && typeof d.totals === 'object' ? d.totals : null,
    dimension: s(d.dimension),
    rowsTotal: n(d.rows_total) ?? rows.length,
    rowCap: Boolean(d.row_cap),
    basisLabel: s(d.basis_label),
    window: readWindow(d.window),
    timezone: s(obj(d.window).timezone),
    meta,
    warnings: arr(meta.warnings),
  };
}

/**
 * Normalise a /funnel-attribution/clicks response.
 * Real fields: rows[{id,time,day,network,click_id,click_key,campaign,country,
 * device,cpc,converted,converted_at,session_id,bot,velocity_flag}], limit,
 * truncated, timezone, meta. `clicks` is accepted as an alias only.
 */
export function readClicksResult(data) {
  const d = obj(data);
  const meta = obj(d.meta);
  const rows = arr(d.rows).length ? arr(d.rows) : arr(d.clicks);
  return {
    kind: 'clicks',
    rows,
    // DERIVED. There is no by_network block on the wire; folding the page here
    // is honest as long as it is labelled as being about THE ROWS ON SCREEN,
    // which is what `truncated` is for.
    byNetwork: foldByNetwork(rows),
    limit: n(d.limit),
    truncated: Boolean(d.truncated),
    timezone: s(d.timezone),
    meta,
    warnings: arr(meta.warnings),
  };
}

/** Per-network counts folded from the rows on screen. Never a server figure. */
export function foldByNetwork(rows) {
  const out = {};
  arr(rows).forEach((r) => {
    const key = s(r && r.network) || '(none)';
    const b = out[key] || (out[key] = { clicks: 0, converted: 0, bots: 0 });
    b.clicks += 1;
    if (r && r.converted) b.converted += 1;
    if (r && r.bot) b.bots += 1;
  });
  return out;
}
