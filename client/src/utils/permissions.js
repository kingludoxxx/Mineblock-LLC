// Pure permission matcher shared by usePermissions (client) — mirrors server/src/middleware/rbac.js.
//
// REVIEW-W8 P1-2: the server normalises stored permission keys to kebab-case before comparing
// (`briefAgent` matches the route key `brief-agent`); the client compared raw keys, so a role stored
// with camelCase keys (real data: invite-built roles) opened a page on the server and hid it in the
// client. W8b turned that hidden menu entry into a permanently gated Home page. One normaliser, same
// rule as the server, on both sides.
export function toKebab(str) {
  return String(str).replace(/([A-Z])/g, (c) => '-' + c.toLowerCase());
}

/** @param {Array<{permissions?: object|string}>|undefined} roles  @param {string} permission "resource:action" */
export function rolesGrant(roles, permission) {
  if (!Array.isArray(roles)) return false;
  const [resource, action] = String(permission || '').split(':');
  if (!resource || !action) return false;
  const want = toKebab(resource);
  return roles.some((role) => {
    let perms = role?.permissions;
    if (!perms) return false;
    if (typeof perms === 'string') { try { perms = JSON.parse(perms); } catch { return false; } }
    if (typeof perms !== 'object' || Array.isArray(perms)) return false;
    if (Array.isArray(perms['*']) && perms['*'].includes('*')) return true;
    for (const [key, actions] of Object.entries(perms)) {
      if (toKebab(key) !== want) continue;
      if (Array.isArray(actions) && (actions.includes(action) || actions.includes('*'))) return true;
    }
    return false;
  });
}
