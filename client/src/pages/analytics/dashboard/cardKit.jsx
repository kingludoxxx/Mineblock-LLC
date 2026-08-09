// cardKit — the card shapes the analytics dashboard is built from
// (NEW FILE, LANE 3).
//
// The reference overview is not sixteen bespoke widgets; it is a line card, a
// donut, a horizontal bar list, a table and a P&L list, repeated with different
// data. Building the same set here is what lets the page grow a card by adding
// a config object instead of a component, and it is what makes "every card
// handles loading, empty and missing-key" a property of one file.
//
// THE THREE STATES, in every card, non-negotiable:
//   · loading -> shimmer skeleton. NOT an em dash and NOT the empty state: a
//     page that is still fetching must never be pixel-identical to a dead one.
//   · empty   -> "No data for this date range".
//   · absent  -> a key the server did not send is NOT zero. A card whose whole
//     subject is missing is hidden by the composer; a card that merely lost a
//     column renders the rows it has.
//
// Every accessor is null-tolerant by construction — `rows` may be null, a row
// may be a number-less object, a label may be undefined. None of it may throw:
// ErrorBoundary sits at the App root, so one thrown render blanks the workspace.
//
// COLOUR. Recharts takes concrete colour strings, so the series palette is
// fixed hex chosen against this app's dark surfaces; all chrome (borders, text,
// backgrounds, grid) stays on the Tailwind theme tokens.
//
// EXPORTS ARE COMPONENTS ONLY — formatters live in ./dashFormat.js, so the
// react-refresh lint rule stays quiet and there is one definition of each.
import {
  Area, AreaChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  EM_DASH, bucketAxisLabel, bucketTooltipLabel, fmtMoney, hourTooltipLabel,
  numOrGap,
} from './dashFormat.js';

/** The line/area colour — the app's gold accent reads on #111113. */
const ACCENT = '#c9a84c';
/** Categorical ramp for donuts and bars. */
const SERIES_COLORS = [
  '#c9a84c', '#e8d5a3', '#60a5fa', '#a78bfa', '#22c55e',
  '#f59e0b', '#38bdf8', '#f472b6', '#94a3b8', '#4ade80',
];
const colorAt = (i) => SERIES_COLORS[i % SERIES_COLORS.length];

const AXIS = {
  stroke: 'rgba(255,255,255,0.4)',
  fontSize: 10,
  tickLine: false,
  axisLine: false,
};

const EMPTY_TEXT = 'No data for this date range';

/* ── shell ───────────────────────────────────────────────────────────────── */

/** The empty state, centred in the card's well. */
export function EmptyState({ text = EMPTY_TEXT, height = 140 }) {
  return (
    <div
      className="flex items-center justify-center text-xs text-text-muted"
      style={{ minHeight: height }}
      data-testid="an-card-empty"
    >
      {text}
    </div>
  );
}

/** Shimmer placeholder — deliberately NOT the empty state. */
export function CardSkeleton({ rows = 4, height = 140 }) {
  return (
    <div className="space-y-2" style={{ minHeight: height }} data-testid="an-card-skeleton" aria-busy="true">
      {Array.from({ length: Math.max(1, rows) }).map((_, i) => (
        <div
          key={i}
          className="h-3 rounded bg-bg-elevated animate-pulse"
          style={{ width: `${88 - i * 11}%` }}
        />
      ))}
    </div>
  );
}

/**
 * The card frame every tile shares.
 *
 * `break-inside-avoid` and `mb-3` live HERE, not at the call site, because the
 * grid is a CSS-columns masonry: a card that forgets them gets sliced in half
 * across a column boundary. `flush` drops the margin for cards outside the
 * masonry, where the parent's own gap does the spacing — passing `mb-0` as a
 * className would NOT work, since Tailwind emits mb-0 before mb-3.
 */
