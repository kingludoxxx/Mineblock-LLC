// Domain Hub — admin routes. Buy / attach / verify / manage custom domains
// per funnel.
//
// ── INTEGRATION HOOK (Ludo wires at merge — this file does NOT edit
//    routes/index.js) ─────────────────────────────────────────────────────
//   routes/index.js:
//     import domainHubRoutes from './domainHub.js';
//     app.use('/api/v1/domain-hub', domainHubRoutes);
//
// Auth: same gate as the funnels surface — requirePermission('funnels',
// 'access'). Purchases are additionally gated by confirm:true in the body
// (real money) and by registrar creds being configured.
import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { pgQuery } from '../db/pg.js';
import { ensureDomainTables, logDomainEvent } from '../services/domainHub/schema.js';
import { normalizeDomain } from '../services/domainHub/validate.js';
import {
  attachDomain, verifyDomain, detachDomain, listDomains, recordsView,
  reassignDomain,
} from '../services/domainHub/attachService.js';
import { renderTargetHost } from '../services/domainHub/dnsInspect.js';
import { getAdapter, registrarStatus } from '../services/domainHub/registrars/index.js';
import { autoCreateRecords, cloudflareConfigured } from '../services/domainHub/cloudflareDns.js';
import { renderConfigured } from '../services/domainHub/renderApi.js';
import { startDomainSweep } from '../services/domainHub/verifySweep.js';

// Background verify-poll — started at module load like moneySweeps (single
// web service, in-process). DOMAIN_SWEEP_DISABLED=1 turns it off.
startDomainSweep();

const router = Router();
router.use(authenticate, requirePermission('funnels', 'access'));

const actorOf = (req) => req.user?.email || req.user?.id || null;
const fail = (res, status, error) => res.status(status).json({ error });

// ── Registrar ───────────────────────────────────────────────────────────────

// GET /registrar/status — which registrar is active + configured (drives the
// "registrar connected" badge and gates the Buy tab). render_target_host is
// the service host DNS must point at — the Domains tab banner shows it.
router.get('/registrar/status', async (_req, res) => {
  res.json({
    data: {
      ...registrarStatus(),
      cloudflare_dns_configured: cloudflareConfigured(),
      render_configured: renderConfigured(),
      render_target_host: renderTargetHost(),
    },
  });
});

// GET /search?q= — availability + price across popular TLDs. Read-only.
router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return fail(res, 400, 'query_required');
    if (q.length > 100) return fail(res, 400, 'query_too_long');
    const result = await getAdapter().searchDomains(q);
    if (!result.ok) return fail(res, 502, result.error);
    res.json({ data: result });
  } catch (err) {
    console.error('[domainHub] search failed:', err);
    fail(res, 500, 'search_failed');
  }
});

// GET /owned — domains in the registrar account ("My domains" tab).
router.get('/owned', async (_req, res) => {
  try {
    const result = await getAdapter().listOwnedDomains();
    if (!result.ok) return fail(res, 502, result.error);
    res.json({ data: result });
  } catch (err) {
    console.error('[domainHub] owned list failed:', err);
    fail(res, 500, 'owned_list_failed');
  }
});

// POST /purchase { domain, contact?, confirm } — REAL MONEY, operator-gated.
// Without confirm:true or without creds this refuses. contact omitted → the
// stored WHOIS contact is used. Search-before-buy idempotency lives in the
// adapter. Every attempt (refused, failed, succeeded) is audited.
router.post('/purchase', async (req, res) => {
  try {
    const { domain: rawDomain, contact: bodyContact, confirm, years } = req.body || {};
    const norm = normalizeDomain(rawDomain);
    if (!norm.ok) return fail(res, 400, norm.error);
    const domain = norm.domain;

    if (confirm !== true) {
      await logDomainEvent(domain, 'purchase_refused', { reason: 'confirm_missing' }, actorOf(req));
      return fail(res, 400, 'confirm_required');
    }
    const adapter = getAdapter();
    if (!adapter.configured()) {
      await logDomainEvent(domain, 'purchase_refused', { reason: 'registrar_not_configured' }, actorOf(req));
      return fail(res, 400, 'registrar_not_configured');
    }

    let contact = bodyContact;
    if (!contact) {
      await ensureDomainTables();
      const rows = await pgQuery(`SELECT contact FROM domain_whois_contact WHERE id = 'default'`);
      contact = rows[0]?.contact || null;
      if (typeof contact === 'string') { try { contact = JSON.parse(contact); } catch { contact = null; } }
    }
    if (!contact) return fail(res, 400, 'whois_contact_required');

    const result = await adapter.purchaseDomain(domain, contact, {
      confirm: true, years: Number(years) || 1,
    });
    await logDomainEvent(domain, result.ok ? 'purchased' : 'purchase_failed', {
      registrar: result.registrar || null,
      charged_amount: result.charged_amount ?? null,
      order_id: result.order_id ?? null,
      error: result.ok ? null : result.error,
    }, actorOf(req));
    if (!result.ok) return fail(res, result.status || 502, result.error);
    res.status(201).json({ data: result });
  } catch (err) {
    console.error('[domainHub] purchase failed:', err);
    fail(res, 500, 'purchase_failed');
  }
});

