// Domain Hub — Cloudflare Registrar adapter (STUB — not implemented).
//
// Cloudflare Registrar's direct-registration API is still gated (beta for
// most accounts) and CF only REGISTERS at cost for domains whose zone is
// already on the account — the friend's tool falls back to a dashboard
// deep-link for exactly this reason (see funnel-os
// listicle_registrar_service.register_domain). Until Ludo's CF account has
// Registrar API access, this stub answers honestly instead of half-working.
export function configured() {
  return false;
}

const NOT_IMPLEMENTED = {
  ok: false,
  error: 'cloudflare_registrar_not_implemented',
  note: 'Cloudflare Registrar API access is account-gated; use the Namecheap adapter (DOMAIN_REGISTRAR=namecheap) or buy on the Cloudflare dashboard and attach the domain here.',
};

export async function searchDomains() {
  return { ...NOT_IMPLEMENTED, results: [] };
}

export async function purchaseDomain() {
  return { ...NOT_IMPLEMENTED, status: 501 };
}

export async function listOwnedDomains() {
  return { ...NOT_IMPLEMENTED, domains: [] };
}
