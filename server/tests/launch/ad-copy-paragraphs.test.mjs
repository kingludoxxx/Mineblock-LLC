// Ludo 2026-09-14: long ad copy needs a blank line after every paragraph to read in feed. Every launch path formats
// each primary text before it reaches Meta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { formatParagraphs, formatPrimaryTexts } from '../../src/utils/adCopy.js';

test('A1: every paragraph is followed by a blank line; extra blank lines collapse; ends trimmed', () => {
  assert.equal(formatParagraphs('One.\nTwo.\n\n\n\nThree.\r\n✅ Four\n  \n'), 'One.\n\nTwo.\n\nThree.\n\n✅ Four');
  assert.equal(formatParagraphs('Already.\n\nSpaced.'), 'Already.\n\nSpaced.');
  assert.equal(formatParagraphs(null), '');
});

test('A2: a list of primary texts is formatted and emptied entries dropped', () => {
  assert.deepEqual(formatPrimaryTexts(['A.\nB.', '  ', 'C.']), ['A.\n\nB.', 'C.']);
});

test('A3: statics and brief-pipeline launches format the primary texts they send', () => {
  const sg = fs.readFileSync(new URL('../../src/routes/staticsGeneration.js', import.meta.url), 'utf8');
  const bp = fs.readFileSync(new URL('../../src/routes/briefPipeline.js', import.meta.url), 'utf8');
  assert.match(sg, /const primaryTexts = formatPrimaryTexts\(/);
  assert.match(bp, /formatPrimaryTexts\(/);
});
