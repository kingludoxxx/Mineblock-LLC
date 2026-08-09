// Formatting for the Analytics view.
//
// THE ONE RULE THAT MATTERS HERE: `null` and `0` are different facts and must
// never render the same. `null` means the source degraded or the sample was
// below the floor — we could not measure it. `0` means we measured it and it
// is zero. Rendering null as "0" would turn "tracking is down" into "nobody
// visited", which is exactly the kind of silent wrong number this subsystem
// exists to avoid. Every formatter below returns EM_DASH for null/undefined.
export const EM_DASH = '—';

const isNil = (v) => v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v));

export function fmtMoney(v, currency = 'USD') {
  if (isNil(v)) return EM_DASH;
  const n = Number(v);
  const s = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency || 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(n));
  return n < 0 ? `−${s}` : s;
}

export function fmtInt(v) {
  if (isNil(v)) return EM_DASH;
  return new Intl.NumberFormat('en-US').format(Math.round(Number(v)));
}

/** A rate stored as a fraction (0.275) rendered as a percentage (27.5%). */
export function fmtRate(v, dp = 1) {
  if (isNil(v)) return EM_DASH;
  return `${(Number(v) * 100).toFixed(dp)}%`;
}

/** A percentage already stored as a percentage (e.g. vs-control 12.4). */
export function fmtPct(v, dp = 1) {
  if (isNil(v)) return EM_DASH;
  const n = Number(v);
  return `${n > 0 ? '+' : ''}${n.toFixed(dp)}%`;
}

export function fmtDate(iso) {
  if (!iso) return EM_DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return EM_DASH;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Negative money and negative lifts render in the danger colour. */
export const signClass = (v) =>
  isNil(v) ? 'text-text-muted' : Number(v) < 0 ? 'text-danger' : 'text-text-primary';

export const liftClass = (v) =>
  isNil(v) ? 'text-text-muted' : Number(v) < 0 ? 'text-danger' : Number(v) > 0 ? 'text-green-400' : 'text-text-muted';

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function daysAgoIso(n) {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}
