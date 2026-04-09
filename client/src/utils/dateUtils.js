// Local-date helpers — avoid `toISOString()` for date-only formatting because
// it returns UTC, which shifts the date by one day in positive-UTC-offset
// timezones (e.g. Europe/Berlin shows yesterday for the user's "today").

export function toLocalDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function todayLocalStr() {
  return toLocalDateStr(new Date());
}
