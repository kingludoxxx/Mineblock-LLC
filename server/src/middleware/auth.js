import { verifyAccessToken } from '../utils/jwt.js';
import pool from '../config/db.js';
import logger from '../utils/logger.js';

export const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const token = parts[1];

    let decoded;
    try {
      decoded = verifyAccessToken(token);
    } catch (err) {
      logger.warn('Invalid access token', { error: err.message });
      return res.status(401).json({ error: 'Authentication required' });
    }

    const result = await pool.query(
      `SELECT
         u.*,
         json_agg(
           json_build_object('id', r.id, 'name', r.name, 'permissions', r.permissions)
         ) FILTER (WHERE r.id IS NOT NULL) AS roles
       FROM users u
       LEFT JOIN user_roles ur ON u.id = ur.user_id
       LEFT JOIN roles r ON ur.role_id = r.id
       WHERE u.id = $1 AND u.is_active = true
       GROUP BY u.id`,
      [decoded.userId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const user = result.rows[0];

    req.user = {
      id: user.id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      roles: user.roles || [],
      mustChangePassword: user.must_change_password,
    };

    next();
  } catch (err) {
    logger.error('Authentication error', { error: err.message });
    return res.status(401).json({ error: 'Authentication required' });
  }
};

export default authenticate;
