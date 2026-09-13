// The unsaved-changes state of one auto-saving field (tested in server/tests/product-library/autosave-field.test.mjs).
//
// The field saves when the operator leaves it. Its parent re-renders it with the product's value on every keystroke,
// so the field must tell its OWN echo apart from a real outside change: an echo equals what the field already shows
// and changes nothing; only a different value (AI fill, another product opened) replaces the text and drops the
// unsaved flag. Treating the echo as outside is how blur-save silently did nothing (2026-09-13).
export function makeFieldState(initial) {
  let value = initial ?? '';
  let dirty = false;
  return {
    get value() { return value; },
    /** The operator typed. */
    change(next) { value = next ?? ''; dirty = true; },
    /** The parent handed a value in. Returns the value to show when it differs from what is shown, else null. */
    external(next) {
      const v = next ?? '';
      if (v === value) return null;
      value = v;
      dirty = false;
      return v;
    },
    /** The operator left the field. */
    blur() {
      if (!dirty) return { save: false };
      dirty = false;
      return { save: true, value };
    },
  };
}
