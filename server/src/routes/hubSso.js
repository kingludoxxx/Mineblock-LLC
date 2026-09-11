// HUB SSO EXCHANGE (S1-4) — the hub authenticated the operator (password + TOTP), minted a 30 s ticket signed with THIS
// store's own HUB_SSO_SECRET, and posted the browser here. We exchange it for the dashboard's OWN session (same cookies,
// same token as /auth/login) and 302 into the SPA. No cookie or CORS change: the ticket is the only credential on this
// request, and the cookies we set are first-party for every request the SPA makes afterwards.
//
// TRUST MODEL
//  • Dark unless HUB_SSO_ENABLED === '1' (read per request, R7): anything else is a 404 taken BEFORE any other work —
//    no rate-limit bucket, no database, nothing (review P1-3: while dark this route must be invisible).
//  • HUB_SSO_SECRET is per store, set by the hub, env only, and at least 32 bytes: a shorter key refuses to serve the
//    route with a 503 that names it (review P2-2, fail closed) before any HMAC is computed. Signature = HMAC-SHA256 over
//    the EXACT payload bytes received, compared with timingSafeEqual. A missing secret is the same 503.
//  • Origin: the hub's browser form is cross-site, so the request MUST carry an Origin (or, when the browser sends none,
//    a Referer) whose origin is in HUB_ORIGIN. HUB_ORIGIN unset while the flag is on is a 503 (review P2-6, login CSRF).
//  • Rate limit: this route keeps its OWN per-IP bucket and counts REFUSALS only. It never touches the shared
//    `auth:<ip>` budget, so neither a dark probe nor a successful hop can lock the store's own login (review P1-3).
//  • Audience: ticket.store_code must equal STORE_CODE. A ticket for another store is refused before anything is written.
//  • Time: exp (unix seconds) with 30 s clock skew; a ticket claiming more than TTL_CEILING_S of life is refused (a bug
//    on the minting side cannot issue a long-lived one).
//  • Single use: the nonce is burned in hub_sso_used_tickets under its primary key inside the same transaction that
//    creates the user/session; two parallel exchanges cannot both win.
//  • JIT: an unknown email is created with the role hub_role_map gives the hub role, else the '*' fallback (least
//    privileged; W8b: the map's seeded targets are the PAGE roles, migration 133). An existing user is never
//    re-roled in either direction — and since W8b a disagreement between what the hub thinks this operator is
//    and what the store gave them is written to audit_logs as HUB_SSO_ROLE_UNCHANGED instead of being invisible.
//    An inactive user is refused, a LOCKED one is refused with the
//    same 423 the local login answers, and an email that matches more than one row (the users.email UNIQUE is
//    case-sensitive) is refused with 409 rather than picking one (review P2-1 / P2-5).
//  • Revocation has NO grace period (lead's decision, S1-4 plan line A4): the session this route issues is marked
//    hub_sso + sid, so `authenticate` re-reads Postgres on EVERY request and skips the 5-minute session cache. Deleting
//    the sessions row (logout, "log out other devices", an admin revoke) or deactivating the user is enforced on the
//    very next request. See services/hubSession.js.
//  • `stores` (W6, optional): [{code,name}] the hub signed — which stores this operator may switch into. Validated
//    and persisted on the session row (migration 132) so the sidebar can render a switcher; NEVER taken from the
//    client, and a malformed list is ignored rather than refused (a cosmetic list must not lock anyone out).
//  • `next` must be a relative path ('/x', not '//x', not '/\x', not a scheme) or the request is a 400 before any write.
//  • Nothing here calls the hub, or anything, over the network: with the hub gone every store still logs in on its own.
//  • Logs never carry the ticket, the signature, the nonce or the secret.
import { Router } from 'express';
import crypto from 'node:crypto';
import pool from '../config/db.js';
import logger from '../utils/logger.js';
import { hashPassword } from '../utils/hash.js';
import { issueSession, loadRoles, sanitizeHubStores } from '../services/hubSession.js';

const router = Router();

export const SKEW_S = 30;
export const TTL_CEILING_S = 120;
export const MIN_SECRET_BYTES = 32;
const USED_TICKET_RETENTION = '1 day';

// ── this route's OWN rate-limit bucket (review P1-3) ─────────────────────────
// Keyed by IP, counts REFUSALS only, in memory per instance. Deliberately NOT the shared `auth:<ip>` budget:
// a probe of the dark route or a burst of legitimate hops must never lock the store's own /auth/login, and a 302
// is a success, not a failed attempt. It is reached only after the feature flag is on.
const FAIL_LIMIT = 25;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const failures = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of failures) if (e.expiresAt <= now) failures.delete(k);
}, 60_000).unref();

