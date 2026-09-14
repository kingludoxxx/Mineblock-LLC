// PRODUCT BIBLE — pure selection helpers shared by BiblePicker and the Statics angle chips. No React, no network.

const TIER_ORDER = ['A', 'B', 'C'];

export const AVATAR_TYPE_LABEL = { lead: 'Lead', sub: 'Sub', micro: 'Micro' };

/** Avatars ordered lead -> sub -> micro, keeping the bible's own order inside each type. */
export function sortAvatars(avatars) {
  const rank = { lead: 0, sub: 1, micro: 2 };
  return (avatars || [])
    .map((a, i) => ({ a, i }))
    .sort((x, y) => ((rank[x.a?.data?.type] ?? 3) - (rank[y.a?.data?.type] ?? 3)) || (x.i - y.i))
    .map((x) => x.a);
}

/** True when an angle is linked to an avatar, from either side of the link. */
export function angleFitsAvatar(angle, avatar) {
  if (!angle || !avatar) return false;
  const fromAngle = Array.isArray(angle.avatar_keys) ? angle.avatar_keys : (angle.data?.avatar_ids || []);
  if (fromAngle.includes(avatar.key)) return true;
  const best = Array.isArray(avatar.data?.best_angle_ids) ? avatar.data.best_angle_ids
    : (Array.isArray(avatar.angle_keys) ? avatar.angle_keys : []);
  return best.includes(angle.key);
}

/**
 * The angles to offer. With an avatar chosen: only the angles linked to it (when there are any), unless showAll.
 * @returns {{ angles: object[], filtered: boolean }}
 */
export function anglesForAvatar(angles, avatar, showAll = false) {
  const list = angles || [];
  if (!avatar || showAll) return { angles: list, filtered: false };
  const fit = list.filter((a) => angleFitsAvatar(a, avatar));
  return fit.length ? { angles: fit, filtered: true } : { angles: list, filtered: false };
}

/** [{ tier: 'A', angles: [...] }, ...] in A, B, C order; unknown tiers last under 'Other'. */
export function groupAnglesByTier(angles) {
  const groups = new Map();
  for (const a of angles || []) {
    const t = TIER_ORDER.includes(String(a?.tier || '').toUpperCase()) ? String(a.tier).toUpperCase() : 'Other';
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(a);
  }
  return [...TIER_ORDER, 'Other'].filter((t) => groups.has(t)).map((t) => ({ tier: t, angles: groups.get(t) }));
}

/** Names of the avatars an angle fits, for a caption. */
export function fitAvatarNames(angle, avatars) {
  if (!angle) return [];
  return (avatars || []).filter((av) => angleFitsAvatar(angle, av)).map((av) => av.title || av.data?.name || av.key);
}

/** The request-body value, or null when there is no complete product+market choice. */
export function toBibleBody(sel) {
  if (!sel || sel.product === undefined || sel.product === null || sel.product === '' || !sel.market) return null;
  return { product: sel.product, market: sel.market, avatar: sel.avatar || null, angle: sel.angle || null };
}

/** Same product (numeric id vs string id tolerant). */
export function sameProduct(a, b) {
  if (a === undefined || a === null || b === undefined || b === null) return false;
  return String(a) === String(b);
}

const STORE_KEY = 'productBible.lastSelection';

export function loadRemembered(productId) {
  try {
    const all = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    const v = all?.[String(productId)];
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

export function remember(sel) {
  if (!sel?.product) return;
  try {
    const all = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {};
    all[String(sel.product)] = { market: sel.market || null, avatar: sel.avatar || null, angle: sel.angle || null };
    localStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch {
    // storage blocked or full: remembering is a convenience only
  }
}

/** "Label · $price" for a market row. */
export function marketLabel(m) {
  return m?.price ? `${m.label} · ${m.price}` : (m?.label || m?.market_key || '');
}
