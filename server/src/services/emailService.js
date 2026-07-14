/**
 * Email service.
 *
 * Phase 1 (now): only builds invite links — no email sending. The admin
 * copies the returned link and sends it to the invitee through any
 * channel (WhatsApp, Slack, personal email).
 *
 * Phase 2 (when Resend or similar is set up): this same module gains
 * `sendInviteEmail(...)` and callers stop caring whether it's a copy-link
 * flow or a real email flow — same function signature.
 */

const DEFAULT_APP_BASE_URL = 'https://mineblock-dashboard.onrender.com';

function getAppBaseUrl() {
  const raw = (process.env.APP_BASE_URL || DEFAULT_APP_BASE_URL).trim();
  // Strip trailing slash so `${base}/accept-invite?...` always joins cleanly.
  return raw.replace(/\/+$/, '');
}

/**
 * Build the accept-invite URL for a fresh invite token.
 * The token here MUST be the raw (unhashed) 32-byte hex string —
 * the DB stores sha256(token), the invitee clicks with the raw value.
 */
export function buildInviteLink({ token }) {
  if (!token || typeof token !== 'string') {
    throw new Error('buildInviteLink: token is required');
  }
  return `${getAppBaseUrl()}/accept-invite?token=${encodeURIComponent(token)}`;
}
