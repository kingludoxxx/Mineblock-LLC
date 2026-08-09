// PAGE BUILDER — version-list presentation helpers.
//
// Pure functions, no React: they live in their own module so they can be
// exercised by a node harness (server/tests/builder/version-format.mjs) and
// so VersionsDrawer.jsx stays a components-only file for fast refresh.

/**
 * Relative time, degrading to an absolute date past a week — "9 days ago" is
 * less useful than a date. An unparseable timestamp renders as its own string
 * rather than "NaN ago": a version row with a broken date must still be
 * restorable, so this never throws and never blanks the row.
 */
export function relativeTime(value, now = Date.now()) {
  // `new Date(null)` is the UNIX EPOCH, not an invalid date — a null
  // created_at would otherwise render "Jan 1, 1970" with total confidence.
  // Absent is absent; it renders as nothing.
  if (value == null || value === '') return '';
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return String(value ?? '');
  const secs = Math.round((now - t) / 1000);
  // Clock skew between the browser and the server can put a fresh snapshot
  // slightly in the future; "in -3 seconds" is nonsense, "just now" is true.
  if (secs < 45) return 'just now';
  if (secs < 90) return '1 min ago';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days <= 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Byte count → human size. A missing/negative count reads '—', never 'NaN B'. */
export function formatBytes(n) {
  // `Number(null)` and `Number('')` are both 0 — an absent size would report
  // "0 B", which reads as "this version is empty" rather than "unknown".
  if (n == null || n === '') return '—';
  const b = Number(n);
  if (!Number.isFinite(b) || b < 0) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}
