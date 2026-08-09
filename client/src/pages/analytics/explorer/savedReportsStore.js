/**
 * savedReportsStore — named explorer views persisted client-side.
 *
 * Storage: localStorage["puure.analytics.savedReports"] = JSON array of
 *   {id, name, state, saved_at}   where `state` is the explorer state blob, so
 *   loading one reproduces the view verbatim (mode, viz and filters included).
 *
 * EVERY read and write is guarded, and EVERY write reports whether it landed.
 * A corrupt blob, a full quota or private mode must read as "no saved reports"
 * — never as a crashed analytics tab, and never as a chip that looks saved and
 * is gone on reload.
 */
export const SAVED_REPORTS_KEY = 'puure.analytics.savedReports';

const MAX_NAME = 80;
/** A localStorage array is not a database; a runaway list is a bug, not a use. */
export const MAX_SAVED_REPORTS = 50;

function storage() {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    // Accessing localStorage itself throws under some privacy settings.
    return null;
  }
}

export function loadSavedReports() {
  const ls = storage();
  if (!ls) return [];
  try {
    const raw = ls.getItem(SAVED_REPORTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r) => r && typeof r === 'object'
      && typeof r.id === 'string' && r.id
      && typeof r.name === 'string' && r.name);
  } catch {
    return [];
  }
}

/**
 * Write the list, KEEPING THE NEWEST when it overflows.
 *
 * `slice(0, MAX)` kept the OLDEST and silently discarded the report the
 * operator had just saved — the save appeared to succeed and the chip was
 * missing on reload. Newest-wins is the only cap that matches what a save
 * means.
 */
function persist(list) {
  const ls = storage();
  if (!ls) return false;
  try {
    ls.setItem(SAVED_REPORTS_KEY, JSON.stringify(list.slice(-MAX_SAVED_REPORTS)));
    return true;
  } catch {
    return false;
  }
}

const newId = () =>
  `psr_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

/** Append one saved report; returns the entry, or null when storage refused. */
export function addSavedReport(name, state) {
  const entry = {
    id: newId(),
    name: String(name || 'Untitled report').slice(0, MAX_NAME),
    state,
    saved_at: new Date().toISOString(),
  };
  return persist([...loadSavedReports(), entry]) ? entry : null;
}

/**
 * @returns {{reports: object[], ok: boolean}} — `ok:false` means the list on
 * screen is NOT what is on disk, and the caller must say so.
 */
export function renameSavedReport(id, name) {
  const clean = String(name || '').trim().slice(0, MAX_NAME);
  const current = loadSavedReports();
  if (!clean) return { reports: current, ok: true };
  const next = current.map((r) => (r.id === id ? { ...r, name: clean } : r));
  const ok = persist(next);
  return { reports: ok ? next : current, ok };
}

/** @returns {{reports: object[], ok: boolean}} — same contract as rename. */
export function removeSavedReport(id) {
  const current = loadSavedReports();
  const next = current.filter((r) => r.id !== id);
  const ok = persist(next);
  return { reports: ok ? next : current, ok };
}
