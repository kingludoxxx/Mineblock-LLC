import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import {
  inviteTeamMember,
  listTeamMembers,
  changeTeamMemberRole,
  deactivateTeamMember,
  reactivateTeamMember,
  updateTeamMemberPages,
} from '../controllers/teamController.js';

const router = Router();

// GET /api/v1/team — list all team members (Admin or SuperAdmin)
router.get('/', authenticate, requireRole('SuperAdmin', 'Admin'), listTeamMembers);

// POST /api/v1/team/invite — invite a new team member (Admin or SuperAdmin)
router.post('/invite', authenticate, requireRole('SuperAdmin', 'Admin'), inviteTeamMember);

// PUT /api/v1/team/:userId/role — change a team member's role (Admin or SuperAdmin)
router.put('/:userId/role', authenticate, requireRole('SuperAdmin', 'Admin'), changeTeamMemberRole);

// PUT /api/v1/team/:userId/pages — update a team member's page access (Admin or SuperAdmin)
router.put('/:userId/pages', authenticate, requireRole('SuperAdmin', 'Admin'), updateTeamMemberPages);

// DELETE /api/v1/team/:userId — deactivate a team member (SuperAdmin only)
router.delete('/:userId', authenticate, requireRole('SuperAdmin'), deactivateTeamMember);

// PATCH /api/v1/team/:userId/activate — reactivate a previously deactivated member (SuperAdmin only)
router.patch('/:userId/activate', authenticate, requireRole('SuperAdmin'), reactivateTeamMember);

export default router;
