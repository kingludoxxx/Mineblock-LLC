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
} from '../controllers/authController.js';
import { authenticate } from '../middleware/auth.js';
import { authRateLimiter } from '../middleware/rateLimiter.js';

const router = Router();

// Public (rate-limited)
router.post('/signup', authRateLimiter, signup);
router.post('/login', authRateLimiter, login);
router.post('/forgot-password', authRateLimiter, forgotPassword);
router.post('/reset-password', authRateLimiter, resetPassword);
router.get('/verify-email', verifyEmail);

// Token refresh (uses cookie, no auth header needed)
router.post('/refresh', authRateLimiter, refresh);

// Authenticated
router.post('/logout', authenticate, logout);
router.get('/me', authenticate, me);
router.post('/change-password', authenticate, changePassword);

// TEMPORARY: Unlock admin account and reset password
// TODO: REMOVE THIS AFTER USE
import pool from '../config/db.js';
import { hashPassword } from '../utils/hash.js';
router.post('/admin-unlock', async (req, res) => {
  const { secret, newPassword } = req.body;
  if (secret !== 'mineblock-unlock-2026') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const hash = await hashPassword(newPassword || 'MineblockAdmin2026!');
    await pool.query(
      `UPDATE users SET failed_login_attempts = 0, locked_until = NULL, password_hash = $1, must_change_password = false WHERE email = 'admin@try-mineblock.com'`,
      [hash]
    );
    res.json({ success: true, message: 'Admin account unlocked and password reset' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
