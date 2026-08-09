/**
 * explorerApi — the four Lane 1 / Lane 2 calls the explorer makes, and nothing
 * else. Built against the documented response shapes (the work order is the
 * binding contract); every reader below is written so a shape that arrives
 * slightly differently degrades to "no rows" rather than to a crash.
 *
 * NOTE ON THE FENCE: Lane 3 owns client/src/pages/analytics/metricsApi.js.
 * This file deliberately does NOT import it — Lane 4 must build and ship
 * without waiting on Lane 3's file existing.
 *
 * Endpoints (api.js already carries the /api/v1 baseURL):
 *   POST /funnel-metrics/query
 *   GET  /funnel-metrics/query.csv?q=<url-encoded JSON body>
 *   GET  /funnel-metrics/presets
 *   GET  /funnel-attribution/roas?funnel_id&days&dimension
 *   GET  /funnel-attribution/clicks?funnel_id&limit&network
 */
import api from '../../../services/api.js';
import { MAX_CLICKS_LIMIT, MAX_ROAS_DAYS } from '../reportConfig.js';

/**
 * Turn an axios failure into copy an operator can act on.
 * A 422 is the engine refusing an ILLEGAL COMBINATION, and its own message is
 * always more useful than ours — surface it verbatim when it sends one.
 */
export function explorerApiError(err, fallback = 'Query failed — try again.') {
  const res = err && err.response;
  const status = res && res.status;
  const data = (res && res.data) || {};
  const detail = typeof data === 'string' ? data
    : (data.detail || data.error || data.message || '');
  if (status === 422) {
    return detail
      ? `That combination isn’t valid — ${String(detail)}`
      : 'That combination isn’t valid — check the metrics against the group-by.';
  }
  if (status === 401 || status === 403) return 'Not authorised to read analytics.';
  if (status === 404) return 'That report endpoint is not deployed yet.';
  if (detail) return String(detail);
  return fallback;
}

/** POST /funnel-metrics/query — body is the MetricsQueryBody verbatim. */
export async function runQuery(body, config) {
  const { data } = await api.post('/funnel-metrics/query', body, config);
  return data;
}

/** GET /funnel-metrics/presets → always an array. */
export async function fetchPresets(config) {
  const { data } = await api.get('/funnel-metrics/presets', config);
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.presets)) return data.presets;
  if (data && Array.isArray(data.reports)) return data.reports;
  return [];
}

/** GET /funnel-attribution/roas. `days` is clamped to the documented cap. */
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

/** GET /funnel-attribution/clicks. `limit` is clamped to the documented cap. */
export async function fetchClicks({ funnelId, network, limit = 200 }, config) {
  const params = { funnel_id: funnelId, limit: Math.max(1, Math.min(MAX_CLICKS_LIMIT, Number(limit) || 200)) };
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

/**
 * Normalise a /query response into the one shape the UI renders.
 *
 * The contract documents `{series[]|rows[], totals, previous?, meta}` for
 * /query and `series + prev_series` for the dashboard composite, so BOTH
 * previous-series spellings are read. `prev_totals` is only ever taken from
 * `previous.totals` — a compare with no previous block yields {} and the delta
 * chips stay off rather than baselining against a fabricated 0.
 */
export function readQueryResult(data) {
  const d = obj(data);
  const previous = obj(d.previous);
  return {
    series: arr(d.series),
    rows: arr(d.rows),
    totals: obj(d.totals),
    prevSeries: arr(d.prev_series).length ? arr(d.prev_series) : arr(previous.series),
    prevTotals: obj(previous.totals),
    hasPrevious: !!d.previous,
    meta: obj(d.meta),
  };
}

export function readRoasResult(data) {
  const d = obj(data);
  return {
    rows: arr(d.rows),
    totals: d.totals && typeof d.totals === 'object' ? d.totals : null,
    dimension: typeof d.dimension === 'string' ? d.dimension : '',
    meta: obj(d.meta),
  };
}

export function readClicksResult(data) {
  const d = obj(data);
  return {
    clicks: arr(d.clicks).length ? arr(d.clicks) : arr(d.rows),
    byNetwork: obj(d.by_network),
    meta: obj(d.meta),
  };
}
