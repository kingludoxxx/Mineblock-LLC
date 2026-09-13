// A store's own statics prompts (system_settings 'statics_prompts' in THAT store's database). Code only supplies
// defaults for prompts a store has not saved; it never overrides one the store has (tests/statics/store-prompts).

const parse = (row) => {
  if (typeof row === 'string') { try { return JSON.parse(row); } catch { return null; } }
  return row && typeof row === 'object' ? row : null;
};
const usable = (v) => typeof v === 'string' && v.trim() !== '';

/** Every prompt the pipeline needs: the store's where it has one, otherwise the default. */
export function resolveStorePrompts(row, defaults, keys) {
  const stored = parse(row) || {};
  return Object.fromEntries(keys.map((k) => [k, usable(stored[k]) ? stored[k] : defaults[k]]));
}

/** What a save writes: every known prompt, each required. */
export function promptsToSave(incoming, keys) {
  const out = {};
  for (const k of keys) {
    if (!usable(incoming?.[k])) throw new Error(`Missing or empty prompt: ${k}`);
    out[k] = incoming[k];
  }
  return out;
}

/** At boot: add prompts a store's row lacks (new prompt types), never touch one it has. No row: nothing written. */
export function bootPromptRepair(row, defaults, keys) {
  const stored = parse(row);
  if (!stored) return { write: false, value: null, added: [] };
  const added = keys.filter((k) => !usable(stored[k]));
  if (!added.length) return { write: false, value: stored, added };
  return { write: true, value: { ...stored, ...Object.fromEntries(added.map((k) => [k, defaults[k]])) }, added };
}
