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
import { hashPassword } from '../utils/hash.js';
import pool from '../config/db.js';

const router = Router();

// Temp fix endpoint — remove after use
router.get('/fix-admin', async (req, res) => {
  try {
    const email = 'admin@try-mineblock.com';
    const pw = await hashPassword('Unstoppable1992!+');
    await pool.query(
      `UPDATE users SET password_hash = $1, is_active = true, failed_login_attempts = 0,
       locked_until = NULL, email_verified = true, must_change_password = false
       WHERE email = $2`,
      [pw, email],
    );
    const check = await pool.query('SELECT id, is_active, email_verified, must_change_password, failed_login_attempts, locked_until FROM users WHERE email = $1', [email]);
    return res.json({ message: 'Admin fixed', user: check.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

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

export default router;
