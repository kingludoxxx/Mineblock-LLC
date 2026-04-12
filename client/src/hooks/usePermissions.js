import { useAuth } from './useAuth';

export function usePermissions() {
  const { user } = useAuth();

  /**
   * Check if the user has a specific permission.
   * Format: "page-key:action" e.g. "brief-pipeline:access"
   *
   * The user object from the API has:
   *   user.roles = [{ name: "Role Name", permissions: { "page-key": ["action", ...], ... } }]
   *
   * Wildcard support: if any role has "*": ["*"], it grants everything.
   */
  const hasPermission = (permission) => {
    if (!user || !user.roles || !Array.isArray(user.roles)) return false;

    const [resource, action] = permission.split(':');
    if (!resource || !action) return false;

    return user.roles.some((role) => {
      let perms = role?.permissions;
      if (!perms) return false;

      // Handle JSONB returned as string
      if (typeof perms === 'string') {
        try { perms = JSON.parse(perms); } catch { return false; }
      }
      if (typeof perms !== 'object' || Array.isArray(perms)) return false;

      // Wildcard: "*": ["*"] grants everything
      if (Array.isArray(perms['*']) && perms['*'].includes('*')) return true;

      // Check specific resource
      const actions = perms[resource];
      if (!Array.isArray(actions)) return false;

      return actions.includes(action) || actions.includes('*');
    });
  };

  /**
   * Check if the user has a specific role by name.
   */
  const hasRole = (roleName) => {
    if (!user || !user.roles || !Array.isArray(user.roles)) return false;
    return user.roles.some((role) => role?.name === roleName);
  };

  return { hasPermission, hasRole };
}
