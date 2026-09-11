// Issues the dashboard's OWN session for an already-verified user, exactly the way authController.login does.
// authController exports no session helper and must not be touched (LANE-E-SSO.md), so this file MIRRORS it line for line:
//   cookies        authController.js:37-45 (accessToken) and :47-55 (refreshToken), incl. the `secure` rule and maxAge
//   roles query    authController.js:213-225
//   tokens         authController.js:228-238 (access: userId/email/roles; refresh: userId/tokenId)
//   sessions row   authController.js:241-243 via authService.createSession
//   userData shape authController.js:246-254
// Not mirrored: the Redis session-cache write (authController.js:255-256). It is an optimisation with a DB fallback
// (middleware/auth.js:99-145 re-verifies on a cache miss), so the outcome for the caller is identical.
//
// REVOCATION, NO GRACE (lead's decision on review P1-4 / plan S1-4 line A4). A session minted here is marked in its
// access token with `hub_sso: true` and `sid` = the id of its `sessions` row. `authenticate` sees the mark, skips the
// 5-minute session cache entirely (no read, no write) and re-reads Postgres on EVERY request, refusing as soon as the
// sessions row is gone (logout, "log out other devices", an admin revoke) or the user is inactive. Cost: one extra
// query per hub-SSO request. The alternative (a 60 s cache TTL) would leave a removed operator inside a store for up
// to a minute, which is the window the plan's A4 line exists to close.
// THE MARK SURVIVES A REFRESH (Lane H1 closed Lane E2's KNOWN LIMIT). The rotation in authController.refresh used to
// mint an unmarked token, so ~15 minutes after a hop the session fell back to the cached path and a revoke stopped
// biting. It cannot read the mark off the ACCESS token: that cookie's maxAge is 15 minutes, so by the time the SPA
// refreshes the browser has usually dropped it. So the mark is also signed into the REFRESH token here, where
// authController.refresh reads it back VERIFIED (not peeked) and carries it onto the token it mints, with the sid of
// the NEW session row. See tests/hub-sso/refresh-claims.mjs.
// Any change to authController's cookie options must be repeated here; tests/hub-sso/hub-sso.mjs asserts the attributes.
import crypto from 'crypto';
import pool from '../config/db.js';
import logger from '../utils/logger.js';
import env from '../config/env.js';
import { signAccessToken, signRefreshToken } from '../utils/jwt.js';
import { createSession } from '../services/authService.js';

const REFRESH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days   (authController.js:29)
const ACCESS_COOKIE_MAX_AGE = 15 * 60 * 1000;           // 15 minutes (authController.js:30)

export const setAccessCookie = (res, token) => {
  res.cookie('accessToken', token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: ACCESS_COOKIE_MAX_AGE,
  });
};

export const setRefreshCookie = (res, token) => {
  res.cookie('refreshToken', token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/v1/auth',
    maxAge: REFRESH_COOKIE_MAX_AGE,
  });
};

