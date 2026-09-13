// The Statics page fires 12 requests at once through ONE pool that allowed 10 (measured live 2026-09-13).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://nobody@127.0.0.1:1/never';
const { poolMax } = await import('../../src/db/pg.js');

test('P1: the default admits the Statics page burst (12) with headroom', () => {
  assert.equal(poolMax(undefined), 20);
  assert.ok(poolMax(undefined) > 12, 'must exceed the measured 12 concurrent requests');
});

test('P2: a configured value is honoured', () => {
  assert.equal(poolMax('25'), 25);
  assert.equal(poolMax(' 15 '), 15);
});

test('P3: nonsense falls back to the default and extremes are clamped', () => {
  for (const v of ['', 'abc', null, 'NaN']) assert.equal(poolMax(v), 20, JSON.stringify(v));
  assert.equal(poolMax('1'), 5, 'never starve the page');
  assert.equal(poolMax('0'), 5);
  assert.equal(poolMax('500'), 40, 'never exhaust the database');
});
