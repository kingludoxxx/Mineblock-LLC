// Statics <-> Product Bible: turn bible angle entities into the option objects the angle chips already render.
// An option keeps the chip contract ({ id, name, hook_strategy }) and adds bible_key / tier / avatar_keys.

export function toBibleAngleOptions(angles) {
  return (Array.isArray(angles) ? angles : []).filter((a) => a && a.key).map((a) => ({
    id: `bible:${a.key}`,
    key: a.key,
    bible_key: a.key,
    name: a.title || a.data?.name || a.key,
    tier: a.tier || a.data?.tier || null,
    avatar_keys: Array.isArray(a.avatar_keys) ? a.avatar_keys : (a.data?.avatar_ids || []),
    hook_strategy: typeof a.data?.lead_with === 'string' ? a.data.lead_with : '',
  }));
}

/** Two picker selections are the same choice. */
export function sameBible(a, b) {
  if (!a || !b) return !a && !b;
  return String(a.product) === String(b.product) && a.market === b.market
    && (a.avatar || null) === (b.avatar || null) && (a.angle || null) === (b.angle || null);
}
