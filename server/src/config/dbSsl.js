// DATABASE_SSL — the one place the database TLS decision is made.
//
// Before this file the decision was inferred twice, identically, from
// `DATABASE_URL.includes('render.com') || NODE_ENV === 'production'`
// (config/db.js and db/pg.js). That inference has no override, so a store born
// on a Postgres that is not Render's and not TLS-terminated (the local sandbox
// a new store is proven on, a self-hosted or in-VPC instance) cannot be booted
// with its REAL production env: the pools demand TLS, every query fails with
// "The server does not support SSL connections", /api/health answers 503 and
// login answers 500. The migration runner already had this knob (MIGRATE_SSL);
// the server did not, so the two halves of the same deploy disagreed.
//
// DATABASE_SSL=1 forces TLS on, DATABASE_SSL=0 forces it off. UNSET keeps the
// historical inference exactly, so no existing deployment changes behaviour.
// Read at call time (R7): rollback is unsetting the variable.

/**
 * @param {{DATABASE_URL?: string, NODE_ENV?: string, DATABASE_SSL?: string}} e
 * @returns {boolean} whether the database connection must use TLS
 */
export function dbSslEnabled(e = process.env) {
  const flag = e.DATABASE_SSL;
  if (flag !== undefined && flag !== null && String(flag).trim() !== '') {
    const v = String(flag).trim().toLowerCase();
    if (['0', 'false', 'no', 'off'].includes(v)) return false;
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    throw new Error(`DATABASE_SSL must be 0 or 1 (got ${JSON.stringify(flag)})`);
  }
  return Boolean(e.DATABASE_URL?.includes('render.com')) || e.NODE_ENV === 'production';
}
