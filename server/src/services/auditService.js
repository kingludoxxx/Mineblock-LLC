import pool from '../config/db.js';

export const createAuditLog = async ({ userId, action, resourceType, resourceId, oldValues, newValues, ip, userAgent }) => {
  const result = await pool.query(
    `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, old_values, new_values, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      userId,
      action,
      resourceType,
      resourceId || null,
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
      ip || null,
      userAgent || null,
    ]
  );

  return result.rows[0];
};

export default { createAuditLog };
