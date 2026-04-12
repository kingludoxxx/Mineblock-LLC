import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requirePermission, requireRole } from '../middleware/rbac.js';
import {
  listUsers,
  getUserById,
  createUser,
  updateUser,
  toggleUserStatus,
  assignRole,
  removeRole,
  listRoles,
} from '../controllers/userController.js';
const router = Router();

router.get('/roles', authenticate, requireRole('SuperAdmin', 'Admin'), listRoles);
router.get('/', authenticate, requirePermission('users', 'read'), listUsers);
router.post('/', authenticate, requirePermission('users', 'create'), createUser);
router.get('/:id', authenticate, requirePermission('users', 'read'), getUserById);
router.put('/:id', authenticate, requirePermission('users', 'update'), updateUser);
router.patch('/:id/status', authenticate, requireRole('SuperAdmin'), toggleUserStatus);
router.post('/:id/roles', authenticate, requirePermission('users', 'update'), assignRole);
router.delete('/:id/roles/:roleId', authenticate, requirePermission('users', 'update'), removeRole);

export default router;
