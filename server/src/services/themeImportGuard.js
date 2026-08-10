// THEME IMPORT SSRF GUARD — resolve-once, pin-the-IP, connect-to-the-pin.
//
// import-url fetches an OPERATOR-SUPPLIED page. The tracking lane's
// endpointAllowed is a good validator but the WRONG shape for this: it does its
// own dns.lookup, returns a verdict, and then the caller's fetch() resolves the
// hostname a SECOND time. Those two resolutions are a TOCTOU window — a DNS
// server the attacker controls can answer public to the guard and 127.0.0.1 to
// the connect (classic DNS rebinding), and the reviewer walked exactly that
// path to read back an internal page's palette. endpointAllowed also has a
// dev-mode loopback hatch that belongs to the postback caller, not here.
//
// This guard closes the window structurally: it resolves the hostname EXACTLY
// ONCE, validates every answer, and then hands the connection a `lookup` that
// returns the already-validated literal IP. There is no second resolution for
// an attacker to poison — the socket connects to the byte the guard blessed.
//
// It also decodes the two IPv6 tunnels endpointAllowed misses (M5): the NAT64
// well-known prefix 64:ff9b::/96 and 6to4 2002::/16 both embed an IPv4 address,
// so [64:ff9b::a9fe:a9fe] and [2002:a9fe:a9fe::] are two more spellings of
// 169.254.169.254 and must be gated on the embedded v4.
import dns from 'node:dns';
import net from 'node:net';
import https from 'node:https';

export class ImportGuardError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// ── IPv4 classification ─────────────────────────────────────────────────────
// Public unicast only. Everything private / loopback / link-local / CGNAT /
// multicast / reserved / broadcast is refused.
export function isPublicIPv4(a, b, c, d) {
  for (const o of [a, b, c, d]) if (!Number.isInteger(o) || o < 0 || o > 255) return false;
  if (a === 0) return false;                         // 0.0.0.0/8 unspecified
  if (a === 10) return false;                        // private
  if (a === 127) return false;                       // loopback
  if (a === 169 && b === 254) return false;          // link-local (cloud metadata 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false;          // private
  if (a === 100 && b >= 64 && b <= 127) return false;// CGNAT (100.64/10)
  if (a === 192 && b === 0 && c === 0) return false; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return false; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false;  // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false;   // TEST-NET-3
  if (a >= 224) return false;                        // 224/4 multicast + 240/4 reserved + 255.255.255.255
  return true;
}

// Expand any valid IPv6 string to its 8 hextets (numbers). Returns null on junk.
export function expandIPv6(addr) {
  if (typeof addr !== 'string') return null;
  let s = addr.trim();
  // A zone id (fe80::1%en0) is never a public target; strip it and let the
  // prefix checks below refuse it.
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  if (net.isIPv6(s) !== true) return null;

  // Handle an embedded dotted-quad tail (e.g. ::ffff:1.2.3.4).
  let tailHextets = [];
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const q = tail.split('.').map((n) => parseInt(n, 10));
    if (q.length !== 4 || q.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    tailHextets = [(q[0] << 8) | q[1], (q[2] << 8) | q[3]];
    s = s.slice(0, lastColon + 1) + '0:0';
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':').filter((x) => x !== '') : [];
  const rear = halves.length === 2 ? (halves[1] ? halves[1].split(':').filter((x) => x !== '') : []) : null;

  let hextets;
  if (rear === null) {
    hextets = head;
  } else {
    const missing = 8 - (head.length + rear.length);
    if (missing < 0) return null;
    hextets = [...head, ...Array(missing).fill('0'), ...rear];
  }
  // If we substituted a dotted tail above, the two synthetic '0' hextets get
  // replaced by the real embedded v4 words.
  const nums = hextets.map((h) => parseInt(h, 16));
  if (tailHextets.length === 2) { nums[6] = tailHextets[0]; nums[7] = tailHextets[1]; }
  if (nums.length !== 8 || nums.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
  return nums;
}

export function isPublicIPv6(addr) {
  const h = expandIPv6(addr);
  if (!h) return false;

  const allZeroLead = h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0;
  // ::1 loopback, :: unspecified
  if (allZeroLead && h[5] === 0 && h[6] === 0 && (h[7] === 0 || h[7] === 1)) return false;
  // ::ffff:v4 (IPv4-mapped) — judge the embedded v4
  if (allZeroLead && h[5] === 0xffff) {
    return isPublicIPv4((h[6] >> 8) & 0xff, h[6] & 0xff, (h[7] >> 8) & 0xff, h[7] & 0xff);
  }
  // NAT64 well-known prefix 64:ff9b::/96 — the last 32 bits are the real v4
  if (h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
    return isPublicIPv4((h[6] >> 8) & 0xff, h[6] & 0xff, (h[7] >> 8) & 0xff, h[7] & 0xff);
  }
  // 6to4 2002::/16 — bits 16..48 embed the v4
  if (h[0] === 0x2002) {
    return isPublicIPv4((h[1] >> 8) & 0xff, h[1] & 0xff, (h[2] >> 8) & 0xff, h[2] & 0xff);
  }
  // link-local fe80::/10
  if ((h[0] & 0xffc0) === 0xfe80) return false;
  // unique-local fc00::/7
  if ((h[0] & 0xfe00) === 0xfc00) return false;
  // multicast ff00::/8
  if ((h[0] & 0xff00) === 0xff00) return false;
  return true;
}

// One classifier for a literal address of either family.
export function classifyAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c, d] = ip.split('.').map((n) => parseInt(n, 10));
    return { public: isPublicIPv4(a, b, c, d) };
  }
  if (net.isIPv6(ip)) return { public: isPublicIPv6(ip) };
  return { public: false };
}

