// The Facebook page belongs to the copy, not the template (Ludo 2026-09-13). A doctor's script must run from the
// doctor's page even when the template names the brand page. A copy set without a page keeps the template's pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pagesForLaunch } from '../../src/utils/launchPages.js';

const template = { page_ids: JSON.stringify([{ id: '111', name: 'Brand', selected: true }, { id: '222', name: 'Other', selected: false }, { id: '333', name: 'Third' }]) };

test('P1: a copy set that names a page launches only from that page', () => {
  assert.deepEqual(pagesForLaunch(template, { page_id: '1240363085824193', page_name: 'Dr Rachel Cole' }), [{ id: '1240363085824193', name: 'Dr Rachel Cole' }]);
});

test('P2: no copy set, or a copy set without a page, keeps the template selection (unselected pages excluded)', () => {
  const expect = [{ id: '111', name: 'Brand', selected: true }, { id: '333', name: 'Third' }];
  assert.deepEqual(pagesForLaunch(template, null), expect);
  assert.deepEqual(pagesForLaunch(template, { page_id: '' }), expect);
  assert.deepEqual(pagesForLaunch(template, { page_id: null }), expect);
});

test('P3: a malformed page id on the copy set is refused, not sent to Meta', () => {
  assert.throws(() => pagesForLaunch(template, { page_id: 'not-a-page' }), /page id/);
});

test('P4: every launch path reads the page through pagesForLaunch, and copy sets store page_id + page_name', () => {
  const sg = fs.readFileSync(new URL('../../src/routes/staticsGeneration.js', import.meta.url), 'utf8');
  const bp = fs.readFileSync(new URL('../../src/routes/briefPipeline.js', import.meta.url), 'utf8');
  assert.ok(!/const selectedPages = safeArr\(template\.page_ids\)/.test(sg + bp), 'no launch path picks pages from the template directly');
  assert.ok((sg.match(/pagesForLaunch\(template, copySet\)/g) || []).length >= 1, 'statics launch');
  assert.ok((bp.match(/pagesForLaunch\(template, copySet\)/g) || []).length >= 1, 'brief pipeline launch');
  assert.match(bp, /ALTER TABLE brief_copy_sets ADD COLUMN IF NOT EXISTS page_id TEXT/);
  assert.match(bp, /INSERT INTO brief_copy_sets \(product_id, angle, primary_texts, headlines, descriptions, cta_button, landing_page_url, utm_parameters, created_by, page_id, page_name\)/);
});