// ── WHOIS contact ───────────────────────────────────────────────────────────

router.get('/whois', async (_req, res) => {
  try {
    await ensureDomainTables();
    const rows = await pgQuery(`SELECT contact, updated_at FROM domain_whois_contact WHERE id = 'default'`);
    let contact = rows[0]?.contact || null;
    if (typeof contact === 'string') { try { contact = JSON.parse(contact); } catch { contact = null; } }
    res.json({ data: { contact, updated_at: rows[0]?.updated_at || null } });
  } catch (err) {
    console.error('[domainHub] whois read failed:', err);
    fail(res, 500, 'whois_read_failed');
  }
});

router.put('/whois', async (req, res) => {
  try {
    await ensureDomainTables();
    const contact = req.body?.contact;
    if (!contact || typeof contact !== 'object' || Array.isArray(contact)) {
      return fail(res, 400, 'contact_object_required');
    }
    // Store only known scalar fields — never arbitrary payload.
    const FIELDS = ['first_name', 'last_name', 'organization', 'email', 'phone',
      'address1', 'address2', 'city', 'state_province', 'postal_code', 'country'];
    const clean = {};
    for (const f of FIELDS) {
      if (contact[f] !== undefined) clean[f] = String(contact[f]).slice(0, 200);
    }
    await pgQuery(
      `INSERT INTO domain_whois_contact (id, contact, updated_at)
       VALUES ('default', $1, NOW())
       ON CONFLICT (id) DO UPDATE SET contact = $1, updated_at = NOW()`,
      [JSON.stringify(clean)]
    );
    res.json({ data: { contact: clean } });
  } catch (err) {
    console.error('[domainHub] whois save failed:', err);
    fail(res, 500, 'whois_save_failed');
  }
});

// ── Attach / manage ─────────────────────────────────────────────────────────

// POST /attach { domain, funnel_id, auto_dns? } — validate → detect provider
// → respond with required records; auto-creates them when Cloudflare creds
// are configured; kicks an immediate verify. Idempotent (resume, no dupes).
router.post('/attach', async (req, res) => {
  try {
    const { domain, funnel_id: funnelId, auto_dns: autoDns } = req.body || {};
    const result = await attachDomain({
      domain, funnelId, actor: actorOf(req),
      autoDns: autoDns !== false,
    });
    if (!result.ok) return fail(res, result.status || 500, result.error);
    res.status(result.resumed ? 200 : 201).json({ data: result });
  } catch (err) {
    console.error('[domainHub] attach failed:', err);
    fail(res, 500, 'attach_failed');
  }
});

// GET /list?funnel_id= — attached domains ("Connected" tab). Live-polled.
router.get('/list', async (req, res) => {
  try {
    const funnelId = req.query.funnel_id ? String(req.query.funnel_id) : null;
    const rows = await listDomains({ funnelId });
    res.json({ data: rows });
  } catch (err) {
    console.error('[domainHub] list failed:', err);
    fail(res, 500, 'list_failed');
  }
});

// GET /events?domain= — audit trail.
router.get('/events', async (req, res) => {
  try {
    await ensureDomainTables();
    const norm = normalizeDomain(String(req.query.domain || ''));
    if (!norm.ok) return fail(res, 400, norm.error);
    const rows = await pgQuery(
      `SELECT event, detail, actor, created_at FROM domain_events
       WHERE domain = $1 ORDER BY created_at DESC LIMIT 100`,
      [norm.domain]
    );
    res.json({ data: rows });
  } catch (err) {
    console.error('[domainHub] events failed:', err);
    fail(res, 500, 'events_failed');
  }
});

