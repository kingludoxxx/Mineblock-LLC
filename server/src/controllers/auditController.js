import pool from '../config/db.js';

export const listAuditLogs = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;
    const { userId, action, resourceType, dateFrom, dateTo } = req.query;

    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (userId) {
      conditions.push(`al.user_id = $${paramIndex}`);
      params.push(userId);
      paramIndex++;
    }

    if (action) {
      conditions.push(`al.action = $${paramIndex}`);
      params.push(action);
      paramIndex++;
    }

    if (resourceType) {
      conditions.push(`al.resource_type = $${paramIndex}`);
      params.push(resourceType);
      paramIndex++;
    }

    if (dateFrom) {
      conditions.push(`al.created_at >= $${paramIndex}`);
      params.push(dateFrom);
      paramIndex++;
    }

    if (dateTo) {
      conditions.push(`al.created_at <= $${paramIndex}`);
      params.push(dateTo);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM audit_logs al ${whereClause}`,
      params
    );

    const total = parseInt(countResult.rows[0].total, 10);

    const dataParams = [...params, limit, offset];
    const result = await pool.query(
      `SELECT al.*,
              u.email as user_email,
              u.first_name as user_first_name,
              u.last_name as user_last_name
       FROM audit_logs al
       LEFT JOIN users u ON al.user_id = u.id
       ${whereClause}
       ORDER BY al.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      dataParams
    );

    const logs = result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      userEmail: row.user_email,
      userName: row.user_first_name && row.user_last_name
        ? `${row.user_first_name} ${row.user_last_name}`
        : null,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      oldValues: row.old_values,
      newValues: row.new_values,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      createdAt: row.created_at,
    }));

    return res.json({ logs, total, page, limit });
  } catch (err) {
    console.error('listAuditLogs error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const getAuditLog = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT al.*,
              u.email as user_email,
              u.first_name as user_first_name,
              u.last_name as user_last_name
       FROM audit_logs al
       LEFT JOIN users u ON al.user_id = u.id
       WHERE al.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Audit log not found' });
    }

    const row = result.rows[0];
    const log = {
      id: row.id,
      userId: row.user_id,
      userEmail: row.user_email,
      userName: row.user_first_name && row.user_last_name
        ? `${row.user_first_name} ${row.user_last_name}`
        : null,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      oldValues: row.old_values,
      newValues: row.new_values,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      createdAt: row.created_at,
    };

    return res.json({ log });
  } catch (err) {
    console.error('getAuditLog error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