// ── W6/W6b: the switcher list the hub signed into the ticket ────────────────────────────────────────────
// The hub knows which stores this operator may hop into; the dashboard must never guess, and must never take
// the list from the browser. It arrives INSIDE the HMAC-signed ticket and is parked on the session row
// (migration 132), which is the row middleware/auth.js already re-reads on every hub-SSO request.
//
// FAIL SOFT, NEVER REFUSE: an entry this dashboard cannot make sense of is dropped, and the hop still succeeds.
// Losing a dropdown is a cosmetic failure; refusing the ticket would lock an operator out of a live store.
//
// W6b CLOSES W6's DEVIATION 6. Validation is PER ENTRY: a bad entry is SKIPPED and the rest of the list is
// kept. W6 dropped the whole list on one bad entry, which meant one odd store could cost an operator every
// other store's row, silently. A partially-trusted list is not a thing — but each entry is validated whole,
// so what survives is fully trusted; nothing is repaired, only kept or dropped.
//
// CODE GRAMMAR, DELIBERATELY WIDER THAN THIS STORE'S OWN. Entries in the LIST match ^[A-Z0-9]{1,8}$, which is
// the HUB's grammar (store-hub src/repo/scope.js STORE_CODE_RE): the hub is the authority on what a store code
// is, and this dashboard is only rendering the hub's answer. This store's OWN identity (env STORE_CODE,
// server/migrations/run.js) is unchanged and still 2-4 characters — the two are different questions, and
// under W6 the narrower one silently deleted any hub store outside 2-4 characters from the dropdown.
//
// Strict on the way in, because what goes in comes back out to a browser: exactly the four known keys, a code
// shaped like a HUB store code, a name of at most 80 characters, a role of at most 24 (a LABEL for a pill,
// never a permission — every gate is taken at the hub), and a boolean can_hop. `role` and `can_hop` are
// OPTIONAL: a W6 ticket carries neither, and defaults to role '' (no pill) and can_hop true (the W6 claim
// listed only hoppable stores). At most 50 entries; a longer list is CUT, not refused (the hub caps at 50 too).
export const HUB_STORES_MAX = 50;
export const HUB_STORE_NAME_MAX = 80;
export const HUB_STORE_ROLE_MAX = 24;
const HUB_STORE_CODE_RE = /^[A-Z0-9]{1,8}$/;
const HUB_STORE_KEYS = new Set(['code', 'name', 'role', 'can_hop']);

/** @returns {{code:string,name:string,role:string,can_hop:boolean}|null} the entry to keep, or null to skip it. */
const sanitizeHubStore = (entry) => {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const keys = Object.keys(entry);
  if (!keys.includes('code') || !keys.includes('name')) return null;
  if (keys.some((k) => !HUB_STORE_KEYS.has(k))) return null;          // an unknown key is an unknown contract
  const { code, name, role, can_hop: canHop } = entry;
  if (typeof code !== 'string' || !HUB_STORE_CODE_RE.test(code)) return null;
  if (typeof name !== 'string' || name.length === 0 || name.length > HUB_STORE_NAME_MAX) return null;
  if (role !== undefined && (typeof role !== 'string' || role.length > HUB_STORE_ROLE_MAX)) return null;
  if (canHop !== undefined && typeof canHop !== 'boolean') return null;
  return { code, name, role: role ?? '', can_hop: canHop ?? true };
};

/** @returns {{code:string,name:string,role:string,can_hop:boolean}[]} [] whenever the CLAIM itself is not a list. */
export const sanitizeHubStores = (claim) => {
  if (!Array.isArray(claim)) return [];
  const out = [];
  for (const entry of claim.slice(0, HUB_STORES_MAX)) {
    const keep = sanitizeHubStore(entry);
    if (keep) out.push(keep);
  }
  return out;
};

/** Roles in the shape login puts into the JWT (authController.js:213-225). Uses the given client so it can run inside a transaction. */
export const loadRoles = async (userId, client = pool) => {
  const rolesResult = await client.query(
    `SELECT r.id, r.name, r.permissions
       FROM roles r
       INNER JOIN user_roles ur ON r.id = ur.role_id
      WHERE ur.user_id = $1`,
    [userId],
  );
  return rolesResult.rows.map((r) => ({ id: r.id, name: r.name, permissions: r.permissions }));
};

/**
 * @param {import('express').Response} res
 * @param {{id:string,email:string,first_name:string,last_name:string,must_change_password:boolean,email_verified:boolean}} user  a users row
 * @param {{ip:string,userAgent:string,roles?:object[],hubStores?:{code:string,name:string}[]}} ctx
 * @returns {Promise<{accessToken:string,user:object}>} the same object login answers with (authController.js:264-267)
 */
