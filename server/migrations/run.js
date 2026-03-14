import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) UNIQUE NOT NULL,
      executed_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function getExecutedMigrations(client) {
  const result = await client.query('SELECT filename FROM _migrations ORDER BY filename');
  return new Set(result.rows.map((row) => row.filename));
}

async function run() {
  const client = await pool.connect();

  try {
    await ensureMigrationsTable(client);
    const executed = await getExecutedMigrations(client);

    const files = fs
      .readdirSync(__dirname)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    if (files.length === 0) {
      console.log('No migration files found.');
      return;
    }

    let migrationsRun = 0;

    for (const file of files) {
      if (executed.has(file)) {
        console.log(`Skipping (already executed): ${file}`);
        continue;
      }

      const filePath = path.join(__dirname, file);
      const sql = fs.readFileSync(filePath, 'utf-8');

      console.log(`Running migration: ${file}...`);

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO _migrations (filename) VALUES ($1)',
          [file]
        );
        await client.query('COMMIT');
        console.log(`Completed: ${file}`);
        migrationsRun++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`Failed: ${file}`, err.message);
        throw err;
      }
    }

    if (migrationsRun === 0) {
      console.log('All migrations are up to date.');
    } else {
      console.log(`Successfully ran ${migrationsRun} migration(s).`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
