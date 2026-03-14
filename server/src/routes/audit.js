import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { listAuditLogs, getAuditLog } from '../controllers/auditController.js';

const router = Router();

router.get('/', authenticate, requirePermission('audit', 'read'), listAuditLogs);
router.get('/:id', authenticate, requirePermission('audit', 'read'), getAuditLog);

export default router;
