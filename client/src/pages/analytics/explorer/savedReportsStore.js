/**
 * savedReports — named explorer views persisted client-side.
 *
 * Storage: localStorage["puure.analytics.savedReports"] = JSON array of
 *   {id, name, state, saved_at}   where `state` is the explorer state blob, so
 *   loading one reproduces the view verbatim (mode, viz and filters included).
 *
 * EVERY read and write is guarded. A corrupt blob, a full quota or private
 * mode must read as "no saved reports" — never as a crashed analytics tab.
 * The store is kept out of the component so the harness can exercise it and so
 * a save from the controls row and the chip row agree on one shape.
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

function persist(list) {
  const ls = storage();
  if (!ls) return false;
  try {
    ls.setItem(SAVED_REPORTS_KEY, JSON.stringify(list.slice(0, MAX_SAVED_REPORTS)));
    return true;
  } catch {
    // Quota exceeded / private mode — saving is best-effort, and the caller
    // is told so it can say so rather than showing a phantom chip.
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
  const next = [...loadSavedReports(), entry];
  return persist(next) ? entry : null;
}

export function renameSavedReport(id, name) {
  const clean = String(name || '').trim().slice(0, MAX_NAME);
  if (!clean) return loadSavedReports();
  const next = loadSavedReports().map((r) => (r.id === id ? { ...r, name: clean } : r));
  persist(next);
  return next;
}

export function removeSavedReport(id) {
  const next = loadSavedReports().filter((r) => r.id !== id);
  persist(next);
  return next;
}
