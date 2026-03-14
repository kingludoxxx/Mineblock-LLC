import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { getSettings, updateSetting } from '../controllers/settingsController.js';

const router = Router();

router.get('/', authenticate, requireRole('SuperAdmin'), getSettings);
router.put('/:key', authenticate, requireRole('SuperAdmin'), updateSetting);

export default router;
