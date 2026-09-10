// HUB SSO EXCHANGE (S1-4) — the hub authenticated the operator (password + TOTP), minted a 30 s ticket signed with THIS
// store's own HUB_SSO_SECRET, and posted the browser here. We exchange it for the dashboard's OWN session (same cookies,
// same token as /auth/login) and 302 into the SPA. No cookie or CORS change: the ticket is the only credential on this
// request, and the cookies we set are first-party for every request the SPA makes afterwards.
//
// TRUST MODEL
//  • Dark unless HUB_SSO_ENABLED === '1' (read per request, R7): anything else is a 404, and nothing is read or written.
//  • HUB_SSO_SECRET is per store, set by the hub, env only. Signature = HMAC-SHA256 over the EXACT payload bytes received,
//    compared with timingSafeEqual. A missing secret is a 503 that names the key, never an HMAC under an empty key.
//  • Audience: ticket.store_code must equal STORE_CODE. A ticket for another store is refused before anything is written.
//  • Time: exp (unix seconds) with 30 s clock skew; a ticket claiming more than TTL_CEILING_S of life is refused (a bug
//    on the minting side cannot issue a long-lived one).
//  • Single use: the nonce is burned in hub_sso_used_tickets under its primary key inside the same transaction that
//    creates the user/session; two parallel exchanges cannot both win.
//  • JIT: an unknown email is created with the role hub_role_map gives the hub role, else the '*' fallback (least
//    privileged). An existing user is never re-roled. An inactive user is refused.
//  • `next` must be a relative path ('/x', not '//x', not '/\x', not a scheme) or the request is a 400 before any write.
//  • Nothing here calls the hub, or anything, over the network: with the hub gone every store still logs in on its own.
//  • Logs never carry the ticket, the signature, the nonce or the secret.
import { Router } from 'express';
import crypto from 'node:crypto';
import pool from '../config/db.js';
import logger from '../utils/logger.js';
import { hashPassword } from '../utils/hash.js';
import { authRateLimiter } from '../middleware/rateLimiter.js';
import { issueSession, loadRoles } from '../services/hubSession.js';

const router = Router();

export const SKEW_S = 30;
export const TTL_CEILING_S = 120;
const USED_TICKET_RETENTION = '1 day';

const b64uDecode = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const isB64u = (s) => typeof s === 'string' && s.length > 0 && /^[A-Za-z0-9_-]+$/.test(s);

/** Only a path inside the SPA. '//host' is protocol-relative and '/\host' is read the same way by browsers. */
export function safeNext(raw) {
  if (raw === undefined || raw === null || raw === '') return '/';
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return null;
  return raw;
}

const refuse = (res, status, error) => res.status(status).json({ error });

router.post('/exchange', authRateLimiter, async (req, res, next) => {
  try {
    if (process.env.HUB_SSO_ENABLED !== '1') return res.status(404).json({ error: 'Not found' });
    const secret = (process.env.HUB_SSO_SECRET || '').trim();
    if (!secret) return refuse(res, 503, 'hub_sso_not_configured: HUB_SSO_SECRET is not set on this service');
    const storeCode = (process.env.STORE_CODE || '').trim();
    if (!storeCode) return refuse(res, 503, 'hub_sso_not_configured: STORE_CODE is not set on this service');

    const nextPath = safeNext(req.body?.next);
    if (nextPath === null) return refuse(res, 400, 'next must be a relative path');

    const ticket = req.body?.ticket;
    if (typeof ticket !== 'string' || !ticket.includes('.')) return refuse(res, 400, 'malformed ticket');
    const [p64, s64, extra] = ticket.split('.');
    if (extra !== undefined || !isB64u(p64) || !isB64u(s64)) return refuse(res, 400, 'malformed ticket');
    const bytes = b64uDecode(p64);
    const got = b64uDecode(s64);
    const want = crypto.createHmac('sha256', secret).update(bytes).digest();
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
      logger.warn('hub_sso_bad_signature');
      return refuse(res, 401, 'bad ticket');
    }
    let payload;
    try { payload = JSON.parse(bytes.toString('utf8')); } catch { return refuse(res, 400, 'malformed ticket'); }
    if (!payload || typeof payload !== 'object') return refuse(res, 400, 'malformed ticket');
    const email = String(payload.email || '').trim().toLowerCase();
    const { exp, nonce } = payload;
    const hubRole = typeof payload.role === 'string' ? payload.role : '';
    if (!email || typeof payload.store_code !== 'string' || typeof exp !== 'number' || !Number.isFinite(exp) || typeof nonce !== 'string' || !nonce) {
      return refuse(res, 400, 'incomplete ticket');
    }
    if (payload.store_code !== storeCode) {
      logger.warn('hub_sso_wrong_store');
      return refuse(res, 401, 'ticket is for another store');
    }
    const now = Date.now() / 1000;
    if (exp + SKEW_S < now) return refuse(res, 401, 'ticket expired');
    if (exp - now > TTL_CEILING_S) { logger.warn('hub_sso_ttl_too_long'); return refuse(res, 401, 'ticket ttl too long'); }

    const client = await pool.connect();
    let outcome;
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM hub_sso_used_tickets WHERE exp < NOW() - INTERVAL '${USED_TICKET_RETENTION}'`);
      const burn = await client.query('INSERT INTO hub_sso_used_tickets (nonce, exp) VALUES ($1, to_timestamp($2)) ON CONFLICT (nonce) DO NOTHING', [nonce, exp]);
      if (burn.rowCount === 0) { await client.query('ROLLBACK'); logger.warn('hub_sso_ticket_replayed'); return refuse(res, 401, 'ticket already used'); }

      const found = await client.query('SELECT * FROM users WHERE lower(email) = $1', [email]);
      let user = found.rows[0] || null;
      let created = false;
      if (!user) {
        // JIT: role from hub_role_map, else the '*' fallback; the role NAME must exist or nothing is created.
        const map = await client.query('SELECT hub_role, dashboard_role FROM hub_role_map WHERE hub_role = $1 OR hub_role = $2', [hubRole, '*']);
        const mapped = map.rows.find((r) => r.hub_role === hubRole) || map.rows.find((r) => r.hub_role === '*');
        if (!mapped) { await client.query('ROLLBACK'); return refuse(res, 403, 'hub_role_map has no entry for this role and no "*" fallback'); }
        const role = await client.query('SELECT id, name FROM roles WHERE name = $1', [mapped.dashboard_role]);
        if (!role.rows[0]) { await client.query('ROLLBACK'); return refuse(res, 403, `dashboard role ${mapped.dashboard_role} does not exist`); }
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
        await client.query('ROLLBACK'); logger.warn('hub_sso_inactive_user'); return refuse(res, 401, 'account deactivated');
      }
      const roles = await loadRoles(user.id, client);
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

    await issueSession(res, outcome.user, { ip: req.ip, userAgent: req.headers['user-agent'] || '', roles: outcome.roles });
    logger.info('hub_sso_ok', { userId: outcome.user.id, created: outcome.created });
    return res.redirect(302, nextPath);
  } catch (err) {
    logger.error('hub_sso_error', { error: err.message });
    next(err);
  }
});

export default router;
