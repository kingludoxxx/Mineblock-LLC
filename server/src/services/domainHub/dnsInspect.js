// Domain Hub — DNS inspection. node:dns ONLY — we never HTTP-fetch a
// user-supplied host (SSRF hard rule). Every lookup goes through an
// injectable resolver seam so tests control the answers.
import dnsPromises from 'node:dns/promises';

// ── Resolver seam ───────────────────────────────────────────────────────────
// Shape: { resolveNs, resolveCname, resolve4, resolve6 } — each (name) →
// Promise<string[]>. Tests inject a fake; production uses node:dns/promises.
let resolver = dnsPromises;
export function setResolver(custom) {
  resolver = custom || dnsPromises;
}
export function resetResolver() {
  resolver = dnsPromises;
}

// Empty-answer errors are DATA (no records), not failures. Anything else
// (timeouts, SERVFAIL) propagates as null → "could not look up right now".
const EMPTY_CODES = new Set(['ENOTFOUND', 'ENODATA', 'ESERVFAIL_EMPTY']);
async function tryResolve(fn, name) {
  try {
    return await fn.call(resolver, name);
  } catch (err) {
    if (EMPTY_CODES.has(err.code)) return [];
    return null; // transient/lookup failure — caller treats as "unknown"
  }
}

// ── Registrable domain (eTLD+1, pragmatic) ──────────────────────────────────
// A full public-suffix list is overkill here; cover the common two-part
// public suffixes and document the residual: an exotic ccTLD second-level
// suffix may be mis-split, which only affects provider detection + the
// apex-vs-subdomain record recommendation, both operator-visible.
const TWO_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au',
  'co.nz', 'net.nz', 'org.nz',
  'com.br', 'com.mx', 'com.ar', 'com.co',
  'co.jp', 'ne.jp', 'or.jp',
  'co.in', 'net.in', 'org.in', 'co.za',
  'com.sg', 'com.hk', 'com.tw', 'com.cn',
  'co.kr', 'com.tr', 'com.ua', 'com.pl',
]);

export function registrableDomain(ascii) {
  const labels = ascii.split('.');
  if (labels.length <= 2) return ascii;
  const lastTwo = labels.slice(-2).join('.');
  if (TWO_PART_SUFFIXES.has(lastTwo)) return labels.slice(-3).join('.');
  return lastTwo;
}

export function isApex(ascii) {
  return ascii === registrableDomain(ascii);
}

// ── Provider detection (by NS of the registrable domain) ────────────────────
const NS_PROVIDERS = [
  { match: 'cloudflare.com', provider: 'cloudflare' },
  { match: 'registrar-servers.com', provider: 'namecheap' },
  { match: 'namecheaphosting.com', provider: 'namecheap' },
  { match: 'domaincontrol.com', provider: 'godaddy' },
  { match: 'awsdns', provider: 'route53' },
  { match: 'googledomains.com', provider: 'google' },
  { match: 'squarespacedns.com', provider: 'squarespace' },
  { match: 'wixdns.net', provider: 'wix' },
  { match: 'digitalocean.com', provider: 'digitalocean' },
  { match: 'vercel-dns.com', provider: 'vercel' },
  { match: 'nsone.net', provider: 'ns1' },
  { match: 'dnsimple.com', provider: 'dnsimple' },
  { match: 'porkbun.com', provider: 'porkbun' },
];

/** Detected DNS provider for a host, or 'unknown'; null = lookup failed. */
export async function detectProvider(ascii) {
  const ns = await tryResolve(resolver.resolveNs, registrableDomain(ascii));
  if (ns === null) return null;
  for (const record of ns) {
    const low = String(record).toLowerCase();
    for (const { match, provider } of NS_PROVIDERS) {
      if (low.includes(match)) return provider;
    }
  }
  return 'unknown';
}

// ── Required records (per Render custom-domain docs) ────────────────────────
// Subdomain (incl. www) → CNAME to the service host. Apex → A to Render's
// apex load-balancer IP (216.24.57.1 today; env-overridable because Render
// may change it), or ALIAS/ANAME to the service host where the DNS provider
// supports it (Cloudflare flattens CNAMEs at the apex natively).
export function renderTargetHost() {
  return String(process.env.RENDER_TARGET_HOST || 'puure-dashboard.onrender.com')
    .trim().toLowerCase();
}
export function renderApexIps() {
  const raw = String(process.env.RENDER_APEX_IPS || '216.24.57.1').trim();
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** The records the operator must create for `ascii` to point at us. */
export function requiredRecords(ascii) {
  const target = renderTargetHost();
  if (isApex(ascii)) {
    return [
      {
        type: 'A', name: '@', host: ascii, value: renderApexIps()[0],
        note: 'Apex record. If your DNS provider supports ALIAS/ANAME (or Cloudflare CNAME flattening), you may instead point the apex at ' + target + '.',
      },
      {
        type: 'CNAME', name: 'www', host: 'www.' + ascii, value: target,
        note: 'Recommended so www also reaches the funnel.',
      },
    ];
  }
  return [
    { type: 'CNAME', name: ascii.split('.')[0], host: ascii, value: target, note: 'Point this subdomain at the service.' },
  ];
}

/** What DNS currently answers for the host — CNAME chain + A/AAAA. Values
 *  are arrays; null means the lookup itself failed (unknown, retry later). */
export async function observeRecords(ascii) {
  const [cname, a, aaaa] = await Promise.all([
    tryResolve(resolver.resolveCname, ascii),
    tryResolve(resolver.resolve4, ascii),
    tryResolve(resolver.resolve6, ascii),
  ]);
  return { cname, a, aaaa };
}

/**
 * Is the host pointing at our Render service?
 *  • CNAME whose target is (or ends at) the service host, OR
 *  • an A record on one of Render's apex IPs.
 * Returns { pointing:boolean|null, observed } — null = lookups failed
 * (transient), which the sweep treats as "check again later", never an error.
 */
export async function isPointing(ascii) {
  const observed = await observeRecords(ascii);
  const target = renderTargetHost();
  const apexIps = new Set(renderApexIps());
  if (Array.isArray(observed.cname)) {
    for (const c of observed.cname) {
      const low = String(c).toLowerCase().replace(/\.$/, '');
      if (low === target) return { pointing: true, observed };
    }
  }
  if (Array.isArray(observed.a)) {
    for (const ip of observed.a) {
      if (apexIps.has(ip)) return { pointing: true, observed };
    }
  }
  if (observed.cname === null && observed.a === null) {
    return { pointing: null, observed }; // couldn't look anything up
  }
  return { pointing: false, observed };
}
