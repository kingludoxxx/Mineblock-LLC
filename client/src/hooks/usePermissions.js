import { rolesGrant } from '../utils/permissions';
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
  // REVIEW-W8 P1-2: one matcher, shared with the tests and mirroring server/src/middleware/rbac.js
  // (stored keys may be camelCase; route keys are kebab-case; both sides normalise the same way).
  const hasPermission = (permission) => rolesGrant(user?.roles, permission);

  /**
   * Check if the user has a specific role by name.
   */
  const hasRole = (roleName) => {
    if (!user || !user.roles || !Array.isArray(user.roles)) return false;
    return user.roles.some((role) => role?.name === roleName);
  };

  return { hasPermission, hasRole };
}
