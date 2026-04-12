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

      // Check specific resource permission
      if (permissions[resource] && Array.isArray(permissions[resource])) {
        if (permissions[resource].includes('*') || permissions[resource].includes(action)) {
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
