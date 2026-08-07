// ─── Mineblock ↔ Puure fork migration ────────────────────────────────────
// Copies data from the current instance's DB (source = mineblock-db) to a
// fresh Puure DB (target = puure-db) per the split rules in FORK-SCOPE.md.
//
// Env vars required:
//   DATABASE_URL       — source DB (already set on mineblock-dashboard)
//   PUURE_DATABASE_URL — target DB (external URL of puure-db)
//
// Usage: invoked via POST /api/v1/statics-generation/admin-migrate-fork
//        with { dry_run: true|false, only_tables?: [names] }
//
// Safety:
//   - Dry-run mode returns row counts only, no writes to target
//   - Never DELETEs from source (that's a separate manual step)
//   - Idempotent: skips tables in target that already have rows unless
//     `force: true` is passed
//   - Transaction per table on the target side

import pg from 'pg';

const { Pool } = pg;

// Puure product IDs — determined from the audit. Update if new Puure
// products are added before running the migration.
const PUURE_PRODUCT_IDS = [37];

// Table split strategy metadata. Order matters: parents before children
// so foreign-key constraints are satisfied on the target side.
const TABLE_STRATEGY = [
  // ── Product-scoped: split by product_id, Puure rows only ─────────
  { name: 'product_profiles',          strategy: 'split_by_id',            key: 'id',         values: PUURE_PRODUCT_IDS },
  { name: 'spy_creatives',             strategy: 'split_by_column',        column: 'product_id' },
  { name: 'spy_custom_images',         strategy: 'split_by_column',        column: 'product_id' },
  { name: 'organic_images',            strategy: 'split_by_column',        column: 'product_id' },
  { name: 'spy_brand_follows',         strategy: 'split_by_column',        column: 'product_id' },
  { name: 'brief_copy_sets',           strategy: 'split_by_column',        column: 'product_id' },
  { name: 'brief_generation_jobs',     strategy: 'split_by_column',        column: 'product_id' },
  { name: 'statics_queue',             strategy: 'split_by_column',        column: 'product_id' },
  { name: 'statics_generation_events', strategy: 'split_by_column',        column: 'product_id' },
  { name: 'dismissed_iteration_winners', strategy: 'wholesale' }, // no product_id, small library table

  // ── Launch templates: NULL product_id in current data → wholesale ─
  { name: 'launch_templates',          strategy: 'wholesale' },

  // ── Statics launches: split via creative_id → product_id join ────
  { name: 'statics_launches',          strategy: 'split_via_join', join_table: 'spy_creatives', join_from: 'creative_id', join_to: 'id', join_column: 'product_id' },

  // ── Wholesale copy: library / reference tables ───────────────────
  { name: 'image_store',               strategy: 'wholesale' },
  { name: 'brief_pipeline_references', strategy: 'wholesale' },
  { name: 'statics_templates',         strategy: 'wholesale' },

  // ── Shared platform tables: copy wholesale ────────────────────────
  { name: 'roles',                     strategy: 'wholesale' },
  { name: 'users',                     strategy: 'wholesale' },
  { name: 'user_roles',                strategy: 'wholesale' },
  { name: 'audit_logs',                strategy: 'wholesale' },
  { name: 'departments',               strategy: 'wholesale' },
  { name: 'system_settings',           strategy: 'wholesale' },
  { name: 'api_keys',                  strategy: 'wholesale' },
  { name: 'integrations',              strategy: 'wholesale' },

  // ── brand_spy schema: copy wholesale ──────────────────────────────
  // Note: these tables live in the `brand_spy` schema, not `public`.
  { name: 'brand_spy.brands',          strategy: 'wholesale' },
  { name: 'brand_spy.ads',             strategy: 'wholesale' },
  { name: 'brand_spy.videos',          strategy: 'wholesale' },
];

