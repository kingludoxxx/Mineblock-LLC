// Pure, framework-free helpers for applying a theme plan on the client.
//
// These live in their OWN file (not ThemesSection.jsx) for two reasons: react-
// refresh wants only component exports in a .jsx, and — more importantly — the
// node harness imports this file directly to prove the STALE-PLAN guard (M1)
// by execution. Keep it dependency-free.
//
// THE STALE-PLAN PROBLEM (M1). apply-plan is computed against the funnel's
// settings AT PREVIEW TIME and shown in a confirm dialog. A modal can sit open
// while another tab (or another operator) edits the same funnel. If we then
// commit the preview's writes, the dialog's "from" values are a lie and we
// destroy whatever the row holds NOW — including colors set after the preview,
// for which the destructive warning never even rendered. recomputeDiff lets the
// commit re-derive the true diff against the FRESH row inside the serialized
// save, so a changed "from" is caught before the PATCH lands.

export const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

// Read the current stored value at a plan write's dotted settings path.
function currentAt(settings, path) {
  const [head, tail] = String(path).split('.');
  if (!tail) return settings?.[head];
  return isObj(settings?.[head]) ? settings[head][tail] : undefined;
}

// Recompute a plan's per-write "from"/"changed" and the overwrite set against a
// given settings object. Mirrors the server's buildApplyPlan exactly: colors
// compare case-insensitively; a change is an OVERWRITE only when the prior
// value was a real hand-tuned value ('' and the font sentinel 'default' are
// fills, not overwrites).
export function recomputeDiff(writes, settings) {
  const st = isObj(settings) ? settings : {};
  const outWrites = [];
  const overwrites = [];
  let changed = 0;
  for (const w of Array.isArray(writes) ? writes : []) {
    const cur = currentAt(st, w.path);
    const from = cur == null ? '' : String(cur);
    const to = String(w.to);
    const isColor = String(w.path).startsWith('brand_colors');
    const didChange = isColor ? from.toLowerCase() !== to.toLowerCase() : from !== to;
    if (didChange) changed += 1;
    if (didChange && from && from !== 'default') overwrites.push({ path: w.path, from, to });
    outWrites.push({ ...w, from, changed: didChange });
  }
  return { writes: outWrites, overwrites, changed_count: changed };
}

// A stable signature for comparing two overwrite sets (order follows plan.writes
// order, which is fixed, so a plain stringify is deterministic).
export function overwriteSignature(overwrites) {
  return JSON.stringify((overwrites || []).map((o) => [o.path, String(o.from).toLowerCase(), String(o.to).toLowerCase()]));
}

// Apply a plan's dotted writes onto a settings object, returning a NEW object.
// The caller never re-derives which token maps where — it only sets the paths
// the server named — so the mapping has exactly one home (the server).
export function applyWrites(settings, writes) {
  const out = isObj(settings) ? { ...settings } : {};
  for (const w of Array.isArray(writes) ? writes : []) {
    const [head, tail] = String(w.path).split('.');
    if (!tail) { out[head] = w.to; continue; }
    out[head] = isObj(out[head]) ? { ...out[head] } : {};
    out[head][tail] = w.to;
  }
  return out;
}

export default { recomputeDiff, overwriteSignature, applyWrites, isObj };
