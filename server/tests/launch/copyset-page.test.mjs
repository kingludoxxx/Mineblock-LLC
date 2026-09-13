// The Facebook page belongs to the copy set, never the template (Ludo 2026-09-13, template page removed 2026-09-14).
// A statics or brief-pipeline launch runs from the copy set's page and is refused without one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pagesForLaunch } from '../../src/utils/launchPages.js';

test('P1: a copy set that names a page launches only from that page', () => {
  assert.deepEqual(pagesForLaunch({ page_id: '1240363085824193', page_name: 'Dr Rachel Cole' }), [{ id: '1240363085824193', name: 'Dr Rachel Cole' }]);
});

test('P2: no copy set, or a copy set without a page, is refused whatever the template holds', () => {
  assert.throws(() => pagesForLaunch(null), /Choose a copy set/);
  assert.throws(() => pagesForLaunch({ angle: 'SA-C7', page_id: '' }), /"SA-C7" has no Facebook page/);
  assert.throws(() => pagesForLaunch({ angle: 'SA-C7', page_id: null }), /has no Facebook page/);
});

test('P3: a malformed page id on the copy set is refused, not sent to Meta', () => {
  assert.throws(() => pagesForLaunch({ page_id: 'not-a-page' }), /page id/);
});

test('P4: both launch paths read the page only through the copy set; the template editor has no page picker', () => {
  const sg = fs.readFileSync(new URL('../../src/routes/staticsGeneration.js', import.meta.url), 'utf8');
  const bp = fs.readFileSync(new URL('../../src/routes/briefPipeline.js', import.meta.url), 'utf8');
  const ed = fs.readFileSync(new URL('../../../client/src/pages/production/briefs/LaunchTemplateEditor.jsx', import.meta.url), 'utf8');
  assert.ok(!/pagesForLaunch\(template/.test(sg + bp), 'no launch path passes the template');
  assert.ok((sg.match(/pagesForLaunch\(copySet\)/g) || []).length >= 1, 'statics launch');
  assert.ok((bp.match(/pagesForLaunch\(copySet\)/g) || []).length >= 1, 'brief pipeline launch');
  assert.ok(!/name="fb-page"/.test(ed), 'template editor page picker removed');
  assert.ok(!/at least one Facebook Page/i.test(ed), 'template save no longer requires a page');
  assert.match(bp, /ALTER TABLE brief_copy_sets ADD COLUMN IF NOT EXISTS page_id TEXT/);
});