// Helper: build a Pool for the given URL.
function makePool(connStr) {
  return new Pool({
    connectionString: connStr,
    ssl: connStr?.includes('render.com') ? { rejectUnauthorized: false } : false,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
}

// Get list of columns for a table (fully-qualified, e.g. brand_spy.brands
// works too since we split schema.table). Also returns the data_type for
// each column so JSONB values can be re-serialized before INSERT.
async function getColumns(pool, tableName) {
  const [schema, table] = tableName.includes('.')
    ? tableName.split('.')
    : ['public', tableName];
  const r = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position`,
    [schema, table]
  );
  return r.rows;
}

// Coerce a value pulled from source to a format the target pg driver can
// insert. Handles:
//   - JSONB / JSON columns: source returns JS objects/arrays, target needs
//     JSON string (else "invalid input syntax for type json")
//   - JSONB[] / JSON[] arrays: same but per-element
//   - Any plain object leaking into a text column: JSON.stringify defensively
function coerceForInsert(value, dataType) {
  if (value === null || value === undefined) return null;
  const t = (dataType || '').toLowerCase();
  if (t === 'jsonb' || t === 'json') {
    return typeof value === 'string' ? value : JSON.stringify(value);
  }
  // For ARRAY types (data_type='ARRAY'), pg driver handles JS arrays natively,
  // but if any element is a JS object (e.g. jsonb[]), stringify each.
  if (t === 'array' && Array.isArray(value)) {
    return value.map(el => (el !== null && typeof el === 'object' && !(el instanceof Date) && !Buffer.isBuffer(el))
      ? JSON.stringify(el)
      : el);
  }
  // Defensive fallback: any plain object/array reaching this point on a
  // non-JSON column means source has a JSONB-typed column my metadata scan
  // missed (custom domains, computed columns, etc.). Stringify safely.
  if (typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value) && !Array.isArray(value)) {
    return JSON.stringify(value);
  }
  return value;
}

// Check if a table exists in target
async function tableExists(pool, tableName) {
  const [schema, table] = tableName.includes('.')
    ? tableName.split('.')
    : ['public', tableName];
  const r = await pool.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = $2 LIMIT 1`,
    [schema, table]
  );
  return r.rowCount > 0;
}

// Get row count in a table
async function rowCount(pool, tableName) {
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM ${tableName}`);
  return r.rows[0].n;
}

// Batch-copy rows from source to target using COPY-style INSERT.
// Handles column list matching between source and target (uses intersection)
// AND JSONB re-serialization (source returns objects, target needs strings).
// Supports offset/limit for chunked migration of large tables (avoids
// Cloudflare/Render 100s edge-timeout on the endpoint).
async function copyRows(source, target, tableName, whereClause = '', params = [], sliceOpts = null) {
  const [srcCols, tgtCols] = await Promise.all([
    getColumns(source, tableName),
    getColumns(target, tableName),
  ]);
  // Intersect by name, take target's data_type as authoritative for coercion.
  const tgtByName = new Map(tgtCols.map(c => [c.column_name, c.data_type]));
  const commonCols = srcCols
    .filter(c => tgtByName.has(c.column_name))
    .map(c => ({ name: c.column_name, dataType: tgtByName.get(c.column_name) }));
  if (commonCols.length === 0) {
    throw new Error(`No common columns between source and target for ${tableName}`);
  }
  const colList = commonCols.map(c => `"${c.name}"`).join(', ');
  const sliceSql = sliceOpts?.orderBy && Number.isFinite(sliceOpts.offset) && Number.isFinite(sliceOpts.limit)
    ? ` ORDER BY ${sliceOpts.orderBy} OFFSET ${sliceOpts.offset} LIMIT ${sliceOpts.limit}`
    : '';
  const sql = `SELECT ${colList} FROM ${tableName} ${whereClause}${sliceSql}`;
  const src = await source.query(sql, params);
  if (src.rows.length === 0) return { copied: 0, columns: commonCols.length };

  // Batched INSERT with per-column type coercion (JSONB → string)
  const BATCH = 500;
  let copied = 0;
  const tclient = await target.connect();
  try {
    await tclient.query('BEGIN');
    for (let i = 0; i < src.rows.length; i += BATCH) {
      const chunk = src.rows.slice(i, i + BATCH);
      const placeholders = [];
      const values = [];
      let p = 1;
      for (const row of chunk) {
        const rowPlaceholders = commonCols.map(() => `$${p++}`);
        placeholders.push(`(${rowPlaceholders.join(', ')})`);
        for (const c of commonCols) values.push(coerceForInsert(row[c.name], c.dataType));
      }
      await tclient.query(
        `INSERT INTO ${tableName} (${colList}) VALUES ${placeholders.join(', ')} ON CONFLICT DO NOTHING`,
        values
      );
      copied += chunk.length;
    }
    await tclient.query('COMMIT');
  } catch (err) {
    await tclient.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tclient.release();
  }
  return { copied, columns: commonCols.length };
}

// Main migration entry point.
// `slice`: optional { orderBy, offset, limit } — copy only a range of rows.
//   Only meaningful when onlyTables is a single-table array. Used to chunk
//   large tables (image_store, statics_templates, brand_spy.ads) across
//   multiple HTTP calls to avoid the Render/Cloudflare 100s edge-timeout.
export async function migrateForkToPuure({ dryRun = true, onlyTables = null, force = false, slice = null } = {}) {
  const sourceUrl = process.env.DATABASE_URL;
  const targetUrl = process.env.PUURE_DATABASE_URL;
  if (!sourceUrl) throw new Error('DATABASE_URL env var missing on source');
  if (!targetUrl) throw new Error('PUURE_DATABASE_URL env var not set — configure on mineblock-dashboard service before running migration');

  const source = makePool(sourceUrl);
  const target = makePool(targetUrl);
  const results = [];

  try {
    // Preflight: verify both DBs reachable
    await source.query('SELECT 1');
    await target.query('SELECT 1');

    const strategies = onlyTables
      ? TABLE_STRATEGY.filter(s => onlyTables.includes(s.name))
      : TABLE_STRATEGY;

    for (const spec of strategies) {
      const startedAt = new Date().toISOString();
      try {
        // Check target table exists
        const exists = await tableExists(target, spec.name);
        if (!exists) {
          results.push({ table: spec.name, status: 'skipped', reason: 'target table does not exist (run migrations on target first)', startedAt });
          continue;
        }

        const targetCount = await rowCount(target, spec.name);
        // For sliced copies, don't skip on existing rows — that's the whole
        // point: append additional slices to an already-partial target.
        if (targetCount > 0 && !force && !slice) {
          results.push({ table: spec.name, status: 'skipped', reason: `target already has ${targetCount} rows (use force:true to append or use slice)`, startedAt });
          continue;
        }

        // Build WHERE + params per strategy
        let whereClause = '';
        let params = [];
        let expectedCount = 0;

        if (spec.strategy === 'split_by_id') {
          whereClause = `WHERE ${spec.key} = ANY($1::int[])`;
          params = [spec.values];
          const c = await source.query(`SELECT COUNT(*)::int AS n FROM ${spec.name} ${whereClause}`, params);
          expectedCount = c.rows[0].n;
        } else if (spec.strategy === 'split_by_column') {
          whereClause = `WHERE ${spec.column} = ANY($1::int[])`;
          params = [PUURE_PRODUCT_IDS];
          const c = await source.query(`SELECT COUNT(*)::int AS n FROM ${spec.name} ${whereClause}`, params);
          expectedCount = c.rows[0].n;
        } else if (spec.strategy === 'split_via_join') {
          whereClause = `WHERE ${spec.join_from} IN (SELECT ${spec.join_to} FROM ${spec.join_table} WHERE ${spec.join_column} = ANY($1::int[]))`;
          params = [PUURE_PRODUCT_IDS];
          const c = await source.query(`SELECT COUNT(*)::int AS n FROM ${spec.name} ${whereClause}`, params);
          expectedCount = c.rows[0].n;
        } else if (spec.strategy === 'wholesale') {
          expectedCount = await rowCount(source, spec.name);
        } else {
          results.push({ table: spec.name, status: 'skipped', reason: `unknown strategy ${spec.strategy}`, startedAt });
          continue;
        }

        if (dryRun) {
          results.push({ table: spec.name, status: 'dry_run', strategy: spec.strategy, would_copy: expectedCount, target_current: targetCount, startedAt });
          continue;
        }

        // Real copy — pass slice opts only when caller requested and this
        // is the sole table (slice semantics ambiguous across multiple).
        const sliceOpts = slice && strategies.length === 1 ? slice : null;
        const { copied, columns } = await copyRows(source, target, spec.name, whereClause, params, sliceOpts);
        const finalCount = await rowCount(target, spec.name);
        results.push({
          table: spec.name,
          status: 'copied',
          strategy: spec.strategy,
          expected: expectedCount,
          copied,
          columns,
          target_final: finalCount,
          startedAt,
          finishedAt: new Date().toISOString(),
        });
      } catch (err) {
        results.push({ table: spec.name, status: 'error', error: err.message, startedAt });
      }
    }

    return { success: true, dry_run: dryRun, results };
  } finally {
    await Promise.all([source.end().catch(() => {}), target.end().catch(() => {})]);
  }
}
