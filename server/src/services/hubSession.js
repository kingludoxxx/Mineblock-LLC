// Issues the dashboard's OWN session for an already-verified user, exactly the way authController.login does.
// authController exports no session helper and must not be touched (LANE-E-SSO.md), so this file MIRRORS it line for line:
//   cookies        authController.js:37-45 (accessToken) and :47-55 (refreshToken), incl. the `secure` rule and maxAge
//   roles query    authController.js:213-225
//   tokens         authController.js:228-238 (access: userId/email/roles; refresh: userId/tokenId)
//   sessions row   authController.js:241-243 via authService.createSession
//   userData shape authController.js:246-254
// Not mirrored: the Redis session-cache write (authController.js:255-256). It is an optimisation with a DB fallback
// (middleware/auth.js:99-145 re-verifies on a cache miss), so the outcome for the caller is identical.
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
  const accessToken = signAccessToken({ userId: user.id, email: user.email, roles: userRoles });
  const tokenId = crypto.randomUUID();
  const refreshToken = signRefreshToken({ userId: user.id, tokenId });
  await createSession(user.id, refreshToken, ip, userAgent || '');
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

export default { issueSession, setAccessCookie, setRefreshCookie, loadRoles };
