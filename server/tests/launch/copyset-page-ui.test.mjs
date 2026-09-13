// The copy-set editor shows and changes the Facebook page each copy runs from (Ludo 2026-09-13).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLaunchPages, pageOptions, pageFields } from '../../../client/src/lib/copySetPages.js';

const PAGES = {
  act_1: [{ id: '1240363085824193', name: 'Dr Rachel Cole' }, { id: '1278136488723717', name: 'Reevo Health' }],
  act_2: [{ id: '1278136488723717', name: 'Reevo Health' }, { id: '1300489003153524', name: 'Better Health Daily Reviews' }],
};
const fakeGet = (fail) => async (url) => {
  if (url === '/ad-launcher/meta/accounts') return { data: { data: [{ id: 'act_1' }, { account_id: '2' }] } };
  const acc = decodeURIComponent(url.split('/').pop());
  if (fail === acc) throw new Error('Meta down');
  return { data: { data: PAGES[acc] || [] } };
};

test('U1: pages of every ad account, each page once', async () => {
  const pages = await loadLaunchPages(fakeGet());
  assert.deepEqual(pages.map((p) => p.name), ['Dr Rachel Cole', 'Reevo Health', 'Better Health Daily Reviews']);
});

test('U2: a failing account is reported, never a silently short list', async () => {
  await assert.rejects(() => loadLaunchPages(fakeGet('act_2')), /Meta down/);
});

test('U3: a saved page missing from the list stays visible and selected', () => {
  const opts = pageOptions(PAGES.act_1, { page_id: '999999', page_name: 'Old Page' });
  assert.deepEqual(opts.at(-1), { id: '999999', name: 'Old Page (not in the ad account)' });
  assert.equal(pageOptions(PAGES.act_1, { page_id: '1240363085824193' }).length, 2);
  assert.equal(pageOptions(PAGES.act_1, { page_id: '' }).length, 2);
});

test('U4: the save carries page_id always (empty clears it) and the name of the chosen page', () => {
  assert.deepEqual(pageFields(PAGES.act_1, '1278136488723717', {}), { page_id: '1278136488723717', page_name: 'Reevo Health' });
  assert.deepEqual(pageFields(PAGES.act_1, '', { page_id: '1', page_name: 'x' }), { page_id: '', page_name: '' });
  assert.deepEqual(pageFields([], '999999', { page_id: '999999', page_name: 'Old Page' }), { page_id: '999999', page_name: 'Old Page' });
});
