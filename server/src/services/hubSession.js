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
// KNOWN LIMIT: after the SPA rotates the token through POST /auth/refresh, the new access token is minted by
// authController, which this lane may not touch (LANE-E-SSO.md), so it carries no mark and returns to the cached
// path. Closing that needs one line in authController's refresh handler — the lead's call.
// Any change to authController's cookie options must be repeated here; tests/hub-sso/hub-sso.mjs asserts the attributes.
import crypto from 'crypto';
import pool from '../config/db.js';
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
 * @param {{ip:string,userAgent:string,roles?:object[]}} ctx
 * @returns {Promise<{accessToken:string,user:object}>} the same object login answers with (authController.js:264-267)
 */
export const issueSession = async (res, user, { ip, userAgent, roles }) => {
  const userRoles = roles ?? await loadRoles(user.id);
  const tokenId = crypto.randomUUID();
  const refreshToken = signRefreshToken({ userId: user.id, tokenId });
  // The session row FIRST: its id goes into the access token, which is what makes the session revocable per request.
  const session = await createSession(user.id, refreshToken, ip, userAgent || '');
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

/** True while the sessions row this token was issued for still exists, belongs to the user and has not expired. */
export const hubSessionIsLive = async (sid, userId, client = pool) => {
  if (typeof sid !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(sid)) return false;
  const { rows } = await client.query(
    'SELECT 1 FROM sessions WHERE id = $1 AND user_id = $2 AND expires_at > NOW()',
    [sid, userId],
  );
  return rows.length === 1;
};

export default { issueSession, setAccessCookie, setRefreshCookie, loadRoles, peekHubSsoClaims, hubSessionIsLive };
