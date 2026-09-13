// requireRole must let a FULL-ACCESS role through, whatever it is named - and nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireRole } from '../src/middleware/rbac.js';

function run(roles, names = ['SuperAdmin', 'Admin']) {
  let status = 200, nexted = false;
  const res = { status(c) { status = c; return this; }, json() { return this; } };
  requireRole(...names)({ user: { roles } }, res, () => { nexted = true; });
  return nexted ? 200 : status;
}

test('W1: the hub owner (wildcard, any name) passes Team/Roles gates - the live 403', () => {
  assert.equal(run([{ name: 'Hub Owner', permissions: { '*': ['*'] } }]), 200);
  assert.equal(run([{ name: 'Hub Owner', permissions: '{"*":["*"]}' }]), 200, 'JSON-string form');
});

test('W2: names still work exactly as before', () => {
  assert.equal(run([{ name: 'SuperAdmin', permissions: {} }]), 200);
  assert.equal(run([{ name: 'Admin', permissions: {} }]), 200);
});

test('W3: nothing short of the FULL wildcard gets through', () => {
  for (const permissions of [
    {}, { users: ['read'] }, { '*': ['read'] }, { '*': [] }, { team: ['*'] }, '{"*":["read"]}', 'not json', null,
  ]) assert.equal(run([{ name: 'Team - Full Access', permissions }]), 403, JSON.stringify(permissions));
});

test('W4: no user / no roles is still refused', () => {
  let status = 0;
  const res = { status(c) { status = c; return this; }, json() { return this; } };
  requireRole('SuperAdmin')({}, res, () => { status = 200; });
  assert.equal(status, 401);
  assert.equal(run([]), 403);
});
