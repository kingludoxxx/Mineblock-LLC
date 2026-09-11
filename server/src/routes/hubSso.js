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
//    privileged; W8b: the map's seeded targets are the PAGE roles, migration 133). The row is stamped
//    created_via = 'hub_sso' (W8f, migration 135) — provenance only, never a permission, never sent to a client.
//    An existing user is never re-roled in either direction — and since W8b a disagreement between what the hub
//    thinks this operator is and what the store gave them is written to audit_logs as HUB_SSO_ROLE_UNCHANGED
//    instead of being invisible. W8f adds the ONE exception, and only to undo a bug this codebase shipped: a user
//    THE HUB ITSELF CREATED, holding EXACTLY migration 126's broken default ('Admin', which opens no page) and
//    nothing else, who has never become a local account, is moved ONCE onto the role the CURRENT map gives their
//    hub role and the move is audited as HUB_SSO_ROLE_UPGRADED with the old and new roles. Every other user keeps
//    the old behaviour exactly. W8g is WHAT MAKES "ONCE" TRUE: the repair stamps the row it repairs
//    (created_via = 'hub_sso_repaired'), so a repaired user is never a candidate again — after it, the store's
//    own role decision is final and a re-pointed hub_role_map cannot reach them. It also takes the user row
//    FOR UPDATE before deciding (concurrent hops used to double-write), and refuses to spend a user's one repair
//    on a ticket whose hub role the map does not name. See the block above upgradeStrandedHubUser().
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
 *
 * W8g — IT ALSO REPORTS *WHICH* ROW ANSWERED. `exact` is true only when the map names this hub role
 * itself, false when the '*' fallback answered. The JIT path does not care (a new user on an unknown
 * role is meant to land on the least-privileged role), but the W8f repair does: see U1 in the block
 * below. `{ name: null, exact: false }` when the map answers nothing at all.
 *
 * @returns {Promise<{name: string|null, exact: boolean}>}
 */
