// Domain Hub — attach / verify / detach state machine.
//
//   attach ──▶ pending_dns ──(DNS points at us)──▶ verifying
//              ▲    │                                 │
//              │    │                        Render registration OK
//     records lost / └──(attempts exhausted)──▶ error │
//     re-attach resumes                               ▼
//                                                connected
//
//  • pending_dns : row exists; operator still has records to create.
//  • verifying   : DNS points at us; Render custom-domain registration (and
//                  its TLS issuance) in flight.
//  • connected   : registered on the Render service — the host serves.
//  • error       : bounded retries exhausted; error_detail says why. verify-now
//                  from the UI resets the counter and resumes.
//
// Idempotent at every step: re-attach of an existing domain RESUMES its row
// (never a second row — domain is unique); Render registration checks the
// service's existing domain list before creating (never a duplicate
// registration); detach tolerates an already-removed Render domain.
//
// Ownership residual (documented honestly): the ownership proof here IS
// "the DNS for this host points at our service" — the same proof Render
// itself uses before issuing TLS. There is no separate TXT challenge: a
// verification_token is minted and stored per row (audit + future TXT
// upgrade path), but until DNS points at us the domain never serves, and an
// attacker attaching a domain they don't control simply parks a pending_dns
// row that can never progress.
import { randomBytes } from 'node:crypto';
import { pgQuery, client as pgClient } from '../../db/pg.js';
import { ensureDomainTables, logDomainEvent } from './schema.js';
import { normalizeDomain } from './validate.js';
import {
  detectProvider, isPointing, observeRecords, requiredRecords,
} from './dnsInspect.js';
import {
  ensureCustomDomain, deleteCustomDomain, getCustomDomain,
  renderConfigured,
} from './renderApi.js';
import { autoCreateRecords, cloudflareConfigured } from './cloudflareDns.js';
import { invalidateHostCache } from './hostRouting.js';

// Verify retry budget — a BACKOFF SCHEDULE totalling 24h before the row
// parks at `error` (operator can always resume via verify-now, which resets
// the counter): the first hour re-checks every sweep tick (60 attempts @
// 60s), after that every 5 minutes (276 attempts @ 300s).
//   60 × 60s + 276 × 300s = 3,600s + 82,800s = 86,400s = 24h exactly.
// The sweep still ticks every 60s; verifyDomain defers a row whose schedule
// delay has not yet elapsed (see the gate below), so the slow phase never
// hammers DNS or the Render API.
export const FAST_VERIFY_ATTEMPTS = 60;
export const FAST_VERIFY_DELAY_MS = 60_000;
export const SLOW_VERIFY_DELAY_MS = 300_000;
export const MAX_VERIFY_ATTEMPTS = 336; // 60 fast + 276 slow ≈ 24h total

/** Delay to wait AFTER `attempts` spent attempts before the next one runs. */
export function verifyDelayMs(attempts) {
  return attempts < FAST_VERIFY_ATTEMPTS ? FAST_VERIFY_DELAY_MS : SLOW_VERIFY_DELAY_MS;
}

const newId = () => 'dom_' + randomBytes(7).toString('hex');
const newToken = () => 'puure-verify-' + randomBytes(16).toString('hex');

async function getRow(domain) {
  const rows = await pgQuery(`SELECT * FROM lb_domains WHERE domain = $1`, [domain]);
  return rows[0] || null;
}

/** Funnel existence check — fail-open when the funnels table isn't there yet
 *  (it belongs to funnels.js's DDL; this module never creates it). */
async function funnelExists(funnelId) {
  try {
    const rows = await pgQuery(
      `SELECT id FROM funnels WHERE id = $1 AND archived = FALSE`, [funnelId]
    );
    return rows.length > 0;
  } catch (err) {
    if (err.code === '42P01') return true; // table not created yet — don't block
    throw err;
  }
}

/**
 * Attach (or resume) a domain for a funnel.
 * Returns { ok, domain(row), records, provider, cloudflare:{configured, auto} }
 * or { ok:false, error, status }.
 */
