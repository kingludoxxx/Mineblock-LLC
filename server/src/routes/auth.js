import { Router } from 'express';
import {
  signup,
  login,
  refresh,
  logout,
  me,
  changePassword,
  forgotPassword,
  resetPassword,
  verifyEmail,
  getInviteInfo,
  acceptInvite,
} from '../controllers/authController.js';
import { authenticate } from '../middleware/auth.js';
import { authRateLimiter, apiRateLimiter } from '../middleware/rateLimiter.js';

const router = Router();

// Public (rate-limited)
router.post('/signup', authRateLimiter, signup);
router.post('/login', authRateLimiter, login);
router.post('/forgot-password', authRateLimiter, forgotPassword);
router.post('/reset-password', authRateLimiter, resetPassword);
router.get('/verify-email', verifyEmail);

// Invite flow (public, rate-limited — token in body/query is the auth).
router.get('/invite-info', authRateLimiter, getInviteInfo);
router.post('/accept-invite', authRateLimiter, acceptInvite);

// Token refresh (uses cookie, no auth header needed)
// /refresh is a session heartbeat, not an auth attempt — every dashboard
// page navigation calls it. Use the general API limiter (100/min) instead
// of the strict auth limiter (25/15min) so heavy dashboard use never
// locks the operator out.
router.post('/refresh', apiRateLimiter, refresh);

// Authenticated
router.post('/logout', authenticate, logout);
router.get('/me', authenticate, me);
router.post('/change-password', authenticate, changePassword);

export default router;