async function mappedRole(client, hubRole) {
  const { rows } = await client.query(
    'SELECT hub_role, dashboard_role FROM hub_role_map WHERE hub_role = $1 OR hub_role = $2', [hubRole, '*']);
  const own = rows.find((r) => r.hub_role === hubRole);
  const hit = own || rows.find((r) => r.hub_role === '*');
  return { name: hit ? hit.dashboard_role : null, exact: Boolean(own) };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// W8f — THE ONE-TIME REPAIR OF A USER STRANDED ON MIGRATION 126's MAP.
//
// THE DEFECT, measured live 2026-09-11 14:41Z on the MB and SB databases: migration 126 seeded
// `owner -> 'Admin'`, and 'Admin' is the platform's USER-TABLE administrator — it carries not one of
// the page keys migration 031 seeds. A hub owner created by a hop before 2026-09-11 therefore lands
// on an empty sidebar and a locked KPI card. Migrations 133/134 fixed the MAP; by design they do not
// re-role a user that already exists, so those users are still stranded.
//
// W8b's rule — AN EXISTING USER IS NEVER RE-ROLED — is not being repealed. It is being given its one
// exception, and the exception is written so narrowly that it can only ever undo a bug this codebase
// shipped itself. All THREE of these must hold, and anything outside them keeps the old behaviour
// (untouched, HUB_SSO_ROLE_UNCHANGED):
//
// W8g — WHAT MAKES "ONCE" TRUE IS THE LATCH, NOT THE PREDICATE (REVIEW-W8F P0-1).
// As W8f shipped it, NOTHING recorded that the repair had already run: created_via stayed 'hub_sso'
// and the product's own role endpoints (teamController.changeTeamMemberRole,
// userController.assignRole) write user_roles and never name users.updated_at, so (c4) stayed true
// forever. Measured, four rounds: a store administrator who set the user back to exactly 'Admin' was
// silently overridden on the very next hop, every time, toward MORE privilege (Admin carries no page
// key; 'Hub Owner' carries kpi-system:access). So the repair now STAMPS THE ROW IT REPAIRS —
// created_via = 'hub_sso_repaired', a value (a) does not match — in the same transaction, one
// statement before the role move, guarded on the old value. After it the row is not a candidate
// again for any reason: not a demotion, not a re-pointed map, not a hundred hops.
//
//   (a) THE HUB CREATED THIS ROW.  users.created_via = 'hub_sso' (migration 135; set below on every
//       JIT creation from now on, and backfilled by 135 off the HUB_SSO_JIT_CREATE audit row).
//   (b) THEY HOLD EXACTLY MIGRATION 126's DEFAULT AND NOTHING ELSE.  One role, named 'Admin'. That is
//       the value the broken map wrote, and a user holding it ALONGSIDE anything else is a user the
//       store has since made a decision about — left alone.
//   (c) THEY HAVE NEVER BECOME A LOCAL ACCOUNT.  Five facts, each of which the schema can answer, and
//       every one of them fails CLOSED. The reasoning is written out in full in migration 135's
//       header; the short form is: the invite flow never touched this row, must_change_password is
//       false (both creators of a store's own SuperAdmin set it TRUE — this is the guard that keeps a
//       SuperAdmin out even if everything else somehow matched), no password reset is in flight,
//       `updated_at <= created_at` so the row has not been written since the hub created it (every
//       local password path names updated_at - authService.updatePassword:85 and forgotPassword:435;
//       the hub's own hop deliberately does not, and `users`
//       has no updated_at trigger on this schema), and last_login is not later than the newest
//       HUB_SSO_LOGIN row, so no login was served by this store's own front door.
//
// SCOPE, DELIBERATE: only 'Admin'. Migration 126 also mapped operator/editor onto 'Manager', which is
// equally page-less, but the defect measured on the live databases is the OWNER, and a repair that
// moves more rows than the one that was measured is not a repair. A 'Manager' row is left to a lane
// that measures one.
//
// W8g — TWO MORE THINGS THE REPAIR REFUSES TO DO (REVIEW-W8F P1-1, P2-3):
//
//   U1  A TICKET WHOSE HUB ROLE THE MAP DOES NOT NAME NEVER SPENDS THE REPAIR. hub_role_map's '*'
//       row is the right answer for a NEW user (land them on the least-privileged role), but for a
//       stranded one it was a trap: the user was moved onto the fallback, 'Viewer', and a later
//       GENUINE owner hop could not restore them — they no longer held 'Admin', so (b) refused, and
//       the one-shot repair had been spent by one malformed ticket. Measured. The repair therefore
//       requires an EXACT map hit; an unknown hub role leaves the user exactly as they were and takes
//       the HUB_SSO_ROLE_UNCHANGED path, which is visible in the audit log. Not latching would NOT
//       have fixed this: the user would still be off 'Admin' and still fail (b).
//   L1  CONCURRENT HOPS FOR THE SAME USER SERIALISE. The predicate used to be read without a lock, so
//       two exchanges both passed it on snapshots taken before either committed: 20/20 same-role
//       races wrote TWO upgrade rows, and 20/20 different-role races left the user holding the UNION
//       of both roles (["Hub Owner","Viewer"]), which no map entry authorises. The exchange now takes
//       `SELECT … FOR UPDATE` on the user row BEFORE reading the predicate, so the second hop waits,
//       then reads the latched row and declines. The lock is taken for EVERY existing user, not only
//       candidates, so the divergence path is serialised too.
//
// NOTHING NEW IS EXPOSED TO THE CLIENT: created_via is read here and nowhere else, and the only thing
// that reaches the browser is the session it already got — with the roles it should have had.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Migration 126's seeded target for hub `owner` / `admin`: the account-administration role. */
export const LEGACY_126_DEFAULT_ROLE = 'Admin';

/** W8f's provenance value: the hub created this row and the repair has NOT run on it yet. */
export const CREATED_VIA_HUB_SSO = 'hub_sso';

/**
 * W8g — THE LATCH. Written by the repair onto the row it repairs, in the same transaction. It is
 * deliberately a value (a) does not match, so a repaired row can never be a candidate again; and it
 * is deliberately still recognisable as hub provenance, so nobody reading the column loses the fact.
 */
export const CREATED_VIA_HUB_SSO_REPAIRED = 'hub_sso_repaired';

/**
 * (a) + (b) + (c) as ONE predicate, so the census script and the exchange cannot drift apart.
 * $1 = the legacy role name. Add `AND u.id = $2` to ask it about a single user.
 * MUST be evaluated BEFORE this request's `last_login = NOW()` write, or (c5) reads its own footprint.
 * MUST be evaluated with the user row held (`SELECT … FOR UPDATE`), or two hops both pass it (W8g).
 *
 * W8g — (a) NOW MEANS "HUB-CREATED *AND* NOT YET REPAIRED": the repair stamps 'hub_sso_repaired',
 * which this equality does not match, and that is the whole mechanism behind the word ONCE.
 * W8g — (d) is new (REVIEW-W8F P2-1): the exchange refuses a deactivated user with a 401 and a locked
 * one with a 423 BEFORE the repair is ever reached, so a predicate that listed them was telling the
 * census script about users the exchange would turn away. The rule and the door now agree.
 */
export const REMAP_CANDIDATE_SQL = `
  SELECT u.id, u.email
    FROM users u
   WHERE u.created_via = 'hub_sso'                                    -- (a) hub-created, not yet repaired
     AND u.is_active = true                                           -- (d) the exchange answers 401 otherwise
     AND (u.locked_until IS NULL OR u.locked_until <= NOW())           -- (d) the exchange answers 423 otherwise
     AND u.invited_at IS NULL AND u.invited_by IS NULL                -- (c1) never invited by the store
     AND u.must_change_password = false                               -- (c2) not a SuperAdmin-shaped row
     AND u.password_reset_token IS NULL
     AND u.password_reset_expires IS NULL                             -- (c3) no local claim in flight
     AND u.updated_at <= u.created_at                                 -- (c4) untouched since creation
     AND (u.last_login IS NULL OR u.last_login <= (                   -- (c5) every login was a hub hop
           SELECT max(a.created_at) FROM audit_logs a
            WHERE a.resource_id = u.id AND a.resource_type = 'user'
              AND a.action = 'HUB_SSO_LOGIN'))
     AND (SELECT count(*) FROM user_roles ur WHERE ur.user_id = u.id) = 1          -- (b) exactly one role
     AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                  WHERE ur.user_id = u.id AND r.name = $1)                         -- (b) and it is that one
`;

/**
 * Move a stranded hub user onto the role the CURRENT map gives their ticket's hub role, once.
 *
 * THE POSTGRES TRAP THIS IS SHAPED AROUND: a failed statement inside a transaction aborts the WHOLE
 * transaction, and the later COMMIT silently behaves as a ROLLBACK — no error, no exception, the work
 * simply gone. The re-map and its audit row share this route's one transaction, so the OPTIONAL half
 * (the audit row) is wrapped in SAVEPOINT / ROLLBACK TO SAVEPOINT: an audit row that cannot be written
 * costs the audit row and says so loudly, never the repair, and never the hop.
 *
 * THE CALLER MUST ALREADY HOLD THE USER ROW (`SELECT … FOR UPDATE`). Everything below reads and then
 * writes the same row, so without the lock two concurrent hops both pass the predicate — measured,
 * 20/20 different-role races left the user holding two roles (REVIEW-W8F P1-1).
 *
 * @param {boolean} mappedExact whether hub_role_map names this ticket's hub role ITSELF. The '*'
 *   fallback is right for a new user and wrong here: it would move a stranded user onto 'Viewer' and
 *   spend the one repair they get (REVIEW-W8F P2-3).
 * @returns {Promise<boolean>} true when the roles were actually changed.
 */
async function upgradeStrandedHubUser(client, { user, mappedName, mappedExact, held, storeCode, hubRole }) {
  // U1: an unknown hub role leaves the user exactly as they are, with their repair still available.
  if (!mappedExact) { logger.info('hub_sso_remap_skipped_unknown_hub_role', { userId: user.id }); return false; }

  const { rows } = await client.query(`${REMAP_CANDIDATE_SQL} AND u.id = $2`, [LEGACY_126_DEFAULT_ROLE, user.id]);
  if (rows.length !== 1) return false;

  // The mapped name must exist, exactly as the JIT branch demands: a dangling name would leave the
  // user with NO role at all, which is worse than the stranded state we are repairing.
  const role = await client.query('SELECT id, name FROM roles WHERE name = $1', [mappedName]);
  if (!role.rows[0]) return false;

  // ── THE LATCH (W8g / REVIEW-W8F P0-1) ───────────────────────────────────────────────────────────
  // Stamped BEFORE the role move and in the same transaction, so the repair is structurally once-only
  // even if everything else about the row stays repair-shaped: the store's own role endpoints write
  // user_roles and never touch users.updated_at, so (c4) would otherwise stay true forever and every
  // later hop would re-force the mapped role over the store's decision. `AND created_via = 'hub_sso'`
  // makes it a compare-and-set: if the value has moved under us there is nothing to repair, and we
  // must not write roles either. (Belt and braces — the caller's row lock already serialises this.)
  const latch = await client.query(
    'UPDATE users SET created_via = $2 WHERE id = $1 AND created_via = $3',
    [user.id, CREATED_VIA_HUB_SSO_REPAIRED, CREATED_VIA_HUB_SSO]);
  if (latch.rowCount !== 1) { logger.warn('hub_sso_remap_latch_lost', { userId: user.id }); return false; }

  // (b) guarantees there is exactly one row to replace.
  await client.query('DELETE FROM user_roles WHERE user_id = $1', [user.id]);
  await client.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [user.id, role.rows[0].id]);

  try {
    await client.query('SAVEPOINT hub_sso_upgrade_audit');
    await client.query(
      `INSERT INTO audit_logs (user_id, action, resource_type, resource, resource_id, old_values, new_values)
       VALUES ($1, 'HUB_SSO_ROLE_UPGRADED', 'user', 'user', $1, $2, $3)`,
      [user.id,
        JSON.stringify({ roles: held }),
        JSON.stringify({
          roles: [role.rows[0].name], store_code: storeCode, hub_role: hubRole,
          created_via: CREATED_VIA_HUB_SSO_REPAIRED,
          reason: 'migration 126 default role, repaired by W8f, latched by W8g (once per user, ever)',
        })]);
    await client.query('RELEASE SAVEPOINT hub_sso_upgrade_audit');
  } catch (e) {
    // ROLLBACK TO SAVEPOINT is what keeps the failed INSERT from turning the COMMIT into a ROLLBACK.
    await client.query('ROLLBACK TO SAVEPOINT hub_sso_upgrade_audit');
    await client.query('RELEASE SAVEPOINT hub_sso_upgrade_audit');
    logger.error('hub_sso_role_upgrade_not_audited', { userId: user.id, code: e.code });
  }
  logger.info('hub_sso_role_upgraded', { userId: user.id });
  return true;
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
      // W8f — HAS MIGRATION 135 RUN ON *THIS* DATABASE? Free: `SELECT *` describes its columns even when it
      // matched no row. A service booted against a database that has not had 135 (a rollback, a
      // preDeployCommand that did not run) must still let its operators in — the SSO door is not the place
      // to discover a missing column, which is the same rule services/hubSession.js takes for migration 132.
      // Without the column there is no provenance, so the repair below cannot be safe and is not attempted.
      const hasCreatedVia = (found.fields || []).some((f) => f.name === 'created_via');
      if (!hasCreatedVia) logger.warn('hub_sso_created_via_missing');
      if (!user) {
        // JIT: role from hub_role_map, else the '*' fallback; the role NAME must exist or nothing is created.
        // A NEW user on an unknown hub role still lands on the '*' role — unchanged, and deliberate.
        const { name: mappedName } = await mappedRole(client, hubRole);
        if (!mappedName) { await client.query('ROLLBACK'); return refuse(req, res, 403, 'hub_role_map has no entry for this role and no "*" fallback'); }
        const role = await client.query('SELECT id, name FROM roles WHERE name = $1', [mappedName]);
        if (!role.rows[0]) { await client.query('ROLLBACK'); return refuse(req, res, 403, `dashboard role ${mappedName} does not exist`); }
        // An unusable password: random 32 bytes, bcrypt-hashed. The user logs in through the hub (or resets via forgot-password).
        const unusable = await hashPassword(crypto.randomBytes(32).toString('hex'));
        // W8f: created_via records that THIS path made the row (migration 135). Provenance only —
        // never a permission, never sent to a client — and the one fact the repair below cannot infer.
        const ins = await client.query(
          hasCreatedVia
            ? `INSERT INTO users (email, password_hash, first_name, last_name, is_active, email_verified, created_via)
               VALUES ($1, $2, '', '', true, true, 'hub_sso') RETURNING *`
            : `INSERT INTO users (email, password_hash, first_name, last_name, is_active, email_verified)
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
      // W8f — THE REPAIR RUNS BEFORE THE last_login WRITE, DELIBERATELY.
      // Its (c5) test asks whether every login this user has had was a hub hop, by comparing
      // users.last_login with the newest HUB_SSO_LOGIN audit row. The UPDATE below sets last_login to
      // THIS transaction's timestamp while this hop's own HUB_SSO_LOGIN row is not written until the
      // end, so evaluating the predicate after it would have the request read its own footprint and
      // refuse every user. Order is load-bearing; server/tests/hub-sso/w8f-jit-remap.mjs R3 is the
      // test that bites if it moves.
      if (!created) {
        // W8g / REVIEW-W8F P1-1 — TAKE THE ROW BEFORE READING ANYTHING ABOUT IT.
        // READ COMMITTED gives every statement its own snapshot, so two hops for the same user both
        // passed the predicate on snapshots taken before either committed, and the second one's
        // `DELETE FROM user_roles` could not see the row the first had inserted: 20/20 different-role
        // races ended with the user holding the UNION of both tickets' roles. The lock is taken for
        // EVERY existing user — the divergence path writes an audit row about the roles held, and
        // that read has to be serialised with the repair too. The later `UPDATE users SET
        // last_login = NOW()` locks the same row, so this only moves an acquisition the exchange was
        // already going to make, and both hops take it in the same order: no new deadlock.
        await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [user.id]);

        const { name: mapped, exact: mappedExact } = await mappedRole(client, hubRole);
        const held = (await loadRoles(user.id, client)).map((r) => r.name);
        if (mapped && !held.includes(mapped)) {
          const upgraded = hasCreatedVia
            && await upgradeStrandedHubUser(client, { user, mappedName: mapped, mappedExact, held, storeCode, hubRole });
          if (!upgraded) {
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
            await client.query(
              `INSERT INTO audit_logs (user_id, action, resource_type, resource, resource_id, new_values)
               VALUES ($1, 'HUB_SSO_ROLE_UNCHANGED', 'user', 'user', $1, $2)`,
              [user.id, JSON.stringify({ store_code: storeCode, hub_role: hubRole, mapped_role: mapped, held_roles: held })]);
            logger.info('hub_sso_role_divergence', { userId: user.id });
          }
        }
      }

      // What login records on success (authController.js:203-206): the counters and last_login are what an
      // offboarding / inactivity report reads, and a hub hop is a login.
      await client.query('UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login = NOW() WHERE id = $1', [user.id]);
      // AFTER the repair, so the session this hop issues carries the roles the user should have had.
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
