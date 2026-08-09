/**
 * The explorer's series palette, in its own module so ExplorerChart.jsx exports
 * a component and nothing else (Fast Refresh only works on component-only
 * files, and the legend in index.jsx needs the same colours the chart draws —
 * two lists would drift and the legend would start lying about which line is
 * which).
 *
 * Index 0 is the dashboard accent so a single-metric explore matches the rest
 * of the app; the remainder are distinguishable at the 2px stroke width the
 * chart uses.
 */
const SERIES_COLORS = [
  '#c9a84c', // accent
  '#60a5fa',
  '#34d399',
  '#f472b6',
  '#f59e0b',
  '#a78bfa',
  '#22d3ee',
  '#fb7185',
];

/** Stable per-series colour; wraps rather than running out (max 8 metrics). */
export const colorForIndex = (i) => SERIES_COLORS[((i % SERIES_COLORS.length) + SERIES_COLORS.length) % SERIES_COLORS.length];

export default SERIES_COLORS;
