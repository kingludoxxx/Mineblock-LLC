// A product field saves when the operator leaves it (golden path, found live 2026-09-13 on a new store).
// Typing a name and clicking the next field sent NO request: every keystroke updates the parent product, the parent
// hands that same value back as the field's `value`, and the field treated its own echo as "changed from outside"
// and cleared its unsaved flag - so the blur that followed saved nothing. Only the Save button ever saved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFieldState } from '../../../client/src/lib/autoSaveField.js';

test('A1: type, the parent echoes each keystroke back, then leave the field -> one save with the typed value', () => {
  const f = makeFieldState('');
  for (const v of ['R', 'Re', 'Reevo']) { f.change(v); f.external(v); }   // the echo, exactly as the page does it
  assert.deepEqual(f.blur(), { save: true, value: 'Reevo' });
  assert.deepEqual(f.blur(), { save: false }, 'leaving again without typing saves nothing');
});

test('A2: a real outside change (AI fill, another product opened) replaces the text and discards the unsaved flag', () => {
  const f = makeFieldState('old');
  f.change('half typed');
  assert.equal(f.external('filled by AI'), 'filled by AI', 'the field shows the outside value');
  assert.deepEqual(f.blur(), { save: false }, 'the outside value is not re-saved as if the operator typed it');
});

test('A3: focus and leave without typing never saves; null and undefined read as empty', () => {
  const f = makeFieldState(null);
  assert.equal(f.value, '');
  assert.equal(f.external(undefined), null, 'no visible change -> nothing to re-render');
  assert.deepEqual(f.blur(), { save: false });
});

test('A4: typing back to the original text still saves (the operator touched it; the server may differ)', () => {
  const f = makeFieldState('abc');
  f.change('abcd'); f.external('abcd'); f.change('abc'); f.external('abc');
  assert.deepEqual(f.blur(), { save: true, value: 'abc' });
});
