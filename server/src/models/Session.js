import pool from '../config/db.js';

const Session = {
  async create(data) {
    const { user_id, refresh_token_hash, ip_address, user_agent, expires_at } = data;
    const result = await pool.query(
      `INSERT INTO sessions (user_id, refresh_token_hash, ip_address, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [user_id, refresh_token_hash, ip_address, user_agent, expires_at]
    );
    return result.rows[0];
  },

  async findByTokenHash(hash) {
    const result = await pool.query(
      'SELECT * FROM sessions WHERE refresh_token_hash = $1 AND expires_at > NOW()',
      [hash]
    );
    return result.rows[0] || null;
  },

  async findByUserId(userId) {
    const result = await pool.query(
      'SELECT * FROM sessions WHERE user_id = $1 AND expires_at > NOW() ORDER BY created_at DESC',
      [userId]
    );
    return result.rows;
  },

  async deleteById(id) {
    const result = await pool.query(
      'DELETE FROM sessions WHERE id = $1 RETURNING id',
      [id]
    );
    return result.rows[0] || null;
  },

  async deleteByUserId(userId) {
    const result = await pool.query(
      'DELETE FROM sessions WHERE user_id = $1',
      [userId]
    );
    return result.rowCount;
  },

  async deleteExpired() {
    const result = await pool.query(
      'DELETE FROM sessions WHERE expires_at <= NOW()'
    );
    return result.rowCount;
  },
};

export default Session;