export async function attachDomain({ domain: rawDomain, funnelId, actor = null, autoDns = true }) {
  await ensureDomainTables();
  const norm = normalizeDomain(rawDomain);
  if (!norm.ok) return { ok: false, status: 400, error: norm.error };
  const domain = norm.domain;

  if (!funnelId || typeof funnelId !== 'string') {
    return { ok: false, status: 400, error: 'funnel_id_required' };
  }
  if (!(await funnelExists(funnelId))) {
    return { ok: false, status: 404, error: 'funnel_not_found' };
  }

  // Resume-or-create. Existing row for the SAME funnel resumes as-is;
  // a row bound to another funnel is a conflict the operator resolves by
  // detaching first (never a silent steal).
  let row = await getRow(domain);
  if (row && row.funnel_id !== funnelId) {
    return { ok: false, status: 409, error: 'domain_attached_to_other_funnel' };
  }
  const resumed = Boolean(row);
  if (!row) {
    const inserted = await pgQuery(
      `INSERT INTO lb_domains (id, domain, funnel_id, verification_token)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (domain) DO NOTHING
       RETURNING *`,
      [newId(), domain, funnelId, newToken()]
    );
    // Lost a race to a concurrent attach → treat as resume of that row.
    row = inserted[0] || (await getRow(domain));
    if (!row) return { ok: false, status: 500, error: 'attach_failed' };
    if (row.funnel_id !== funnelId) {
      return { ok: false, status: 409, error: 'domain_attached_to_other_funnel' };
    }
  }
  await logDomainEvent(domain, resumed ? 'attach_resumed' : 'attached',
    { funnel_id: funnelId }, actor);

  // Detect the DNS provider (best effort; null = lookup failed right now).
  let provider = null;
  try { provider = await detectProvider(domain); } catch { provider = null; }
  if (provider && provider !== row.dns_provider) {
    await pgQuery(
      `UPDATE lb_domains SET dns_provider = $2, updated_at = NOW() WHERE domain = $1`,
      [domain, provider]
    );
    row.dns_provider = provider;
  }

  const records = requiredRecords(domain);

  // Cloudflare auto-create: only when creds are configured AND the caller
  // didn't opt out. Fail-open — a CF error degrades to manual instructions.
  let cfResult = null;
  if (autoDns && cloudflareConfigured()) {
    try {
      cfResult = await autoCreateRecords(domain);
      await logDomainEvent(domain, 'cloudflare_auto_dns', {
        ok: cfResult.ok, error: cfResult.error || null,
        records: cfResult.created.map((r) => ({ type: r.type, name: r.name, action: r.action, ok: r.ok })),
      }, actor);
    } catch (err) {
      cfResult = { ok: false, error: err.message, created: [] };
      await logDomainEvent(domain, 'cloudflare_auto_dns', { ok: false, error: err.message }, actor);
    }
  }

  // Kick an immediate verify pass so a domain whose DNS is already pointing
  // (or was just auto-created) connects without waiting a sweep tick.
  let verified = null;
  try { verified = await verifyDomain(domain, { actor }); } catch { verified = null; }

  const fresh = (verified && verified.ok && verified.row) ? verified.row : await getRow(domain);
  return {
    ok: true,
    resumed,
    domain: fresh,
    records,
    provider: fresh?.dns_provider || provider,
    cloudflare: { configured: cloudflareConfigured(), auto: cfResult },
    render_configured: renderConfigured(),
  };
}

/**
 * One verification step for a domain row. Called by the sweep AND by the
 * verify-now endpoint (which passes resetAttempts:true).
 *
 *  DNS not pointing  → stays/downgrades to pending_dns (attempt counted)
 *  DNS pointing      → ensure Render registration (idempotent) → verifying,
 *                      then if Render reports verified (or Render is not
 *                      configured — degraded local mode) → connected
 *  attempts exhausted→ error (resumable)
 */
