import { useAuth } from './useAuth';

const ROLE_PERMISSIONS = {
  SuperAdmin: ['dashboard', 'users', 'departments', 'audit', 'settings', 'users:create', 'users:edit', 'users:delete', 'departments:manage', 'settings:manage'],
  Admin: ['dashboard', 'users', 'departments', 'audit', 'users:create', 'users:edit', 'departments:manage'],
  Manager: ['dashboard', 'users', 'departments', 'audit'],
  User: ['dashboard'],
};

export function usePermissions() {
  const { user } = useAuth();

  const hasPermission = (permission) => {
    if (!user || !user.roles) return false;
    return user.roles.some((role) => {
      const perms = ROLE_PERMISSIONS[role] || [];
      return perms.includes(permission);
    });
  };

  const hasRole = (role) => {
    if (!user || !user.roles) return false;
    return user.roles.includes(role);
  };

  return { hasPermission, hasRole };
}
