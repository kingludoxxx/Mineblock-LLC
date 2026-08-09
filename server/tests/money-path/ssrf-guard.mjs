// SSRF regression for the operator-supplied CAPI endpoint (DECISION #12:
// re-validate at SEND time, and a scheme check is not validation).
import { endpointAllowed } from '../../src/services/trackingDelivery.js';
let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log('PASS ', m); } else { fail++; console.log('FAIL ', m, x); } };
const BLOCK = [
  ['https://169.254.169.254/latest/meta-data/', 'cloud metadata (link-local)'],
  ['https://metadata.google.internal/computeMetadata/v1/', 'GCP metadata hostname'],
  ['https://127.0.0.1/x', 'loopback v4'],
  ['https://[::1]/x', 'loopback v6'],
  ['https://10.1.2.3/x', 'private 10/8'],
  ['https://172.16.5.5/x', 'private 172.16/12'],
  ['https://192.168.1.1/x', 'private 192.168/16'],
  ['https://100.64.0.1/x', 'CGNAT 100.64/10'],
  ['https://[::ffff:169.254.169.254]/x', 'IPv4-mapped metadata'],
  ['https://localhost/x', 'localhost by name'],
  ['http://example.com/x', 'plaintext http in prod'],
  ['ftp://example.com/x', 'non-http scheme'],
  ['not a url', 'garbage'],
];
process.env.NODE_ENV = 'production';
for (const [url, label] of BLOCK) {
  const r = await endpointAllowed(url);
  ok(r !== true, `BLOCKED: ${label}`, `got ${JSON.stringify(r)} for ${url}`);
}
const pub = await endpointAllowed('https://graph.facebook.com/v19.0/1/events');
ok(pub === true, 'ALLOWED: a real public https endpoint', JSON.stringify(pub));
const dnsFail = await endpointAllowed('https://this-host-does-not-exist-xyzzy-4821.invalid/x');
ok(dnsFail === 'dns_resolution_failed', 'DNS failure is TRANSIENT (re-queues, not dead-lettered)', String(dnsFail));
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