const clientIp = (req) => req.ip || req.socket?.remoteAddress || 'unknown';
const liveEntry = (ip) => {
  const e = failures.get(ip);
  return e && e.expiresAt > Date.now() ? e : null;
};
const countFailure = (req) => {
  const ip = clientIp(req);
  const now = Date.now();
  let e = liveEntry(ip);
  if (!e) { e = { count: 0, expiresAt: now + FAIL_WINDOW_MS }; failures.set(ip, e); }
  e.count += 1;
};

const b64uDecode = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const isB64u = (s) => typeof s === 'string' && s.length > 0 && /^[A-Za-z0-9_-]+$/.test(s);

/**
 * Only a path inside the SPA. '//host' is protocol-relative and '/\host' is read the same way by browsers.
 *
 * W6c / R10 P0-1: the C0-plus-space class is refused too. A URL parser DELETES tab, LF and CR out of a URL
 * before parsing it, so `/<TAB>/evil.example` passes a startsWith('//') test and is then read as
 * `//evil.example` — protocol-relative, off-site. `next` ends up in a res.redirect() here, and express's
 * encodeurl neutralises it on the way out (measured), so this side was never exploitable; it is refused
 * anyway because the SAME string is guarded by three functions in two repos and three guards that disagree
 * about what a path is are three chances to be wrong. The hub's twins carry the identical class:
 * store-hub src/ui/switcher.mjs NEXT_BAD_CHARS (the one that WAS exploitable) and src/routes/switcher.js.
 * Shared list of the forms all three must refuse: server/tests/hub-sso/next-forms.mjs.
 */
export const NEXT_BAD_CHARS = /[\u0000-\u0020]/;
export function safeNext(raw) {
  if (raw === undefined || raw === null || raw === '') return '/';
  if (typeof raw !== 'string' || NEXT_BAD_CHARS.test(raw)) return null;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return null;
  return raw;
}

/** Every refusal counts against this route's own bucket; a 429 does not (it would never expire). */
const refuse = (req, res, status, error) => { countFailure(req); return res.status(status).json({ error }); };

/** Normalised origin ('scheme + host + port', no path) or null. */
const originOf = (value) => { try { return new URL(String(value)).origin; } catch { return null; } };

/** The origins the hub is allowed to post from: HUB_ORIGIN, comma-separated for a hub with more than one hostname. */
export const allowedOrigins = (raw) => String(raw || '').split(',').map((s) => originOf(s.trim())).filter(Boolean);

/** The request's own origin: the Origin header, or the Referer's origin when the browser sent no Origin. */
export const requestOrigin = (req) => {
  const o = req.headers?.origin;
  if (o && o !== 'null') return originOf(o);
  return req.headers?.referer ? originOf(req.headers.referer) : null;
};

/**
 * W8b — hub role -> dashboard role NAME, the ONE lookup both the JIT creation and the divergence
 * audit take. The map is DATA (hub_role_map, migrations 126 + 133), so a store re-points a role
 * without a deploy, and the hub role is only ever a KEY: a ticket that spells a dashboard role name
 * selects nothing unless the map says so.
 *
 * FAIL CLOSED: a hub role this table does not know falls to the '*' row, which both migrations seed
 * as the least-privileged role. null only when there is no '*' row either, and the caller refuses.
 */
async function mappedRoleName(client, hubRole) {
  const { rows } = await client.query(
    'SELECT hub_role, dashboard_role FROM hub_role_map WHERE hub_role = $1 OR hub_role = $2', [hubRole, '*']);
  const hit = rows.find((r) => r.hub_role === hubRole) || rows.find((r) => r.hub_role === '*');
  return hit ? hit.dashboard_role : null;
}