// POST /:domain/verify — verify now (resets a parked error row and re-runs
// the full DNS → Render step immediately).
router.post('/:domain/verify', async (req, res) => {
  try {
    const norm = normalizeDomain(String(req.params.domain || ''));
    if (!norm.ok) return fail(res, 400, norm.error);
    const result = await verifyDomain(norm.domain, {
      actor: actorOf(req), resetAttempts: true,
    });
    if (!result.ok) return fail(res, result.status || 500, result.error);
    res.json({ data: result.row });
  } catch (err) {
    console.error('[domainHub] verify failed:', err);
    fail(res, 500, 'verify_failed');
  }
});

// GET /:domain/records — required records + what DNS currently answers
// (live lookup via node:dns; we never HTTP-fetch the domain).
router.get('/:domain/records', async (req, res) => {
  try {
    const result = await recordsView(String(req.params.domain || ''));
    if (!result.ok) return fail(res, result.status || 500, result.error);
    res.json({ data: result });
  } catch (err) {
    console.error('[domainHub] records failed:', err);
    fail(res, 500, 'records_failed');
  }
});

// POST /:domain/auto-dns — (re)create the required records via Cloudflare.
// Only meaningful when CLOUDFLARE_API_TOKEN is configured.
router.post('/:domain/auto-dns', async (req, res) => {
  try {
    if (!cloudflareConfigured()) return fail(res, 400, 'cloudflare_not_configured');
    const norm = normalizeDomain(String(req.params.domain || ''));
    if (!norm.ok) return fail(res, 400, norm.error);
    const result = await autoCreateRecords(norm.domain);
    await logDomainEvent(norm.domain, 'cloudflare_auto_dns', {
      ok: result.ok, error: result.error || null,
    }, actorOf(req));
    if (!result.ok) return fail(res, 502, result.error);
    res.json({ data: result });
  } catch (err) {
    console.error('[domainHub] auto-dns failed:', err);
    fail(res, 500, 'auto_dns_failed');
  }
});

// POST /:domain/reassign { funnel_id, from_funnel_id?, confirm } — move an
// already-attached domain to another funnel ("Reuse here" in the Domains
// tab). Atomic: clears any funnel's custom_domain pointer to this domain and
// moves the row in one transaction. from_funnel_id anchors the conflict
// guard to the funnel the caller's confirm dialog named — a stale value
// (row moved since the caller's list load) refuses with reassign_conflict
// instead of silently chain-moving. confirm:true required — a connected
// host starts serving the NEW funnel immediately.
router.post('/:domain/reassign', async (req, res) => {
  try {
    const result = await reassignDomain(String(req.params.domain || ''), {
      funnelId: req.body?.funnel_id,
      fromFunnelId: req.body?.from_funnel_id,
      confirm: req.body?.confirm,
      actor: actorOf(req),
    });
    if (!result.ok) return fail(res, result.status || 500, result.error);
    res.json({ data: result.row });
  } catch (err) {
    console.error('[domainHub] reassign failed:', err);
    fail(res, 500, 'reassign_failed');
  }
});

// DELETE /:domain { confirm } — detach: remove the Render registration then
// the row. confirm must equal the domain (typed confirmation).
router.delete('/:domain', async (req, res) => {
  try {
    const result = await detachDomain(String(req.params.domain || ''), {
      confirm: req.body?.confirm, actor: actorOf(req),
    });
    if (!result.ok) return fail(res, result.status || 500, result.error);
    // FUNNEL-SETTINGS Domains tab (additive): funnels.custom_domain marks a
    // funnel's PRIMARY domain; detaching that domain must not leave the
    // pointer dangling. Fail-open — a repair miss never blocks the detach.
    try {
      await pgQuery(
        `UPDATE funnels SET custom_domain = NULL, updated_at = NOW() WHERE custom_domain = $1`,
        [result.domain]
      );
    } catch (repairErr) {
      console.error('[domainHub] custom_domain clear after detach failed:', repairErr.message);
    }
    res.json({ data: { detached: result.domain } });
  } catch (err) {
    console.error('[domainHub] detach failed:', err);
    fail(res, 500, 'detach_failed');
  }
});

export default router;