export async function verifyDomain(domain, { actor = null, resetAttempts = false } = {}) {
  await ensureDomainTables();
  const row = await getRow(domain);
  if (!row) return { ok: false, status: 404, error: 'domain_not_found' };

  if (resetAttempts && (row.verify_attempts > 0 || row.status === 'error')) {
    await pgQuery(
      `UPDATE lb_domains SET verify_attempts = 0,
         status = CASE WHEN status = 'error' THEN 'pending_dns' ELSE status END,
         error_detail = NULL, updated_at = NOW()
       WHERE domain = $1`, [domain]
    );
    row.verify_attempts = 0;
    if (row.status === 'error') row.status = 'pending_dns';
    row.error_detail = null;
  }

  if (row.status === 'connected') {
    // Nothing to do — but keep last_check honest.
    await pgQuery(`UPDATE lb_domains SET last_check = NOW() WHERE domain = $1`, [domain]);
    return { ok: true, row: await getRow(domain), transition: null };
  }
  if (row.status === 'error' && !resetAttempts) {
    return { ok: true, row, transition: null }; // parked — operator resumes explicitly
  }

  // Backoff gate: the sweep ticks every minute, but during the slow phase a
  // row is only re-checked once its schedule delay has elapsed. Manual
  // verify-now (resetAttempts:true) always runs. 5s grace absorbs tick jitter
  // so the fast phase does not skip alternate ticks.
  if (!resetAttempts && row.last_check) {
    const ageMs = Date.now() - new Date(row.last_check).getTime();
    if (ageMs < verifyDelayMs(row.verify_attempts) - 5_000) {
      return { ok: true, row, transition: null, deferred: true };
    }
  }

  const point = await isPointing(domain);
  await logDomainEvent(domain, 'dns_check', {
    pointing: point.pointing, observed: point.observed,
  }, actor);

  if (point.pointing !== true) {
    // Not pointing (false) or lookups failed (null) — count the attempt,
    // park at error once the budget is spent. A connected-regression is not
    // possible here (we returned early above).
    const attempts = row.verify_attempts + 1;
    const exhausted = attempts >= MAX_VERIFY_ATTEMPTS;
    await pgQuery(
      `UPDATE lb_domains SET verify_attempts = $2, last_check = NOW(),
         status = $3, error_detail = $4, updated_at = NOW()
       WHERE domain = $1`,
      [domain, attempts,
        exhausted ? 'error' : 'pending_dns',
        exhausted ? 'dns_never_pointed: retries exhausted — check the records, then Verify now' : row.error_detail]
    );
    if (exhausted) await logDomainEvent(domain, 'verify_exhausted', { attempts }, actor);
    return { ok: true, row: await getRow(domain), transition: exhausted ? 'error' : null, pointing: point.pointing };
  }

  // DNS points at us → register with Render (idempotent: existing id short-
  // circuits; ensureCustomDomain lists before creating).
  let renderDomainId = row.render_domain_id;
  let renderVerified = null;
  if (renderConfigured()) {
    if (!renderDomainId) {
      const reg = await ensureCustomDomain(domain);
      await logDomainEvent(domain, 'render_register', {
        ok: reg.ok, created: reg.created ?? null, error: reg.error || null,
        render_domain_id: reg.domain?.id || null,
      }, actor);
      if (!reg.ok) {
        const attempts = row.verify_attempts + 1;
        const exhausted = attempts >= MAX_VERIFY_ATTEMPTS;
        await pgQuery(
          `UPDATE lb_domains SET verify_attempts = $2, last_check = NOW(),
             status = $3, error_detail = $4, updated_at = NOW()
           WHERE domain = $1`,
          [domain, attempts, exhausted ? 'error' : 'verifying',
            `render_register_failed: ${reg.error}`]
        );
        return { ok: true, row: await getRow(domain), transition: exhausted ? 'error' : 'verifying' };
      }
      renderDomainId = reg.domain?.id || null;
    }
    // Ask Render whether IT considers the domain verified (drives TLS).
    if (renderDomainId) {
      const got = await getCustomDomain(renderDomainId);
      if (got.ok) renderVerified = got.domain?.verificationStatus === 'verified';
    }
  }

  // Status:
  //  • Render configured  → `connected` requires RENDER's own verification;
  //    until then the row sits at `verifying` (registration + TLS in flight).
  //  • Render NOT configured, PRODUCTION → the row must NOT connect. Render's
  //    apex IP and service host are SHARED across every Render customer, so
  //    "this host resolves to a Render address" is NOT proof that it belongs
  //    to this service — only Render's own custom-domain verification is.
  //    Connecting on DNS-pointing alone would let any host that happens to
  //    point at Render's shared edge serve one of our funnels. Hold at
  //    `verifying` with the reason surfaced, and log loudly.
  //  • Render NOT configured, non-production → keep the degraded local/dev
  //    behaviour (DNS-pointing connects) so the flow is testable offline.
  const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  let status;
  let errorDetail = null;
  if (!renderConfigured()) {
    if (isProd) {
      status = 'verifying';
      errorDetail = 'render_not_configured: set RENDER_API_KEY and RENDER_SERVICE_ID — a domain cannot be verified as ours without Render (its apex IP is shared across all Render customers)';
      console.error('[domainHub] REFUSING to connect %s — NODE_ENV=production with no Render credentials; DNS-pointing alone is not ownership.', domain);
      await logDomainEvent(domain, 'connect_blocked_render_not_configured', {
        note: 'production + no RENDER_API_KEY/RENDER_SERVICE_ID — held at verifying',
      }, actor);
    } else {
      status = 'connected';
      console.warn('[domainHub] %s connected in DEGRADED mode (no Render credentials, NODE_ENV=%s) — DNS-pointing only, NOT ownership-verified.',
        domain, process.env.NODE_ENV || 'unset');
      await logDomainEvent(domain, 'connected_degraded_no_render', {
        note: 'RENDER_API_KEY/RENDER_SERVICE_ID absent — connected on DNS-pointing alone (non-production only)',
      }, actor);
    }
  } else if (renderVerified === true) {
    status = 'connected';
  } else {
    status = 'verifying';
  }

  await pgQuery(
    `UPDATE lb_domains SET status = $2, render_domain_id = $3,
       verify_attempts = 0, last_check = NOW(), error_detail = $4, updated_at = NOW()
     WHERE domain = $1`,
    [domain, status, renderDomainId, errorDetail]
  );
  if (status === 'connected' && row.status !== 'connected') {
    await logDomainEvent(domain, 'connected', { render_domain_id: renderDomainId }, actor);
  }
  invalidateHostCache(domain);
  return { ok: true, row: await getRow(domain), transition: status, pointing: true };
}

