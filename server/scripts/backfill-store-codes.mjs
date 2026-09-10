#!/usr/bin/env node
/**
 * backfill-store-codes.mjs — Lane C (S1-1) store-code / product-code backfill.
 *
 *   DATABASE_URL=postgres://... node server/scripts/backfill-store-codes.mjs --dry-run
 *   DATABASE_URL=postgres://... STORE_CODE=MB node server/scripts/backfill-store-codes.mjs
 *
 * Requires migrations 121+122 to have run (it refuses otherwise). Idempotent:
 * a second run changes 0 rows. --dry-run does everything inside one
 * transaction and ROLLS BACK, so the printed counts are the exact counts an
 * apply would produce.
 *
 * What it does, in order (every step only FILLS NULL tags; it never overwrites
 * a tag that is already set, and it never guesses — a row it cannot attribute
 * is left untagged and listed):
 *   0. store_code: every tagged table's rows and column default follow env
 *      STORE_CODE (unset => rules.default_store_code = MB).
 *   1. product_profiles: rows matching the P1 discriminators get product_code
 *      P1 when product_code is NULL; a different existing code is a CONFLICT.
 *   2. every table with (product_id, product_code): product_code copied from
 *      product_profiles.product_code via product_id.
 *   3. brief_pipeline_generated / _winners: naming prefix 'P1 - B####' =>
 *      P1 (only over NULL or the table default 'MR'; anything else = CONFLICT).
 *   4. child tables inherit from their parent row (brief_launches,
 *      brief_pipeline_references, ad_launches, video_ad_launches, statics_launches).
 *   5. clickup_brief_resolutions: from the brief row with the same ClickUp
 *      task id/url; from an optional --p1-tasks <file> list (task ids or URLs
 *      exported from the P1 list, one per line); from a URL containing the P1
 *      ClickUp product id. Brief NUMBER alone is never used (that is the
 *      collision this slice exists to remove).
 *   6. image_store: rows referenced by /tmp-img/<id> URLs of tagged creatives.
 *   7. counters: brief_number_counter ids tagged per rules (1=MR, 2=PL); the P1
 *      row is inserted with value = MAX(brief_number) of P1 briefs; the PL row
 *      is raised (never lowered) to MAX(brief_number) of PUURE/PL briefs.
 *      product_im_counters is covered by step 2. statics_im_counter (legacy
 *      global) is left untagged and listed.
 *   8. UNTAGGED report per table: count + sample ids; CONFLICTS listed.
 *
 * No live service is called. Brand values live in backfill-store-codes.rules.json.
 * Exit codes: 0 ok, 1 runtime/db error, 2 usage error.
 */
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── args ─────────────────────────────────────────────────────────────────────
function usage(msg) {
  if (msg) console.error(`ERROR: ${msg}`);
  console.error('usage: DATABASE_URL=... [STORE_CODE=MB] node server/scripts/backfill-store-codes.mjs [--dry-run] [--p1-tasks <file>] [--rules <file>] [--sample 5]');
  process.exit(2);
}
const opts = { dryRun: false, p1Tasks: null, rules: path.join(__dirname, 'backfill-store-codes.rules.json'), sample: 5 };
{
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (x === '--dry-run') opts.dryRun = true;
    else if (x === '--p1-tasks') opts.p1Tasks = a[++i] || usage('--p1-tasks needs a file');
    else if (x === '--rules') opts.rules = a[++i] || usage('--rules needs a file');
    else if (x === '--sample') opts.sample = Number(a[++i]) || usage('--sample needs a number');
    else if (x === '--help' || x === '-h') usage();
    else usage(`unknown option: ${x}`);
  }
}
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) usage('DATABASE_URL is required');

let rules;
try { rules = JSON.parse(fs.readFileSync(opts.rules, 'utf8')); }
catch (e) { console.error(`ERROR: cannot read rules file ${opts.rules}: ${e.message}`); process.exit(2); }

const STORE_CODE = process.env.STORE_CODE || rules.default_store_code;
if (!new RegExp(rules.store_code_pattern).test(STORE_CODE)) usage(`STORE_CODE "${STORE_CODE}" does not match ${rules.store_code_pattern}`);

