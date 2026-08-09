// Domain Hub — registrar adapter registry.
//
// Interface every adapter implements:
//   configured()                       → boolean (creds present)
//   searchDomains(query)               → { ok, registrar, results:[{domain,
//                                          available, premium, price,
//                                          currency, error}] }
//   purchaseDomain(domain, contact, {confirm, years})
//                                      → { ok, domain, charged_amount, … }
//                                        OPERATOR-TRIGGERED ONLY; refuses
//                                        without confirm:true + creds.
//   listOwnedDomains()                 → { ok, domains:[…] }
//
// Active adapter picked by env DOMAIN_REGISTRAR (default 'namecheap').
import * as namecheap from './namecheap.js';
import * as cloudflareRegistrar from './cloudflareRegistrar.js';

const ADAPTERS = {
  namecheap,
  cloudflare: cloudflareRegistrar,
};

export function activeRegistrarName() {
  const name = String(process.env.DOMAIN_REGISTRAR || 'namecheap').trim().toLowerCase();
  return ADAPTERS[name] ? name : 'namecheap';
}

export function getAdapter(name = null) {
  return ADAPTERS[name || activeRegistrarName()];
}

export function registrarStatus() {
  const name = activeRegistrarName();
  return {
    registrar: name,
    configured: getAdapter(name).configured(),
    available: Object.entries(ADAPTERS).map(([n, a]) => ({
      name: n,
      configured: a.configured(),
    })),
  };
}
