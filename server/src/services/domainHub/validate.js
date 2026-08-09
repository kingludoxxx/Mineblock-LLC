// Domain Hub — domain-string validation. Everything user-supplied passes
// through normalizeDomain() BEFORE any DB write, DNS lookup, or API call.
//
// Threat model:
//  • injection via the domain string → after normalization the ASCII form is
//    strictly [a-z0-9.-]; anything else is rejected (SQL is parameterized
//    anyway — this also keeps the string safe for DNS, headers, and APIs).
//  • SSRF bait → IPs, localhost, and our own infrastructure hosts are
//    rejected; lookups elsewhere in the module use node:dns ONLY (never an
//    HTTP fetch of the attacker's host).
//  • punycode homoglyphs → a label whose Unicode form mixes confusable
//    scripts (Latin + Cyrillic/Greek) is rejected outright.
import { domainToASCII, domainToUnicode } from 'node:url';

// Hosts that are OURS (or our platform's) — attaching them would let a funnel
// shadow the dashboard or another product. Suffix-matched against the ASCII
// form. Extendable without a deploy via DOMAIN_HUB_BLOCKED_SUFFIXES (csv).
const BLOCKED_SUFFIXES = [
  'onrender.com',
  'render.com',
  'trypuure.co',
  'trypuure.com',
  'puure.co',
  'puure.com',
  'mineblock.com',
  'mineblockllc.com',
  'localhost',
  'local',
  'internal',
  'test',
  'invalid',
  'example.com',
  'example.net',
  'example.org',
];

function envBlockedSuffixes() {
  return String(process.env.DOMAIN_HUB_BLOCKED_SUFFIXES || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// The host we tell operators to CNAME to must never itself be attachable.
function targetHost() {
  return String(process.env.RENDER_TARGET_HOST || 'puure-dashboard.onrender.com')
    .trim()
    .toLowerCase();
}

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

// Script ranges for the homoglyph check (letters only; digits/hyphen neutral).
function scriptOf(cp) {
  if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) return 'latin';
  if (cp >= 0xc0 && cp <= 0x24f) return 'latin'; // Latin-1 Sup + Extended A/B
  if (cp >= 0x370 && cp <= 0x3ff) return 'greek';
  if (cp >= 0x400 && cp <= 0x4ff) return 'cyrillic';
  return null; // other scripts (CJK, Arabic…) don't mix with Latin lookalikes
}

/** True when a Unicode label mixes Latin with Cyrillic/Greek — the classic
 *  paypаl.com homoglyph shape. Single-script IDN labels pass. */
export function isMixedScriptLabel(unicodeLabel) {
  const seen = new Set();
  for (const ch of unicodeLabel) {
    const s = scriptOf(ch.codePointAt(0));
    if (s) seen.add(s);
    if (seen.size > 1) return true;
  }
  return false;
}

/**
 * Normalize + validate a user-supplied domain.
 * @returns {{ok:true, domain:string, unicode:string} | {ok:false, error:string}}
 * `domain` is the canonical ASCII (punycode) form, lowercased, no trailing dot.
 */
export function normalizeDomain(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'domain_required' };
  let d = raw.trim().toLowerCase();
  if (!d) return { ok: false, error: 'domain_required' };
  // Strip an accidental scheme / path / port — operators paste URLs.
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  d = d.split('/')[0].split('?')[0].split('#')[0];
  if (d.includes('@')) return { ok: false, error: 'domain_invalid' }; // userinfo trick
  d = d.split(':')[0];
  d = d.replace(/\.+$/, ''); // trailing dot(s)
  if (!d) return { ok: false, error: 'domain_required' };
  if (d.length > 253) return { ok: false, error: 'domain_too_long' };

  // IP literals are never domains here.
  if (IPV4_RE.test(d) || d.includes('[') || /^[0-9a-f:]+$/i.test(d) && d.includes(':')) {
    return { ok: false, error: 'ip_not_allowed' };
  }

  // Punycode canonicalization. domainToASCII('') on garbage returns ''.
  const ascii = domainToASCII(d);
  if (!ascii) return { ok: false, error: 'domain_invalid' };
  if (ascii.length > 253) return { ok: false, error: 'domain_too_long' };

  const labels = ascii.split('.');
  if (labels.length < 2) return { ok: false, error: 'domain_needs_tld' };
  for (const label of labels) {
    if (!label || label.length > 63 || !LABEL_RE.test(label)) {
      return { ok: false, error: 'domain_invalid' };
    }
  }
  // TLD must not be all-numeric.
  if (/^\d+$/.test(labels[labels.length - 1])) {
    return { ok: false, error: 'domain_invalid' };
  }

  // Homoglyph check on the Unicode form, per label. Any xn-- label that mixes
  // Latin with Cyrillic/Greek is rejected; single-script IDNs pass.
  const unicode = domainToUnicode(ascii);
  for (const uLabel of unicode.split('.')) {
    if (isMixedScriptLabel(uLabel)) {
      return { ok: false, error: 'mixed_script_homoglyph' };
    }
  }

  // Our own infrastructure — exact host or any subdomain of a blocked suffix.
  const blocked = [...BLOCKED_SUFFIXES, ...envBlockedSuffixes(), targetHost()];
  for (const suf of blocked) {
    if (!suf) continue;
    if (ascii === suf || ascii.endsWith('.' + suf)) {
      return { ok: false, error: 'own_host_not_allowed' };
    }
  }

  return { ok: true, domain: ascii, unicode };
}