// Default single-shot resolver. Verbatim so we see the same order the OS would
// connect in; { all: true } so a mixed public/private answer set is caught.
const defaultResolve = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

// Resolve a hostname ONCE and decide. A literal IP is classified directly (no
// DNS at all). STRICT: if the name resolves to a set with ANY non-public
// answer, the whole host is refused — a host that answers both a public A and a
// private A is a rebinding setup, not a legitimate target.
//
// `resolve` is injectable for the harness so the rebinding property can be
// proven without a hostile DNS server.
export async function assessHostname(host, { resolve = defaultResolve } = {}) {
  const clean = String(host || '').replace(/^\[|\]$/g, '');
  if (!clean) return { allowed: false, reason: 'empty' };
  if (net.isIP(clean)) {
    return classifyAddress(clean).public
      ? { allowed: true, pinnedIp: clean }
      : { allowed: false, reason: 'private' };
  }
  let answers;
  try { answers = await resolve(clean); } catch { return { allowed: false, reason: 'dns' }; }
  if (!Array.isArray(answers) || answers.length === 0) return { allowed: false, reason: 'dns' };
  if (!answers.every((a) => classifyAddress(a.address).public)) return { allowed: false, reason: 'private' };
  return { allowed: true, pinnedIp: answers[0].address };
}

// ── the pinned fetch ────────────────────────────────────────────────────────
// https only. Resolves once via assessHostname, then connects with a `lookup`
// that returns the PINNED literal — so net/tls never re-resolve. Redirects are
// REFUSED, not followed (a 302 from a validated host to an unvalidated one is
// the reference's actual hole). Body is read under a hard byte cap.
//
// Returns { status, headers, body, truncated }. Throws ImportGuardError with a
// coarse code ('scheme' | 'blocked' | 'redirect' | 'timeout' | 'fetch') — the
// route maps every one to a fixed client message, so nothing about the internal
// network leaks back (the reference returns str(exc), a blind-SSRF oracle).
export async function safeFetchHtml(rawUrl, opts = {}) {
  const {
    maxBytes = 2 * 1024 * 1024,
    timeoutMs = 15_000,
    resolve = defaultResolve,
    userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  } = opts;

  let u;
  try { u = new URL(rawUrl); } catch { throw new ImportGuardError('scheme'); }
  if (u.protocol !== 'https:') throw new ImportGuardError('scheme');

  const host = u.hostname.replace(/^\[|\]$/g, '');
  const assessment = await assessHostname(host, { resolve });
  if (!assessment.allowed) throw new ImportGuardError('blocked');
  const pinnedIp = assessment.pinnedIp;
  const family = net.isIPv6(pinnedIp) ? 6 : 4;

  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

    const req = https.request(
      {
        protocol: 'https:',
        hostname: host,          // drives TLS SNI + certificate validation
        servername: host,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers: {
          Host: u.host,
          'User-Agent': userAgent,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Encoding': 'identity',
        },
        // THE PIN. net.connect calls this instead of resolving `host`; we hand
        // back the byte assessHostname already validated. One resolution total.
        lookup: (_h, _o, cb) => cb(null, pinnedIp, family),
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400) { res.destroy(); return done(reject, new ImportGuardError('redirect')); }
        const ctype = String(res.headers['content-type'] || '');
        if (ctype && !/text\/html|application\/xhtml|text\/plain/i.test(ctype)) {
          res.destroy();
          return done(reject, new ImportGuardError('not_html'));
        }
        const chunks = [];
        let total = 0;
        let truncated = false;
        res.on('data', (chunk) => {
          total += chunk.length;
          if (total > maxBytes) {
            truncated = true;
            chunks.push(chunk);
            res.destroy();               // stop reading; we have enough
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => done(resolvePromise, {
          status,
          headers: res.headers,
          body: Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8'),
          truncated,
        }));
        res.on('close', () => {
          // A cap-triggered destroy resolves with what we captured rather than
          // erroring — the <head> we need is at the top of the document.
          if (truncated) {
            done(resolvePromise, {
              status,
              headers: res.headers,
              body: Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8'),
              truncated: true,
            });
          }
        });
        res.on('error', () => done(reject, new ImportGuardError('fetch')));
      },
    );

    req.on('timeout', () => { req.destroy(); done(reject, new ImportGuardError('timeout')); });
    req.on('error', () => done(reject, new ImportGuardError('fetch')));
    req.end();
  });
}

export default { safeFetchHtml, assessHostname, classifyAddress, isPublicIPv4, isPublicIPv6, ImportGuardError };
