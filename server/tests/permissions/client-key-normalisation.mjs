// REVIEW-W8 P1-2 — the client's permission matcher normalises keys exactly like the server's rbac.js.
import { rolesGrant, toKebab } from '../../../client/src/utils/permissions.js';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m); } };
const camel = [{ name: 'Custom - Test User', permissions: { briefAgent: ['access'], kpiSystem: ['access'] } }];
const kebab = [{ name: 'Team', permissions: { 'brief-agent': ['access'] } }];
ok(rolesGrant(camel, 'brief-agent:access') === true, 'P1-2 a camelCase stored key grants the kebab-case route key (server parity)');
ok(rolesGrant(camel, 'kpi-system:access') === true, 'P1-2 kpiSystem grants kpi-system:access');
ok(rolesGrant(kebab, 'brief-agent:access') === true, 'kebab stored key still grants (positive control)');
ok(rolesGrant(kebab, 'orders:access') === false, 'an unrelated key does not grant (negative control)');
ok(rolesGrant([{ permissions: '{"briefAgent":["*"]}' }], 'brief-agent:access') === true, 'JSONB-as-string with a wildcard action grants');
ok(rolesGrant([{ permissions: { '*': ['*'] } }], 'anything:access') === true, 'the global wildcard grants');
ok(rolesGrant(undefined, 'x:y') === false && rolesGrant(camel, 'nocolon') === false, 'malformed input never grants');
ok(toKebab('briefAgent') === 'brief-agent' && toKebab('kpi-system') === 'kpi-system', 'toKebab matches rbac.js');
// REVIEW-W8C P1-B: the matcher being right proves nothing if the HOOK does not use it. Pin the hook to the
// shared function at the source level (the hook is React and has no node harness): it must import rolesGrant
// and must not carry a raw-key compare of its own.
import { readFileSync } from 'node:fs';
const hook = readFileSync(new URL('../../../client/src/hooks/usePermissions.js', import.meta.url), 'utf8');
ok(/import \{ rolesGrant \} from '\.\.\/utils\/permissions'/.test(hook) && /rolesGrant\(user\?\.roles, permission\)/.test(hook),
  'P1-B usePermissions delegates to the shared matcher (source pin)');
ok(!/perms\[resource\]/.test(hook), 'P1-B the hook carries no raw-key compare of its own');
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
