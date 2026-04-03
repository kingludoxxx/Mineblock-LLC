import { Router } from 'express';
import { query } from '../config/db.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

router.get('/stats', async (req, res, next) => {
  try {
    const [usersResult, departmentsResult, sessionsResult, auditResult] = await Promise.all([
      query('SELECT COUNT(*) AS count FROM users'),
      query("SELECT COUNT(*) AS count FROM departments WHERE active = true"),
      query("SELECT COUNT(*) AS count FROM sessions WHERE expires_at > NOW()"),
      query('SELECT id, action, actor, created_at FROM audit_events ORDER BY created_at DESC LIMIT 10'),
    ]);

    res.json({
      success: true,
      data: {
        totalUsers: parseInt(usersResult.rows[0].count, 10),
        activeDepartments: parseInt(departmentsResult.rows[0].count, 10),
        activeSessions: parseInt(sessionsResult.rows[0].count, 10),
        recentAuditEvents: auditResult.rows,
      },
    });
  } catch (err) {
    next(err);
  }
});

const NAV_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', icon: 'LayoutDashboard', path: '/dashboard', permissions: [] },
  { key: 'users', label: 'Users', icon: 'Users', path: '/users', permissions: ['users:read'] },
  { key: 'departments', label: 'Departments', icon: 'Building2', path: '/departments', permissions: ['departments:read'] },
  { key: 'roles', label: 'Roles & Permissions', icon: 'Shield', path: '/roles', permissions: ['roles:read'] },
  { key: 'audit', label: 'Audit Log', icon: 'ScrollText', path: '/audit', permissions: ['audit:read'] },
  { key: 'settings', label: 'Settings', icon: 'Settings', path: '/settings', permissions: ['settings:read'] },
];

router.get('/navigation', (req, res) => {
  const userPermissions = req.user?.permissions || [];

  const filtered = NAV_ITEMS.filter((item) => {
    if (item.permissions.length === 0) return true;
    return item.permissions.every((perm) => userPermissions.includes(perm));
  });

  res.json({
    success: true,
    data: filtered,
  });
});

export default router;
