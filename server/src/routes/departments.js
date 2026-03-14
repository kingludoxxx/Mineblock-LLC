import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requirePermission, requireRole } from '../middleware/rbac.js';
import {
  listDepartments,
  getDepartment,
  createDepartment,
  updateDepartment,
  toggleDepartmentStatus,
} from '../controllers/departmentController.js';

const router = Router();

router.get('/', authenticate, requirePermission('departments', 'read'), listDepartments);
router.post('/', authenticate, requirePermission('departments', 'create'), createDepartment);
router.get('/:id', authenticate, requirePermission('departments', 'read'), getDepartment);
router.put('/:id', authenticate, requirePermission('departments', 'update'), updateDepartment);
router.patch('/:id/status', authenticate, requireRole('SuperAdmin'), toggleDepartmentStatus);

export default router;
