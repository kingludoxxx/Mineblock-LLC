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
    const hasRole = roles.some((role) => roleNames.includes(role.name));

    if (!hasRole) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    return next();
  };
};
