// Add Product opens a draft; the product exists only after a real save, and races never duplicate it or lose an edit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDraftCreator } from '../../../client/src/lib/draftCreate.js';

const tick = () => new Promise((r) => setTimeout(r, 5));

test('D1: opening a draft writes NOTHING - the junk-row bug', async () => {
  let posts = 0;
  makeDraftCreator({ create: async () => { posts++; return { id: 'p1' }; } });
  await tick();
  assert.equal(posts, 0);
});

test('D2: the first save creates exactly once and carries its own edit', async () => {
  const bodies = [];
  const d = makeDraftCreator({ create: async (b) => { bodies.push(b); await tick(); return { id: 'p1' }; } });
  const r = await d.ensure({ name: 'Titan' });
  assert.deepEqual(r, { id: 'p1', created: true });
  assert.deepEqual(bodies, [{ name: 'Titan' }]);
  assert.deepEqual(await d.ensure({ price: '$99' }), { id: 'p1', created: false }, 'later saves update, never create');
});

test('D3: saves racing the first create share ONE create, and each waiter still writes its own edit', async () => {
  let posts = 0;
  const d = makeDraftCreator({ create: async () => { posts++; await tick(); return { id: 'p1' }; } });
  const [a, b, c] = await Promise.all([d.ensure({ name: 'x' }), d.ensure({ price: '1' }), d.ensure({ angles: [] })]);
  assert.equal(posts, 1, 'one product, not three');
  assert.equal(a.created, true, 'the initiator skips its second write');
  assert.equal(b.created, false, 'a waiter must still write its edit - the first draft of this code dropped it');
  assert.equal(c.created, false);
});

test('D4: a failed create does not wedge the draft - the next save retries it', async () => {
  let n = 0;
  const d = makeDraftCreator({ create: async () => { n++; if (n === 1) throw new Error('503'); return { id: 'p2' }; } });
  await assert.rejects(d.ensure({ name: 'x' }), /503/);
  assert.deepEqual(await d.ensure({ name: 'x' }), { id: 'p2', created: true });
});

test('D5: an existing product never creates; reset forgets the draft', async () => {
  let posts = 0;
  const d = makeDraftCreator({ create: async () => { posts++; return { id: 'new' }; }, initialId: 'p9' });
  assert.deepEqual(await d.ensure({ name: 'y' }), { id: 'p9', created: false });
  d.reset();
  assert.equal(d.id, null);
  assert.equal(posts, 0);
});

test('D6: a create that answers without an id is an error, never a silent id-less product', async () => {
  const d = makeDraftCreator({ create: async () => ({}) });
  await assert.rejects(d.ensure({ name: 'z' }), /no id/);
});