router.post('/exchange', async (req, res, next) => {
  try {
    // The flag first, before the bucket and before any read: while dark this route is indistinguishable from a
    // route that does not exist, and it consumes nothing (review P1-3).
    if (process.env.HUB_SSO_ENABLED !== '1') return res.status(404).json({ error: 'Not found' });

    const entry = liveEntry(clientIp(req));
    if (entry && entry.count >= FAIL_LIMIT) {
      res.set('Retry-After', String(Math.ceil((entry.expiresAt - Date.now()) / 1000)));
      return res.status(429).json({ error: 'Too many failed hub SSO exchanges. Try again later.' });
    }

    const secret = (process.env.HUB_SSO_SECRET || '').trim();
    if (!secret) return refuse(req, res, 503, 'hub_sso_not_configured: HUB_SSO_SECRET is not set on this service');
    if (Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) {
      logger.error('hub_sso_weak_secret', { requiredBytes: MIN_SECRET_BYTES });
      return refuse(req, res, 503, `hub_sso_not_configured: HUB_SSO_SECRET must be at least ${MIN_SECRET_BYTES} bytes`);
    }
    const storeCode = (process.env.STORE_CODE || '').trim();
    if (!storeCode) return refuse(req, res, 503, 'hub_sso_not_configured: STORE_CODE is not set on this service');
    const allowed = allowedOrigins(process.env.HUB_ORIGIN);
    if (allowed.length === 0) return refuse(req, res, 503, 'hub_sso_not_configured: HUB_ORIGIN is not set on this service');

    // Login CSRF: the ticket is the only credential on this request, so a page that owns a ticket of its own could
    // auto-submit this form and log the victim's browser into the attacker's account. Refuse anything not posted
    // from the hub, and refuse a request that carries neither header (review P2-6, fail closed).
    const from = requestOrigin(req);
    if (!from || !allowed.includes(from)) {
      logger.warn('hub_sso_bad_origin');
      return refuse(req, res, 403, 'origin not allowed');
    }

    const nextPath = safeNext(req.body?.next);
    if (nextPath === null) return refuse(req, res, 400, 'next must be a relative path');

    const ticket = req.body?.ticket;
    if (typeof ticket !== 'string' || !ticket.includes('.')) return refuse(req, res, 400, 'malformed ticket');
    const [p64, s64, extra] = ticket.split('.');
    if (extra !== undefined || !isB64u(p64) || !isB64u(s64)) return refuse(req, res, 400, 'malformed ticket');
    const bytes = b64uDecode(p64);
    const got = b64uDecode(s64);
    const want = crypto.createHmac('sha256', secret).update(bytes).digest();
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
      logger.warn('hub_sso_bad_signature');
      return refuse(req, res, 401, 'bad ticket');
    }
    let payload;
    try { payload = JSON.parse(bytes.toString('utf8')); } catch { return refuse(req, res, 400, 'malformed ticket'); }
    if (!payload || typeof payload !== 'object') return refuse(req, res, 400, 'malformed ticket');
    const email = String(payload.email || '').trim().toLowerCase();
    const { exp, nonce } = payload;
    const hubRole = typeof payload.role === 'string' ? payload.role : '';
    if (!email || typeof payload.store_code !== 'string' || typeof exp !== 'number' || !Number.isFinite(exp) || typeof nonce !== 'string' || !nonce) {
      return refuse(req, res, 400, 'incomplete ticket');
    }
    if (payload.store_code !== storeCode) {
      logger.warn('hub_sso_wrong_store');
      return refuse(req, res, 401, 'ticket is for another store');
    }
    const now = Date.now() / 1000;
    if (exp + SKEW_S < now) return refuse(req, res, 401, 'ticket expired');
    if (exp - now > TTL_CEILING_S) { logger.warn('hub_sso_ttl_too_long'); return refuse(req, res, 401, 'ticket ttl too long'); }

    const client = await pool.connect();
    let outcome;
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM hub_sso_used_tickets WHERE exp < NOW() - INTERVAL '${USED_TICKET_RETENTION}'`);
      const burn = await client.query('INSERT INTO hub_sso_used_tickets (nonce, exp) VALUES ($1, to_timestamp($2)) ON CONFLICT (nonce) DO NOTHING', [nonce, exp]);
      if (burn.rowCount === 0) { await client.query('ROLLBACK'); logger.warn('hub_sso_ticket_replayed'); return refuse(req, res, 401, 'ticket already used'); }

      // users.email is UNIQUE case-SENSITIVELY, so 'Dup@' and 'dup@' can both exist (direct inserts / imports).
      // Picking one arbitrarily would decide, silently, which account the hub logs into (review P2-5).
      const found = await client.query('SELECT * FROM users WHERE lower(email) = $1 ORDER BY created_at', [email]);
      if (found.rows.length > 1) {
        await client.query('ROLLBACK'); logger.warn('hub_sso_ambiguous_email');
        return refuse(req, res, 409, 'more than one account matches this email; resolve the duplicate before using SSO');
      }
      let user = found.rows[0] || null;
      let created = false;
      if (!user) {
        // JIT: role from hub_role_map, else the '*' fallback; the role NAME must exist or nothing is created.
        const mappedName = await mappedRoleName(client, hubRole);
        if (!mappedName) { await client.query('ROLLBACK'); return refuse(req, res, 403, 'hub_role_map has no entry for this role and no "*" fallback'); }
        const role = await client.query('SELECT id, name FROM roles WHERE name = $1', [mappedName]);
        if (!role.rows[0]) { await client.query('ROLLBACK'); return refuse(req, res, 403, `dashboard role ${mappedName} does not exist`); }
        // An unusable password: random 32 bytes, bcrypt-hashed. The user logs in through the hub (or resets via forgot-password).
        const unusable = await hashPassword(crypto.randomBytes(32).toString('hex'));
        const ins = await client.query(
          `INSERT INTO users (email, password_hash, first_name, last_name, is_active, email_verified)
           VALUES ($1, $2, '', '', true, true) RETURNING *`, [email, unusable]);
        user = ins.rows[0]; created = true;
        await client.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user.id, role.rows[0].id]);
        await client.query(
          `INSERT INTO audit_logs (user_id, action, resource_type, resource, resource_id, new_values)
           VALUES ($1, 'HUB_SSO_JIT_CREATE', 'user', 'user', $1, $2)`,
          [user.id, JSON.stringify({ email, role: role.rows[0].name, hub_role: hubRole, store_code: storeCode })]);
      } else if (!user.is_active) {
        await client.query('ROLLBACK'); logger.warn('hub_sso_inactive_user'); return refuse(req, res, 401, 'account deactivated');
      } else if (user.locked_until && new Date(user.locked_until) > new Date()) {
        // The local lock is the store's own decision about this account; the hub does not override it
        // (authController.js:176-179 answers the same 423). Review P2-1.
        await client.query('ROLLBACK'); logger.warn('hub_sso_locked_user'); return refuse(req, res, 423, 'Account locked');
      }
      // What login records on success (authController.js:203-206): the counters and last_login are what an
      // offboarding / inactivity report reads, and a hub hop is a login.
      await client.query('UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login = NOW() WHERE id = $1', [user.id]);
      const roles = await loadRoles(user.id, client);

      // W8b — AN EXISTING USER IS NEVER RE-ROLED, AND NEVER SILENTLY.
      //
      // The store's own decision about an account outranks the hub's: a user the store demoted
      // (or promoted) keeps exactly the roles the store gave them, and a hop can neither raise
      // nor lower them. That was already true; what was missing is that it was INVISIBLE — a
      // store owner whose dashboard roles disagree with the hub's idea of their role had no way
      // to see it, and "why does my owner see nothing" had no trail to read. So when the roles
      // held differ from the roles the map would have created, write ONE audit row saying so.
      // Nothing is changed by it. A user whose roles already match the map writes no row, which
      // is what keeps the row meaningful (a log that always fires says nothing).
      if (!created) {
        const mapped = await mappedRoleName(client, hubRole);
        const held = roles.map((r) => r.name);
        if (mapped && !held.includes(mapped)) {
          await client.query(
            `INSERT INTO audit_logs (user_id, action, resource_type, resource, resource_id, new_values)
             VALUES ($1, 'HUB_SSO_ROLE_UNCHANGED', 'user', 'user', $1, $2)`,
            [user.id, JSON.stringify({ store_code: storeCode, hub_role: hubRole, mapped_role: mapped, held_roles: held })]);
          logger.info('hub_sso_role_divergence', { userId: user.id });
        }
      }

      await client.query(
        `INSERT INTO audit_logs (user_id, action, resource_type, resource, resource_id, new_values)
         VALUES ($1, 'HUB_SSO_LOGIN', 'user', 'user', $1, $2)`,
        [user.id, JSON.stringify({ store_code: storeCode, hub_role: hubRole, created })]);
      await client.query('COMMIT');
      outcome = { user, roles, created };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }

    // W6: the switcher list the hub SIGNED into this ticket. Validated here and parked on the session row; a list
    // this dashboard cannot read is dropped and the hop still succeeds (services/hubSession.js explains why).
    await issueSession(res, outcome.user, { ip: req.ip, userAgent: req.headers['user-agent'] || '', roles: outcome.roles, hubStores: sanitizeHubStores(payload.stores) });
    logger.info('hub_sso_ok', { userId: outcome.user.id, created: outcome.created });
    return res.redirect(302, nextPath);
  } catch (err) {
    logger.error('hub_sso_error', { error: err.message });
    next(err);
  }
});

export default router;