/**
 * Detach: remove the Render registration (idempotent — 404 is success),
 * delete the row, audit it. `confirm` must equal the domain (typed
 * confirmation — detaching a connected domain takes a live host down).
 */
export async function detachDomain(domain, { confirm, actor = null } = {}) {
  await ensureDomainTables();
  const norm = normalizeDomain(domain);
  const key = norm.ok ? norm.domain : String(domain || '').trim().toLowerCase();
  const row = await getRow(key);
  if (!row) return { ok: false, status: 404, error: 'domain_not_found' };
  if (confirm !== row.domain) {
    return { ok: false, status: 400, error: 'confirm_must_match_domain' };
  }

  if (row.render_domain_id && renderConfigured()) {
    const del = await deleteCustomDomain(row.render_domain_id);
    await logDomainEvent(row.domain, 'render_unregister', {
      ok: del.ok, error: del.ok ? null : del.error,
    }, actor);
    if (!del.ok) {
      // Leave the row so the operator can retry — never orphan a live Render
      // registration by deleting our only pointer to it.
      return { ok: false, status: 502, error: `render_unregister_failed: ${del.error}` };
    }
  }

  await pgQuery(`DELETE FROM lb_domains WHERE domain = $1`, [row.domain]);
  await logDomainEvent(row.domain, 'detached', { funnel_id: row.funnel_id }, actor);
  invalidateHostCache(row.domain);
  return { ok: true, domain: row.domain };
}

