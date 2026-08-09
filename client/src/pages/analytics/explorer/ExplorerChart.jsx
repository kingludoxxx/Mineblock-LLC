/**
 * ExplorerChart — the line / bar surface for the query mode.
 *
 * TWO HONESTY RULES ARE LOAD-BEARING HERE:
 *  1. connectNulls={false}. A null is "we could not measure this day"; drawing
 *     a straight segment across it invents the days in between. The gap IS the
 *     finding.
 *  2. The compare overlay is aligned BY INDEX, which is what the engine
 *     promises ("compare = equal-length preceding window, series aligned by
 *     index"). Day N of this window sits above day N of the previous one, and
 *     the tooltip prints both labels so nobody has to guess which is which.
 */
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';
import { EM_DASH } from '../format';
import { colorForIndex } from './chartColors';

const PREV_PREFIX = '__prev_';
const AXIS = { stroke: '#52525b', fontSize: 11 };

function ExplorerTooltip({ active, payload, label, labels, formatters, prevLabel }) {
  if (!active || !Array.isArray(payload) || !payload.length) return null;
  return (
    <div className="rounded-lg border border-border-default bg-bg-elevated px-3 py-2 shadow-xl">
      <p className="text-xs font-semibold text-text-primary mb-1">{label}</p>
      {payload.map((p) => {
        const isPrev = String(p.dataKey).startsWith(PREV_PREFIX);
        const metric = isPrev ? String(p.dataKey).slice(PREV_PREFIX.length) : String(p.dataKey);
        const fmt = formatters[metric];
        return (
          <p key={p.dataKey} className="text-xs text-text-muted flex items-center gap-2">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: p.color }} />
            <span>{labels[metric] || metric}{isPrev ? ` (${prevLabel})` : ''}</span>
            <span className="ml-auto pl-3 font-medium text-text-primary tabular-nums">
              {fmt ? fmt(p.value) : (p.value ?? EM_DASH)}
            </span>
          </p>
        );
      })}
    </div>
  );
}

/**
 * @param {'line'|'bar'} viz
 * @param {object[]} data      current rows/series ({key,label,<metric>})
 * @param {object[]} prevData  previous-window series, index-aligned (may be [])
 * @param {string[]} metricKeys
 * @param {object} labels      metric -> display label
 * @param {object} formatters  metric -> formatter fn
 */
export default function ExplorerChart({
  viz, data, prevData, metricKeys, labels = {}, formatters = {}, height = 300,
}) {
  const rows = Array.isArray(data) ? data : [];
  const prev = Array.isArray(prevData) ? prevData : [];
  const keys = Array.isArray(metricKeys) ? metricKeys : [];

  // Index alignment — NOT a key join. The previous window has different day
  // keys by construction, so joining on `key` would drop every point.
  const merged = rows.map((r, i) => {
    const out = { ...r, __label: r.label ?? r.key ?? EM_DASH };
    if (prev.length) {
      const p = prev[i] || {};
      out[`${PREV_PREFIX}__key`] = p.label ?? p.key ?? EM_DASH;
      keys.forEach((m) => { out[`${PREV_PREFIX}${m}`] = p[m] ?? null; });
    }
    return out;
  });

  const tooltip = (
    <Tooltip
      cursor={{ fill: 'rgba(255,255,255,0.04)', stroke: 'rgba(255,255,255,0.12)' }}
      content={(props) => (
        <ExplorerTooltip {...props} labels={labels} formatters={formatters} prevLabel="previous" />
      )}
    />
  );

  const axes = (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
      <XAxis dataKey="__label" tick={AXIS} tickLine={false} axisLine={false} minTickGap={16} />
      <YAxis tick={AXIS} tickLine={false} axisLine={false} width={64} />
      {tooltip}
    </>
  );

  if (viz === 'bar') {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={merged} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          {axes}
          {keys.map((m, i) => (
            <Bar key={m} dataKey={m} fill={colorForIndex(i)} radius={[3, 3, 0, 0]} />
          ))}
          {prev.length > 0 && keys.map((m, i) => (
            <Bar key={`${PREV_PREFIX}${m}`} dataKey={`${PREV_PREFIX}${m}`}
              fill={colorForIndex(i)} fillOpacity={0.28} radius={[3, 3, 0, 0]} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={merged} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        {axes}
        {keys.map((m, i) => (
          <Line key={m} type="monotone" dataKey={m} stroke={colorForIndex(i)}
            strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
        ))}
        {prev.length > 0 && keys.map((m, i) => (
          <Line key={`${PREV_PREFIX}${m}`} type="monotone" dataKey={`${PREV_PREFIX}${m}`}
            stroke={colorForIndex(i)} strokeWidth={1.5} strokeDasharray="4 3"
            strokeOpacity={0.65} dot={false} connectNulls={false} isAnimationActive={false} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