let p1TaskKeys = [];
if (opts.p1Tasks) {
  try {
    p1TaskKeys = fs.readFileSync(opts.p1Tasks, 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  } catch (e) { console.error(`ERROR: cannot read --p1-tasks ${opts.p1Tasks}: ${e.message}`); process.exit(2); }
}

// ── connection ───────────────────────────────────────────────────────────────
function sslFor(url) {
  if ((process.env.PGSSLMODE || '').toLowerCase() === 'disable') return false;
  try {
    const u = new URL(url);
    const socket = u.searchParams.get('host') || '';
    if (socket.startsWith('/') || ['localhost', '127.0.0.1', '::1'].includes(u.hostname)) return false;
  } catch { /* fall through */ }
  return { rejectUnauthorized: false };
}

const client = new pg.Client({ connectionString: DATABASE_URL, ssl: sslFor(DATABASE_URL) });

// ── bookkeeping ──────────────────────────────────────────────────────────────
const log = (s = '') => console.log(s);
let changedRows = 0;
let schemaChanges = 0;
const steps = [];      // { step, table, rows }
const conflicts = [];  // { table, id, reason }
const notes = [];
async function q(sql, params) { return client.query(sql, params); }
async function upd(step, table, sql, params) {
  const r = await q(sql, params);
  changedRows += r.rowCount;
  steps.push({ step, table, rows: r.rowCount });
  return r.rowCount;
}
async function tableExists(t) { return (await q('SELECT to_regclass($1) AS r', [t])).rows[0].r !== null; }
async function columns(t) {
  return (await q(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [t])).rows.map((r) => r.column_name);
}
async function pkColumns(t) {
  const r = await q(`SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
                     WHERE i.indrelid = $1::regclass AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)`, [t]);
  return r.rows.map((x) => x.attname);
}
const ident = (s) => '"' + String(s).replace(/"/g, '""') + '"';

async function main() {
  try { await client.connect(); }
  catch (e) { throw new Error(`could not connect: ${e.message}`); }
  await q('BEGIN');
  await q(`SELECT set_config('app.store_code', $1, true)`, [STORE_CODE]);

  // Refuse to run before the schema change.
  const tagged = (await q(`SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='store_code' ORDER BY 1`)).rows.map((r) => r.table_name);
  if (!tagged.includes('product_profiles') || !tagged.includes('clickup_brief_resolutions')) {
    throw new Error('store_code columns not found: run migrations 121 and 122 first');
  }
  const withProductCode = new Set((await q(`SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='product_code'`)).rows.map((r) => r.table_name));
  const withProductId = new Set((await q(`SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='product_id'`)).rows.map((r) => r.table_name));

  log(`backfill-store-codes ${opts.dryRun ? 'DRY-RUN' : 'APPLY'}  store_code=${STORE_CODE}  tagged tables=${tagged.length}`);

  // ── 0. store_code rows + column default ──
  for (const t of tagged) {
    const d = (await q(`SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='store_code'`, [t])).rows[0].column_default;
    if (d !== `'${STORE_CODE}'::text`) {
      await q(`ALTER TABLE ${ident(t)} ALTER COLUMN store_code SET DEFAULT $1`.replace('$1', `'${STORE_CODE}'`));
      schemaChanges += 1;
      notes.push(`${t}.store_code default ${d} -> '${STORE_CODE}'`);
    }
    await upd('0.store_code', t, `UPDATE ${ident(t)} SET store_code = $1 WHERE store_code IS DISTINCT FROM $1`, [STORE_CODE]);
  }

  // ── 1. product_profiles P1 ──
  const p1 = rules.p1;
  await upd('1.profiles.p1', 'product_profiles',
    `UPDATE product_profiles SET product_code = $1
      WHERE product_code IS NULL AND (short_name = ANY($2::text[]) OR name ~* $3)`,
    [p1.product_code, p1.profile_short_names, p1.profile_name_regex]);
  for (const r of (await q(`SELECT id, product_code, name FROM product_profiles
      WHERE product_code IS NOT NULL AND product_code <> $1 AND (short_name = ANY($2::text[]) OR name ~* $3)`,
      [p1.product_code, p1.profile_short_names, p1.profile_name_regex])).rows) {
    conflicts.push({ table: 'product_profiles', id: String(r.id), reason: `matches P1 discriminators but product_code='${r.product_code}' (left as is)` });
  }

  // ── 2. product_id -> product_code via product_profiles ──
  for (const t of tagged) {
    if (t === 'product_profiles' || !withProductCode.has(t) || !withProductId.has(t)) continue;
    await upd('2.product_id', t,
      `UPDATE ${ident(t)} x SET product_code = pp.product_code FROM product_profiles pp
        WHERE pp.id = x.product_id AND pp.product_code IS NOT NULL AND x.product_code IS NULL`);
    const pk = await pkColumns(t);
    const idExpr = pk.length ? pk.map((c) => `x.${ident(c)}::text`).join(` || '/' || `) : 'x.ctid::text';
    for (const r of (await q(`SELECT ${idExpr} AS id, x.product_code AS have, pp.product_code AS want FROM ${ident(t)} x
        JOIN product_profiles pp ON pp.id = x.product_id
        WHERE x.product_code IS NOT NULL AND pp.product_code IS NOT NULL AND x.product_code <> pp.product_code LIMIT $1`, [opts.sample])).rows) {
      conflicts.push({ table: t, id: r.id, reason: `product_code='${r.have}' but product_profiles says '${r.want}' (left as is)` });
    }
  }

  // ── 3. naming prefix P1 on brief tables ──
  for (const [t, col] of [['brief_pipeline_generated', 'naming_convention'], ['brief_pipeline_winners', 'ad_name']]) {
    if (!tagged.includes(t) || !(await columns(t)).includes(col)) continue;
    const defaults = rules.overwritable_default_codes[t] || [];
    await upd('3.naming.p1', t,
      `UPDATE ${ident(t)} SET product_code = $1 WHERE ${ident(col)} ~ $2 AND (product_code IS NULL OR product_code = ANY($3::text[]))`,
      [p1.product_code, p1.naming_prefix_regex, defaults]);
    for (const r of (await q(`SELECT id, product_code FROM ${ident(t)} WHERE ${ident(col)} ~ $1 AND product_code <> $2 LIMIT $3`,
        [p1.naming_prefix_regex, p1.product_code, opts.sample])).rows) {
      conflicts.push({ table: t, id: String(r.id), reason: `${col} has the P1 naming prefix but product_code='${r.product_code}' (left as is)` });
    }
  }

  // ── 4. children inherit from parent ──
  const CHILDREN = [
    ['brief_launches', 'brief_id', 'brief_pipeline_generated', 'id'],
    ['brief_pipeline_references', 'generated_brief_id', 'brief_pipeline_generated', 'id'],
    ['ad_launches', 'batch_id', 'ad_batches', 'id'],
    ['video_ad_launches', 'video_ad_id', 'video_ads', 'id'],
    ['statics_launches', 'creative_id', 'spy_creatives', 'id'],
  ];
  for (const [child, fk, parent, pkey] of CHILDREN) {
    if (!tagged.includes(child) || !withProductCode.has(child) || !(await tableExists(parent)) || !withProductCode.has(parent)) continue;
    await upd('4.parent', child,
      `UPDATE ${ident(child)} c SET product_code = p.product_code FROM ${ident(parent)} p
        WHERE p.${ident(pkey)} = c.${ident(fk)} AND p.product_code IS NOT NULL AND c.product_code IS NULL`);
  }

  // ── 5. clickup_brief_resolutions ──
  if (tagged.includes('clickup_brief_resolutions') && (await tableExists('brief_pipeline_generated'))) {
    await upd('5.clickup.task', 'clickup_brief_resolutions',
      `UPDATE clickup_brief_resolutions r SET product_code = b.product_code FROM brief_pipeline_generated b
        WHERE b.product_code IS NOT NULL AND r.product_code IS NULL
          AND ((r.task_id IS NOT NULL AND r.task_id = b.clickup_task_id) OR (b.clickup_task_url IS NOT NULL AND r.task_url = b.clickup_task_url))`);
    if (p1TaskKeys.length) {
      await upd('5.clickup.p1list', 'clickup_brief_resolutions',
        `UPDATE clickup_brief_resolutions SET product_code = $1 WHERE product_code IS NULL
          AND (task_id = ANY($2::text[]) OR task_url = ANY($2::text[]) OR task_url LIKE ANY(SELECT '%/' || k FROM unnest($2::text[]) k))`,
        [p1.product_code, p1TaskKeys]);
    }
    await upd('5.clickup.productid', 'clickup_brief_resolutions',
      `UPDATE clickup_brief_resolutions SET product_code = $1 WHERE product_code IS NULL AND task_url LIKE $2`,
      [p1.product_code, `%${p1.clickup_product_id}%`]);
  }

  // ── 6. image_store via /tmp-img/<id> references of tagged creatives ──
  if (tagged.includes('image_store') && (await tableExists('spy_creatives')) && withProductCode.has('spy_creatives')) {
    const cols = (await columns('spy_creatives')).filter((c) => rules.image_url_columns.includes(c));
    if (cols.length) {
      const arr = `ARRAY[${cols.map((c) => `c.${ident(c)}`).join(', ')}]`;
      const refs = `SELECT substring(u FROM $1) AS img_id, c.product_code FROM spy_creatives c
                    CROSS JOIN LATERAL unnest(${arr}) AS u WHERE c.product_code IS NOT NULL AND u LIKE '%/tmp-img/%'`;
      await upd('6.image_store', 'image_store',
        `WITH refs AS (${refs}), one AS (SELECT img_id, product_code FROM refs WHERE img_id IS NOT NULL GROUP BY 1, 2),
              unambiguous AS (SELECT img_id, MIN(product_code) AS product_code FROM one GROUP BY img_id HAVING COUNT(*) = 1)
         UPDATE image_store s SET product_code = u.product_code FROM unambiguous u WHERE s.id = u.img_id AND s.product_code IS NULL`,
        [rules.image_store_id_regex]);
      for (const r of (await q(`WITH refs AS (${refs}), one AS (SELECT img_id, product_code FROM refs WHERE img_id IS NOT NULL GROUP BY 1, 2)
          SELECT img_id, string_agg(product_code, ',') AS codes FROM one GROUP BY img_id HAVING COUNT(*) > 1 LIMIT $2`,
          [rules.image_store_id_regex, opts.sample])).rows) {
        conflicts.push({ table: 'image_store', id: r.img_id, reason: `referenced by creatives of several codes (${r.codes}); left untagged` });
      }
    }
  }

  // ── 7. counters ──
  const counters = {};
  if (tagged.includes('brief_number_counter')) {
    for (const [id, code] of Object.entries(rules.brief_number_counter_ids)) {
      await upd('7.counter.tag', 'brief_number_counter',
        `UPDATE brief_number_counter SET product_code = $2 WHERE id = $1 AND product_code IS NULL`, [Number(id), code]);
    }
    const hasBriefs = await tableExists('brief_pipeline_generated');
    if (hasBriefs) {
      const p1max = (await q(`SELECT COALESCE(MAX(brief_number), 0)::int AS m FROM brief_pipeline_generated WHERE product_code = $1`, [p1.product_code])).rows[0].m;
      await upd('7.counter.p1seed', 'brief_number_counter',
        // HAVING, not WHERE: an aggregate over zero rows still yields one row,
        // which re-inserted id=1 on the second run (caught by the A5 idempotency test).
        `INSERT INTO brief_number_counter (id, value, product_code)
          SELECT COALESCE(MAX(id), 0) + 1, $2, $1 FROM brief_number_counter
          HAVING NOT EXISTS (SELECT 1 FROM brief_number_counter WHERE product_code = $1)`, [p1.product_code, p1max]);
      const plmax = (await q(`SELECT COALESCE(MAX(brief_number), 0)::int AS m FROM brief_pipeline_generated WHERE product_code = ANY($1::text[])`, [rules.pl.bucket_codes])).rows[0].m;
      await upd('7.counter.plraise', 'brief_number_counter',
        `UPDATE brief_number_counter SET value = $2 WHERE product_code = $1 AND value < $2`, [rules.pl.product_code, plmax]);
      counters.p1_seed_from_max_brief = p1max;
      counters.pl_max_brief = plmax;
    }
    counters.brief_number_counter = (await q(`SELECT id, product_code, value FROM brief_number_counter ORDER BY id`)).rows;
  }
  if (tagged.includes('product_im_counters')) counters.product_im_counters = (await q(`SELECT product_id, product_code, next_im FROM product_im_counters ORDER BY product_id`)).rows;
  if (tagged.includes('statics_im_counter')) counters.statics_im_counter = (await q(`SELECT id, product_code, next_number FROM statics_im_counter`)).rows;

  // ── 8. report ──
  const tables = {};
  for (const t of tagged) {
    const total = Number((await q(`SELECT count(*) AS n FROM ${ident(t)}`)).rows[0].n);
    const sc = {};
    for (const r of (await q(`SELECT store_code, count(*) AS n FROM ${ident(t)} GROUP BY 1 ORDER BY 1`)).rows) sc[r.store_code] = Number(r.n);
    const row = { total, store_code: sc };
    if (withProductCode.has(t)) {
      const pc = {};
      for (const r of (await q(`SELECT product_code, count(*) AS n FROM ${ident(t)} WHERE product_code IS NOT NULL GROUP BY 1 ORDER BY 1`)).rows) pc[r.product_code] = Number(r.n);
      row.product_code = pc;
      row.untagged = Number((await q(`SELECT count(*) AS n FROM ${ident(t)} WHERE product_code IS NULL`)).rows[0].n);
      const pk = await pkColumns(t);
      const idExpr = pk.length ? pk.map((c) => `${ident(c)}::text`).join(` || '/' || `) : 'ctid::text';
      row.untagged_sample = (await q(`SELECT ${idExpr} AS id FROM ${ident(t)} WHERE product_code IS NULL ORDER BY 1 LIMIT $1`, [opts.sample])).rows.map((r) => r.id);
    } else {
      row.product_code = null;
      row.untagged = 0;
      row.untagged_sample = [];
    }
    tables[t] = row;
  }

  log('');
  log('STEP CHANGES (rows):');
  for (const s of steps.filter((x) => x.rows > 0)) log(`  ${s.step.padEnd(22)} ${s.table.padEnd(32)} ${s.rows}`);
  if (!steps.some((x) => x.rows > 0)) log('  (none)');
  for (const n of notes) log(`  schema: ${n}`);
  log('');
  log('PER-TABLE REPORT  (store_code counts | product_code counts | untagged):');
  for (const [t, r] of Object.entries(tables)) {
    const scs = Object.entries(r.store_code).map(([k, v]) => `${k}=${v}`).join(' ') || '-';
    const pcs = r.product_code ? (Object.entries(r.product_code).map(([k, v]) => `${k}=${v}`).join(' ') || '-') : 'n/a';
    log(`  ${t.padEnd(32)} total=${String(r.total).padEnd(7)} store[${scs}]  product[${pcs}]  untagged=${r.untagged}`);
  }
  log('');
  log('UNTAGGED (product_code IS NULL; left as is, never guessed):');
  const un = Object.entries(tables).filter(([, r]) => r.product_code && r.untagged > 0);
  if (!un.length) log('  (none)');
  for (const [t, r] of un) log(`  ${t.padEnd(32)} ${String(r.untagged).padEnd(7)} sample: ${r.untagged_sample.join(', ')}`);
  log('');
  log('CONFLICTS (existing tag disagrees with the evidence; left as is):');
  if (!conflicts.length) log('  (none)');
  for (const c of conflicts) log(`  ${c.table} ${c.id}: ${c.reason}`);
  log('');
  log('COUNTERS:');
  log('  ' + JSON.stringify(counters));
  log('');

  if (opts.dryRun) { await q('ROLLBACK'); log(`DRY-RUN: rolled back. Would change ${changedRows} row(s) and ${schemaChanges} column default(s).`); }
  else { await q('COMMIT'); log(`APPLIED: changed ${changedRows} row(s) and ${schemaChanges} column default(s).`); }

  const summary = {
    mode: opts.dryRun ? 'dry-run' : 'apply',
    store_code: STORE_CODE,
    changed_rows: changedRows + schemaChanges,
    row_changes: changedRows,
    schema_changes: schemaChanges,
    steps: steps.filter((x) => x.rows > 0),
    tables,
    conflicts,
    counters,
  };
  log('JSON_SUMMARY ' + JSON.stringify(summary));
}

main()
  .then(() => client.end())
  .catch(async (err) => {
    console.error(`ERROR: ${err.message}`);
    try { await client.query('ROLLBACK'); } catch { /* not in a transaction */ }
    try { await client.end(); } catch { /* not connected */ }
    process.exit(1);
  });
