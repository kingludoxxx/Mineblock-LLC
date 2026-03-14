import pool from '../config/db.js';
import { createAuditLog } from '../services/auditService.js';

export const getSettings = async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM system_settings ORDER BY key ASC');

    return res.json({ settings: result.rows });
  } catch (err) {
    console.error('getSettings error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const updateSetting = async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;

    if (value === undefined) {
      return res.status(400).json({ error: 'value is required' });
    }

    const existing = await pool.query('SELECT * FROM system_settings WHERE key = $1', [key]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Setting not found' });
    }

    const oldValue = existing.rows[0].value;

    const result = await pool.query(
      `UPDATE system_settings
       SET value = $1, updated_by = $2, updated_at = NOW()
       WHERE key = $3
       RETURNING *`,
      [typeof value === 'string' ? value : JSON.stringify(value), req.user.id, key]
    );

    await createAuditLog({
      userId: req.user.id,
      action: 'UPDATE_SETTING',
      resourceType: 'setting',
      resourceId: key,
      oldValues: { value: oldValue },
      newValues: { value: result.rows[0].value },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return res.json({ setting: result.rows[0] });
  } catch (err) {
    console.error('updateSetting error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