export function Card({
  title, headline, sub, action, footer, children, testid, className = '', flush = false,
}) {
  return (
    <section
      className={`${flush ? '' : 'mb-3'} break-inside-avoid rounded-xl border border-border-default bg-bg-card p-4 ${className}`}
      data-testid={testid}
    >
      {(title || action) && (
        <header className="flex items-start justify-between gap-2 mb-1">
          <div className="min-w-0">
            {title && <h3 className="text-[13px] font-semibold tracking-tight text-text-primary truncate">{title}</h3>}
            {headline !== undefined && headline !== null && (
              <p className="text-xl tabular-nums font-medium tracking-tight text-text-primary mt-0.5">{headline}</p>
            )}
            {sub && <p className="text-[11px] text-text-muted mt-0.5 leading-snug">{sub}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
      {footer}
    </section>
  );
}

/* ── tooltip ─────────────────────────────────────────────────────────────── */

function ChartTooltip({ active, payload, label, fmt }) {
  if (!active || !payload || !payload.length) return null;
  const f = typeof fmt === 'function' ? fmt : fmtMoney;
  // The comparison series is overlaid BY INDEX, so its own calendar date has to
  // be shown or the dashed value looks like it belongs to the axis date.
  const prevDay = payload[0] && payload[0].payload ? payload[0].payload.px : '';
  // Current period FIRST, comparison second and quiet — the old period is
  // context, not the headline.
  const rows = [...payload].sort(
    (a, b) => (a.name === 'Previous' ? 1 : 0) - (b.name === 'Previous' ? 1 : 0),
  );
  return (
    <div className="rounded-lg border border-border-default bg-bg-card px-2.5 py-1.5 shadow-xl">
      <p className="text-[10px] uppercase tracking-wide text-text-muted">
        {(payload[0] && payload[0].payload && payload[0].payload.xl) || label}
      </p>
      {rows.map((p, i) => {
        const isPrev = p.name === 'Previous';
        return (
          <p key={i} className={`text-[11px] tabular-nums flex items-center gap-1.5 ${isPrev ? 'opacity-60' : ''}`}>
            <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: p.color || p.stroke }} />
            <span className="text-text-muted">{isPrev && prevDay ? prevDay : p.name}</span>
            <span className={isPrev ? 'text-text-muted' : 'font-medium text-text-primary'}>
              {p.value === null || p.value === undefined ? EM_DASH : f(p.value)}
            </span>
          </p>
        );
      })}
    </div>
  );
}

/* ── 1. LineCard ─────────────────────────────────────────────────────────── */

/**
 * Current period solid, previous period dashed and quiet.
 *
 * The two series are overlaid BY INDEX, not by date: the comparison period has
 * different calendar days but the same length, so day 1 sits over day 1. Its
 * own date rides in the tooltip so nobody misreads the dashes as belonging to
 * the current axis.
 *
 * A NEVER-MEASURED bucket is a HOLE in the line, not a point on the floor.
 * `connectNulls={false}` everywhere, and the count of holes is admitted in
 * words underneath — an empty stretch of canvas is not self-describing.
 */
export function LineCard({
  title, headline, sub, points, prevPoints, labels, prevLabels,
  fmt = fmtMoney, height = 200, loading, testid, footNote, comparisonLabel, flush,
}) {
  const cur = Array.isArray(points) ? points : [];
  const prev = Array.isArray(prevPoints) ? prevPoints : [];
  const lab = Array.isArray(labels) ? labels : [];
  const plab = Array.isArray(prevLabels) ? prevLabels : [];
  const n = Math.max(cur.length, prev.length);
  const data = Array.from({ length: n }).map((_, i) => ({
    x: bucketAxisLabel(lab[i]) || `#${i + 1}`,
    xl: hourTooltipLabel(lab[i]) || bucketTooltipLabel(lab[i]) || '',
    px: bucketTooltipLabel(plab[i]) || '',
    cur: i < cur.length ? numOrGap(cur[i]) : null,
    prev: i < prev.length ? numOrGap(prev[i]) : null,
  }));
  const measured = data.filter((d) => d.cur !== null || d.prev !== null);
  const hasAny = measured.length > 0;
  const gaps = data.filter((d) => d.cur === null).length;
  // Dots only when there ARE holes, so a lone measured bucket between two gaps
  // is still visible; a hole-free series renders as a clean line.
  const dotted = gaps > 0 ? { r: 1.6 } : false;

  return (
    <Card title={title} headline={headline} sub={sub} testid={testid} flush={flush}>
      {loading ? (
        <CardSkeleton rows={5} height={height} />
      ) : !n || !hasAny ? (
        <EmptyState height={height} />
      ) : (
        <>
          <div style={{ height }}>
            <ResponsiveContainer width="100%" height="100%">
              {/* left margin 0 and a 62px Y axis: at -14 the currency symbol of
                  a "$1,500" tick was clipped off the left edge of the card, and
                  a half-printed number on a money chart is worse than no axis. */}
              <LineChart data={data} margin={{ top: 8, right: 6, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                <XAxis dataKey="x" {...AXIS} minTickGap={28} />
                <YAxis {...AXIS} width={62} tickFormatter={(v) => fmt(v)} />
                <Tooltip
                  cursor={{ stroke: 'rgba(255,255,255,0.12)' }}
                  content={<ChartTooltip fmt={fmt} />}
                  wrapperStyle={{ outline: 'none' }}
                />
                {prev.length > 0 && (
                  <Line
                    type="monotone" dataKey="prev" name="Previous"
                    stroke="#71717a" strokeWidth={1.2} strokeDasharray="4 4"
                    dot={false} isAnimationActive={false} connectNulls={false}
                  />
                )}
                <Line
                  type="monotone" dataKey="cur" name="Current"
                  stroke={ACCENT} strokeWidth={1.8} dot={dotted}
                  isAnimationActive={false} connectNulls={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p
            className="text-[10.5px] text-text-faint text-center mt-1"
            data-testid={testid ? `${testid}-caption` : undefined}
          >
            <span className="inline-block h-[2px] w-3 align-middle mr-1" style={{ background: ACCENT }} />
            {comparisonLabel || 'vs previous period'}
            {footNote ? ` · ${footNote}` : ''}
            {gaps > 0 ? ` · ${gaps} day${gaps === 1 ? '' : 's'} not measured` : ''}
          </p>
        </>
      )}
    </Card>
  );
}

/* ── 2. DonutCard ────────────────────────────────────────────────────────── */

/**
 * Thin ring, total in the middle, legend as a value list.
 *
 * Long tails fold into a single "+N more" slice — a 60-slice ring is unreadable
 * and its legend pushes the total off the card. The folded rows keep their money
 * in the centre total, so the middle number is always the whole thing.
 */
export function DonutCard({
  title, rows, fmt = fmtMoney, centerFmt, centerLabel, maxSlices = 6,
  height = 190, loading, testid, sub, flush, footer,
}) {
  const clean = (Array.isArray(rows) ? rows : [])
    .filter(Boolean)
    .map((r) => ({ label: String(r.label ?? EM_DASH), value: numOrGap(r.value) }))
    .filter((r) => r.value !== null && r.value > 0)
    .sort((a, b) => b.value - a.value);
  const total = clean.reduce((s, r) => s + r.value, 0);
  const head = clean.slice(0, maxSlices);
  const tail = clean.slice(maxSlices);
  const slices = tail.length
    ? [...head, { label: `+${tail.length} more`, value: tail.reduce((s, r) => s + r.value, 0) }]
    : head;
  const cf = centerFmt || fmt;

  return (
    <Card title={title} sub={sub} testid={testid} flush={flush} footer={footer}>
      {loading ? (
        <CardSkeleton rows={4} height={height} />
      ) : !slices.length ? (
        <EmptyState height={height} />
      ) : (
        <div className="flex items-center gap-3">
          <div className="relative shrink-0" style={{ width: 150, height }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={slices} dataKey="value" nameKey="label"
                  innerRadius="62%" outerRadius="88%" paddingAngle={1.5}
                  stroke="none" isAnimationActive={false}
                >
                  {slices.map((s, i) => <Cell key={`${s.label}-${i}`} fill={colorAt(i)} />)}
                </Pie>
                <Tooltip content={<ChartTooltip fmt={fmt} />} wrapperStyle={{ outline: 'none' }} />
              </PieChart>
            </ResponsiveContainer>
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <span className="text-base tabular-nums font-medium tracking-tight text-text-primary">{cf(total)}</span>
              <span className="text-[10px] text-text-muted">{centerLabel || 'total'}</span>
            </div>
          </div>
          <ul className="min-w-0 flex-1 space-y-1">
            {slices.map((s, i) => (
              /* Two funnels can legitimately share a display name, so the
                 label alone is not a unique key — index it. */
              <li key={`${s.label}-${i}`} className="flex items-center gap-1.5 text-[11px] min-w-0">
                <span className="inline-block h-2 w-2 rounded-[2px] shrink-0" style={{ background: colorAt(i) }} />
                <span className="truncate text-text-muted" title={s.label}>{s.label}</span>
                <span className="ml-auto tabular-nums whitespace-nowrap text-text-primary">{fmt(s.value)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

/* ── 3. HBarCard ─────────────────────────────────────────────────────────── */

/**
 * Label above, bar below, value at the end.
 *
 * TWO TRUNCATIONS STACK HERE and both must be visible. The server ranks and
 * ships its top N rows; this card then keeps the top `limit` of those. So the
 * card ad budget gets moved on could show eight campaigns out of forty with
 * nothing on screen admitting the other thirty-two exist.
 *
 * The honest period figure is on the wire: the breakdown's `total` is folded
 * over EVERY bucket BEFORE the rank cut, and `rows_total` is the bucket count,
 * precisely so a surface can say "Top 8 of 40 · $123,456". ABSENT IS NOT ZERO:
 * with no `total` the footer claims no period figure at all, and with no
 * `totalRows` the denominator falls back to the rows this card was handed —
 * honest about the client-side cut, silent about the server-side one it cannot
 * see.
 */
export function HBarCard({
  title, rows, fmt = fmtMoney, limit = 8, loading, testid, sub, emptyText, flush,
  total, totalRows, totalLabel = 'total', footer,
}) {
  const all = (Array.isArray(rows) ? rows : []).filter(Boolean);
  const clean = all
    .map((r) => ({
      label: String(r.label ?? EM_DASH),
      value: numOrGap(r.value),
      sub: r.sub == null ? '' : String(r.sub),
    }))
    .filter((r) => r.value !== null && r.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, Math.max(1, limit));
  const max = clean.reduce((m, r) => Math.max(m, r.value), 0) || 1;

  // The LARGEST bucket count we can actually prove. The wire count normally
  // wins (it predates the rank cut), the rows we were handed are the fallback,
  // and the rows we drew are the floor: a stale fold must never let the card
  // claim it is showing more of the list than it is.
  const wireRows = Number(totalRows);
  const windowRows = Math.max(
    Number.isFinite(wireRows) ? wireRows : 0, all.length, clean.length,
  );
  const hidden = windowRows - clean.length;
  const totalNum = Number(total);
  const hasTotal = total !== null && total !== undefined && Number.isFinite(totalNum);

  return (
    <Card title={title} sub={sub} testid={testid} flush={flush} footer={footer}>
      {loading ? (
        <CardSkeleton rows={5} />
      ) : !clean.length ? (
        <EmptyState text={emptyText} />
      ) : (
        <>
          <ul className="space-y-2 mt-1.5">
            {clean.map((r, i) => (
              <li key={`${r.label}-${i}`}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[11px] truncate text-text-muted" title={r.label}>{r.label}</span>
                  {r.sub && <span className="text-[10px] text-text-faint shrink-0">{r.sub}</span>}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <div className="h-3 flex-1 rounded-[3px] bg-bg-elevated overflow-hidden">
                    <div
                      className="h-full rounded-[3px]"
                      style={{ width: `${Math.max(2, (r.value / max) * 100)}%`, background: ACCENT }}
                    />
                  </div>
                  <span className="text-[11px] tabular-nums whitespace-nowrap text-text-primary">{fmt(r.value)}</span>
                </div>
              </li>
            ))}
          </ul>
          {(hidden > 0 || hasTotal) && (
            <p className="text-[10.5px] text-text-faint mt-2" data-testid={testid ? `${testid}-footer` : undefined}>
              {hidden > 0 ? `Top ${clean.length} of ${windowRows}` : `All ${clean.length}`}
              {hasTotal ? ` · ${fmt(totalNum)} ${totalLabel}` : ''}
            </p>
          )}
        </>
      )}
    </Card>
  );
}

/* ── 4. TableCard ────────────────────────────────────────────────────────── */

/**
 * A plain right-aligned-numbers table. `columns` are
 * `{key, label, align, fmt, className}`; a missing cell renders an em dash,
 * never a zero.
 */
export function TableCard({
  title, columns, rows, limit = 10, loading, testid, sub, onRowClick, rowKey, flush,
}) {
  const cols = Array.isArray(columns) ? columns : [];
  const all = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const shown = all.slice(0, Math.max(1, limit));

  return (
    <Card title={title} sub={sub} testid={testid} flush={flush}>
      {loading ? (
        <CardSkeleton rows={6} />
      ) : !shown.length || !cols.length ? (
        <EmptyState />
      ) : (
        <div className="overflow-x-auto -mx-1 px-1">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-text-muted border-b border-border-default">
                {cols.map((c) => (
                  <th
                    key={c.key}
                    className={`font-medium py-1.5 ${c.align === 'right' ? 'text-right pl-2' : 'text-left pr-2'}`}
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr
                  key={(rowKey && rowKey(r, i)) || i}
                  onClick={onRowClick ? () => onRowClick(r) : undefined}
                  className={`h-8 border-b border-border-default/50 last:border-b-0 ${onRowClick ? 'cursor-pointer hover:bg-bg-elevated/40' : ''}`}
                >
                  {cols.map((c) => {
                    const v = r ? r[c.key] : undefined;
                    const text = v === null || v === undefined || v === ''
                      ? EM_DASH
                      : (c.fmt ? c.fmt(v, r) : String(v));
                    return (
                      <td
                        key={c.key}
                        className={`${c.align === 'right' ? 'text-right tabular-nums pl-2' : 'text-left pr-2 truncate max-w-[220px]'} ${c.className || ''}`}
                        title={c.align === 'right' ? undefined : String(v ?? '')}
                      >
                        {text}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {all.length > shown.length && (
            <p className="text-[10.5px] text-text-faint mt-1.5">{`+${all.length - shown.length} more`}</p>
          )}
        </div>
      )}
    </Card>
  );
}

/* ── 5. BreakdownListCard ────────────────────────────────────────────────── */

/**
 * "Total sales breakdown" — a P&L, not a chart.
 *
 * Rows carry a `kind`: "negative" prints in the deduction colour, "total" gets
 * the rule above it and the heavier weight. A row whose value is null renders
 * an em dash: on a money screen "we did not measure this" and "this was zero"
 * are different facts and only one of them is safe to print as $0.00.
 */
export function BreakdownListCard({ title, rows, fmt = fmtMoney, loading, testid, sub, flush, footer }) {
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
  const anyValue = list.some((r) => r.value !== null && r.value !== undefined);

  return (
    <Card title={title} sub={sub} testid={testid} flush={flush} footer={footer}>
      {loading ? (
        <CardSkeleton rows={6} />
      ) : !list.length || !anyValue ? (
        <EmptyState />
      ) : (
        <ul className="mt-1">
          {list.map((r, i) => {
            const missing = r.value === null || r.value === undefined;
            const isTotal = r.kind === 'total';
            return (
              <li
                key={r.label || i}
                className={`flex items-baseline justify-between gap-3 py-[7px] text-[11px] ${isTotal ? 'border-t border-border-default mt-1 pt-2 font-semibold' : ''}`}
              >
                <span className={isTotal ? 'text-text-primary' : 'text-text-muted'} title={r.hint || undefined}>
                  {r.label}
                </span>
                <span
                  className={`tabular-nums whitespace-nowrap ${missing ? 'text-text-faint' : r.kind === 'negative' ? 'text-danger' : 'text-text-primary'}`}
                  title={missing ? (r.missingHint || undefined) : undefined}
                >
                  {missing ? EM_DASH : (r.fmt || fmt)(r.value)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/* ── 6. Sparkline (KPI tiles) ────────────────────────────────────────────── */

/**
 * Shape context only, anchored to the bottom of a KPI tile. The headline number
 * and its delta both come from the SERVER'S metric math — this draws the series
 * and claims nothing. Holes stay holes here too.
 */
export function Sparkline({ series, gradId }) {
  const data = (Array.isArray(series) ? series : []).map((v, i) => ({ i, v: numOrGap(v) }));
  const hasShape = data.filter((d) => d.v !== null).length > 1
    && data.some((d) => d.v !== null && d.v !== 0);
  if (!hasShape) return null;
  const id = String(gradId || 'an-spark').replace(/[^a-zA-Z0-9_-]/g, '-');
  return (
    <div className="absolute inset-x-0 bottom-0 h-10 pointer-events-none opacity-60" aria-hidden="true">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={ACCENT} stopOpacity={0.35} />
              <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone" dataKey="v" stroke={ACCENT} strokeWidth={1.5}
            fill={`url(#${id})`} isAnimationActive={false} dot={false} connectNulls={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ── 7. NotCollectedCard ─────────────────────────────────────────────────── */

/**
 * A dimension this build DOES NOT COLLECT — device and country breakdowns until
 * the gated Lane 5 ships them.
 *
 * NEVER OMITTED SILENTLY and NEVER FABRICATED. Dropping the card would let an
 * operator conclude the split does not matter; rendering an empty state would
 * assert "no mobile traffic in this range", which is a measurement we did not
 * take. The card says which one it is, in words.
 */
export function NotCollectedCard({ title, what, testid, flush }) {
  return (
    <Card title={title} testid={testid} flush={flush}>
      <div
        className="rounded-lg border border-dashed border-border-default px-3 py-5 text-center"
        style={{ minHeight: 120 }}
      >
        <p className="text-xs text-text-muted">Not collected</p>
        <p className="text-[10.5px] text-text-faint mt-1 leading-relaxed max-w-[280px] mx-auto">
          {what}
        </p>
        <p className="text-[10.5px] text-text-faint mt-1.5">
          This is an absence of measurement, not a measurement of zero.
        </p>
      </div>
    </Card>
  );
}