/**
 * Reassign an attached domain to ANOTHER funnel ("Reuse here"). The Render
 * registration is service-level (one web service hosts every funnel), so no
 * Render call is involved — only which funnel the host routes to changes.
 *
 * Atomic (single transaction): move the lb_domains row AND clear the old
 * funnel's custom_domain pointer when it referenced this domain — a reassign
 * must never leave funnel A "primary on" a domain that now serves funnel B.
 * The row move is keyed on the old funnel_id, so a concurrent reassign /
 * detach makes this one fail with `reassign_conflict` instead of silently
 * double-moving.
 *
 * Refuses without confirm:true — a connected host starts serving the new
 * funnel immediately.
 */
export async function reassignDomain(domain, { funnelId, confirm, actor = null } = {}) {
  await ensureDomainTables();
  const norm = normalizeDomain(domain);
  if (!norm.ok) return { ok: false, status: 400, error: norm.error };
  const row = await getRow(norm.domain);
  if (!row) return { ok: false, status: 404, error: 'domain_not_found' };
  if (confirm !== true) {
    await logDomainEvent(row.domain, 'reassign_refused', { reason: 'confirm_missing' }, actor);
    return { ok: false, status: 400, error: 'confirm_required' };
  }
  if (!funnelId || typeof funnelId !== 'string') {
    return { ok: false, status: 400, error: 'funnel_id_required' };
  }
  if (row.funnel_id === funnelId) {
    return { ok: false, status: 400, error: 'domain_already_on_this_funnel' };
  }
  if (!(await funnelExists(funnelId))) {
    return { ok: false, status: 404, error: 'funnel_not_found' };
  }

  const fromFunnelId = row.funnel_id;
  let moved = null;
  await pgClient.begin(async (tx) => {
    const rows = await tx`
      UPDATE lb_domains SET funnel_id = ${funnelId}, updated_at = NOW()
      WHERE domain = ${row.domain} AND funnel_id = ${fromFunnelId}
      RETURNING *`;
    moved = rows[0] || null;
    if (!moved) {
      // Concurrent reassign/detach won the race — abort the whole transaction
      // (nothing, including the pointer clear below, may land).
      const err = new Error('reassign_conflict');
      err.reassignConflict = true;
      throw err;
    }
    await tx`
      UPDATE funnels SET custom_domain = NULL, updated_at = NOW()
      WHERE id = ${fromFunnelId} AND custom_domain = ${row.domain}`;
  }).catch((err) => {
    if (err.reassignConflict) { moved = null; return; }
    throw err; // real DB failure — LET IT THROW to the route's 500
  });
  if (!moved) return { ok: false, status: 409, error: 'reassign_conflict' };

  await logDomainEvent(row.domain, 'reassigned', {
    from_funnel_id: fromFunnelId, to_funnel_id: funnelId,
  }, actor);
  invalidateHostCache(row.domain); // host now routes to the NEW funnel
  return { ok: true, row: moved };
}

/** List rows (optionally per funnel), newest first. */
export async function listDomains({ funnelId = null } = {}) {
  await ensureDomainTables();
  if (funnelId) {
    return pgQuery(
      `SELECT * FROM lb_domains WHERE funnel_id = $1 ORDER BY created_at DESC`, [funnelId]
    );
  }
  return pgQuery(`SELECT * FROM lb_domains ORDER BY created_at DESC`);
}

/** Required + currently-observed records for the records view. */
export async function recordsView(domain) {
  await ensureDomainTables();
  const norm = normalizeDomain(domain);
  if (!norm.ok) return { ok: false, status: 400, error: norm.error };
  const row = await getRow(norm.domain);
  if (!row) return { ok: false, status: 404, error: 'domain_not_found' };
  const observed = await observeRecords(norm.domain);
  let provider = row.dns_provider;
  if (!provider) {
    try { provider = await detectProvider(norm.domain); } catch { provider = null; }
  }
  return {
    ok: true,
    domain: row.domain,
    status: row.status,
    provider,
    required: requiredRecords(norm.domain),
    observed,
    cloudflare_configured: cloudflareConfigured(),
    render_configured: renderConfigured(),
  };
}
