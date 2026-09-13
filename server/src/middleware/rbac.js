// Routes use kebab-case keys (e.g. 'brief-agent'); stored permissions may use
// camelCase (e.g. 'briefAgent') when built from the invite pages array.
// Normalise to kebab-case before comparing so both forms match.
function toKebab(str) {
  return str.replace(/([A-Z])/g, (c) => '-' + c.toLowerCase());
}

export const requirePermission = (resource, action) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const roles = req.user.roles || [];

    for (const role of roles) {
      let permissions = role.permissions;
      if (!permissions) continue;

      // Handle JSONB returned as string from postgres.js
      if (typeof permissions === 'string') {
        try { permissions = JSON.parse(permissions); } catch { continue; }
      }

      // SuperAdmin wildcard: {"*": ["*"]}
      if (permissions['*'] && Array.isArray(permissions['*']) && permissions['*'].includes('*')) {
        return next();
      }

      // Check every stored key normalised to kebab-case against the resource key
      for (const [key, actions] of Object.entries(permissions)) {
        if (toKebab(key) !== resource) continue;
        if (Array.isArray(actions) && (actions.includes('*') || actions.includes(action))) {
          return next();
        }
      }
    }

    return res.status(403).json({ error: 'Insufficient permissions' });
  };
};

export const requireRole = (...roleNames) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const roles = req.user.roles || [];
    // A role holding the full wildcard {"*":["*"]} passes every role gate. requirePermission already
    // treats the wildcard as everything; requireRole checked NAMES only, so a role granted full access
    // under any other name was still refused. Measured 2026-09-13 on live Mineblock: the hub owner
    // (role "Hub Owner", {"*":["*"]} since migration 136) got 403 "Insufficient permissions" on Team
    // Management, because /api/v1/team and /api/v1/users/roles gate on requireRole('SuperAdmin','Admin').
    // Keyed on the permission set, not on a new name added to each list, so the next full-access role
    // does not repeat this. A role WITHOUT the wildcard is judged by name exactly as before.
    const hasRole = roles.some((role) => roleNames.includes(role.name) || holdsWildcard(role));

    if (!hasRole) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    return next();
  };
};

/** True only for the exact full wildcard {"*":["*"]}, in object or JSON-string form. */
export function holdsWildcard(role) {
  let p = role && role.permissions;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { return false; } }
  return Boolean(p && Array.isArray(p['*']) && p['*'].includes('*'));
}
