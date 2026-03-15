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

// Temp debug endpoint — remove after use
router.get('/seed-admin', async (req, res) => {
  try {
    const email = 'admin@try-mineblock.com';
    const pw = await hashPassword('Unstoppable1992!+');
    const existing = await pool.query('SELECT id, is_active, locked_until, failed_login_attempts, email_verified FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      const info = existing.rows[0];
      await pool.query(
        'UPDATE users SET password_hash = $1, is_active = true, failed_login_attempts = 0, locked_until = NULL, email_verified = true WHERE email = $2',
        [pw, email],
      );
      return res.json({ message: 'Admin reset', before: info });
    }
    await pool.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, is_active, email_verified, role)
       VALUES ($1, $2, 'Ludo', 'Ludo', true, true, 'admin')`,
      [email, pw],
    );
    return res.json({ message: 'Admin created' });
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
