#!/usr/bin/env node
// brain:import — the FIRST import into a new Store Brain: the operator's own
// research folder.
//
//   npm run brain:import -- --product <CODE> --source "operator research" <folder>
//
// Walks the folder, ingests every .md / .txt / .json file as a RAW DOCUMENT in
// this store's Brain, and is IDEMPOTENT: a second run over an unchanged folder
// adds nothing, because a document's identity is the sha256 of its bytes, not its
// path. An EDITED file is a new document — raw sources are immutable.
//
// It talks to whatever DATABASE_URL names, which is this store's own database.
// There is no store argument: the Brain you import into is the one you are
// connected to.
//
// FAILS LOUDLY. A missing folder, an unknown product code, a missing --source, an
// unreachable database or a folder with nothing ingestable all exit non-zero with
// the reason. "0 new" is a RESULT; it is never how an error is reported.
import postgres from 'postgres';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { dbSslEnabled } from '../src/config/dbSsl.js';

// File suffix → the CONTENT TYPE to declare. The bucket extension is derived by
// the server from that type and is not the CLI's to choose (S4-SB2 / P1-6).
const EXT = new Map([
  ['.md', { type: 'text/markdown' }],
  ['.txt', { type: 'text/plain' }],
  ['.json', { type: 'application/json' }],
]);

function usage(msg) {
  console.error(`brain:import: ${msg}`);
  console.error('usage: npm run brain:import -- --product <CODE> --source "<source name>" <folder>');
  process.exit(2);
}

const argv = process.argv.slice(2);
let product = null, source = null, folder = null, dryRun = false;
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--product') product = argv[++i];
  else if (a === '--source') source = argv[++i];
  else if (a === '--dry-run') dryRun = true;
  else if (a === '-h' || a === '--help') usage('help');
  else if (a.startsWith('--')) usage(`unknown flag ${a}`);
  else folder = a;
}
if (!product) usage('--product <CODE> is required');
if (!source) usage('--source "<source name>" is required (e.g. "operator research")');
if (!folder) usage('a folder to import is required');

let st;
try { st = statSync(folder); } catch (e) { console.error(`brain:import: ${folder} is not a readable directory (${e.code || e.message})`); process.exit(1); }
if (!st.isDirectory()) { console.error(`brain:import: ${folder} is not a directory`); process.exit(1); }

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else out.push({ path: p, mtime: s.mtime });
  }
  return out;
}

const all = walk(folder);
const ingestable = all.filter((f) => EXT.has(extname(f.path).toLowerCase()));
const skippedFiles = all.filter((f) => !EXT.has(extname(f.path).toLowerCase()));

if (!ingestable.length) {
  console.error(`brain:import: no ingestable files (.md/.txt/.json) under ${folder} — ${all.length} file(s) scanned, all skipped`);
  process.exit(1);
}

const dsn = process.env.DATABASE_URL;
if (!dsn) { console.error('brain:import: DATABASE_URL is not set — there is no Brain to import into'); process.exit(1); }

const sql = postgres(dsn, { ssl: dbSslEnabled() ? 'require' : false, onnotice: () => {}, max: 2 });
const { ingestDocument, embedDocument } = await import('../src/services/brainStore.js');

let created = 0, existing = 0, failed = 0;
let embedded = 0, notEmbedded = 0;
const embedReasons = new Map();
try {
  // Prove the connection and the schema BEFORE claiming any count.
  await sql`SELECT 1 FROM kb_documents LIMIT 1`;

  for (const f of ingestable) {
    const meta = EXT.get(extname(f.path).toLowerCase());
    const text = readFileSync(f.path, 'utf8');
    const rel = relative(folder, f.path);
    if (!text.trim()) { console.log(`  skip  ${rel} (empty)`); continue; }
    if (dryRun) { console.log(`  would ingest  ${rel}`); continue; }
    try {
      const { document, created: isNew } = await ingestDocument(sql, {
        source, title: rel, text, product_code: product,
        content_type: meta.type,
        captured_at: f.mtime, metadata: { path: rel },
      }, { actor: 'cli:brain-import' });
      if (isNew) { created += 1; console.log(`  new   ${rel} → ${document.body_object_key}`); }
      else { existing += 1; console.log(`  same  ${rel} (already in the Brain)`); }
      if (isNew) {
        // Never silent (review P2-13): a swallowed embedding error used to leave
        // no line and no count, so "imported 40" could mean 40 unsearchable rows
        // on the vector path. Count both outcomes and print them at the end.
        try {
          const e = await embedDocument(sql, document.id);
          if (e.embedded) embedded += 1;
          else { notEmbedded += 1; embedReasons.set(e.reason, (embedReasons.get(e.reason) || 0) + 1); }
        } catch (err) {
          notEmbedded += 1;
          embedReasons.set(err.message, (embedReasons.get(err.message) || 0) + 1);
        }
      }
    } catch (err) {
      failed += 1;
      console.error(`  FAIL  ${rel}: ${err.message}`);
      // An unknown product code or a malformed catalogue is not a per-file
      // problem; it condemns the whole run. Stop rather than report a partial
      // success that reads like a success.
      if (['bad_product_code', 'product_required', 'store_config'].includes(err.code) || err.name === 'StoreConfigError') {
        throw err;
      }
    }
  }
} catch (err) {
  console.error(`brain:import: FAILED — ${err.message}`);
  await sql.end({ timeout: 2 }).catch(() => {});
  process.exit(1);
}

await sql.end({ timeout: 5 });
console.log(`\nscanned: ${all.length} | ingestable: ${ingestable.length} | new: ${created} | already present: ${existing} | skipped (unsupported type): ${skippedFiles.length} | failed: ${failed}`);
console.log(`embedded: ${embedded} | not embedded: ${notEmbedded}${
  notEmbedded ? ` (${[...embedReasons].map(([r, n]) => `${n}× ${r}`).join('; ')})` : ''}`);
process.exit(failed ? 1 : 0);