export const issueSession = async (res, user, { ip, userAgent, roles, hubStores }) => {
  const userRoles = roles ?? await loadRoles(user.id);
  const tokenId = crypto.randomUUID();
  // hub_sso on the REFRESH token as well: it is the only credential the SPA still holds when the 15-minute
  // access cookie has expired, so it is what tells authController.refresh to keep marking the rotated token.
  const refreshToken = signRefreshToken({ userId: user.id, tokenId, hub_sso: true });
  // The session row FIRST: its id goes into the access token, which is what makes the session revocable per request.
  const session = await createSession(user.id, refreshToken, ip, userAgent || '');
  // W6: the switcher list belongs to THIS session, not to the user and not to the token (see migration 132).
  await writeHubStores(session.id, hubStores);
  const accessToken = signAccessToken({ userId: user.id, email: user.email, roles: userRoles, hub_sso: true, sid: session.id });
  const userData = {
    id: user.id,
    email: user.email,
    firstName: user.first_name,
    lastName: user.last_name,
    roles: userRoles,
    mustChangePassword: user.must_change_password,
    emailVerified: user.email_verified,
  };
  setAccessCookie(res, accessToken);
  setRefreshCookie(res, refreshToken);
  return { accessToken, user: userData };
};

/**
 * Read the hub-SSO mark out of an access token WITHOUT verifying it. Used only to route a request onto the
 * STRICTER (uncached, re-verified) path in middleware/auth.js, so a forged mark costs the forger a database read and
 * buys nothing: the token itself is still verified there before anything is trusted.
 * @returns {{hub_sso:true, sid:unknown}|null}
 */
export const peekHubSsoClaims = (token) => {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    const claims = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return claims && claims.hub_sso === true ? { hub_sso: true, sid: claims.sid } : null;
  } catch {
    return null;
  }
};

/**
 * Parks the list on a session row. FAIL SOFT, on purpose and in two directions:
 *  • this runs INSIDE a login. A dropdown that cannot be stored must never cost an operator a live store.
 *  • a service running this code against a database that has not had migration 132 yet (a rollback, or a
 *    preDeployCommand that did not run) gets one warning per session, not a 500 on the SSO door.
 */
const writeHubStores = async (sessionId, stores, client = pool) => {
  const list = sanitizeHubStores(stores);
  try {
    await client.query('UPDATE sessions SET hub_stores = $2 WHERE id = $1', [sessionId, JSON.stringify(list)]);
  } catch (e) {
    logger.warn('hub_stores_not_stored', { code: e.code });     // 42703 = migration 132 has not run here yet
    return [];
  }
  return list;
};

/**
 * The live sessions row for a hub-SSO token, or null when it is gone / not this user's / expired.
 * ONE query answers both questions middleware/auth.js has: is this session still valid (revocation, no grace
 * period) and what switcher list did it arrive with. Reading the list is therefore free.
 */
export const loadHubSession = async (sid, userId, client = pool) => {
  if (typeof sid !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(sid)) return null;
  // `to_jsonb(s.*)->'hub_stores'` instead of naming the column: on a database that has not had migration 132
  // the key is simply absent (null), where `SELECT hub_stores` would throw and 401 every hub session on the store.
  const { rows } = await client.query(
    "SELECT id, to_jsonb(s.*)->'hub_stores' AS hub_stores FROM sessions s WHERE s.id = $1 AND s.user_id = $2 AND s.expires_at > NOW()",
    [sid, userId],
  );
  return rows.length === 1 ? rows[0] : null;
};

/** True while the sessions row this token was issued for still exists, belongs to the user and has not expired. */
export const hubSessionIsLive = async (sid, userId, client = pool) => Boolean(await loadHubSession(sid, userId, client));

/**
 * Rotation (authController.refresh) DELETES the old session row and creates a new one, so without this the
 * switcher would quietly disappear ~15 minutes after every hop. Carries the list the hub signed, nothing else.
 */
export const carryHubStores = async (stores, toSessionId, client = pool) => writeHubStores(toSessionId, stores, client);

export default { issueSession, setAccessCookie, setRefreshCookie, loadRoles, peekHubSsoClaims, hubSessionIsLive, loadHubSession, carryHubStores, sanitizeHubStores };
