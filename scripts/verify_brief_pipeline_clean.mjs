#!/usr/bin/env node
/**
 * Verify the Brief Pipeline is clean of foreign-brand contamination.
 *
 * What this does:
 *   1. Counts every brief_pipeline_references row by source + quarantine state
 *   2. Counts creative_analysis rows by quarantine state and verified-at age
 *   3. For each non-quarantined META reference: re-resolves ownership via
 *      Meta Marketing API. If foreign account → quarantines the row
 *      directly via SQL (replicates the /_audit-all-meta-refs endpoint).
 *   4. Scans transcripts for known foreign-brand callouts (ALDI, LIDL, etc.)
 *   5. Reports clean / dirty state with row counts.
 *
 * Requires env: DATABASE_URL, META_ACCESS_TOKEN, META_AD_ACCOUNT_IDS
 */

import fs from 'fs';
import path from 'path';
import pg from 'pg';

// ── Load .env ───────────────────────────────────────────────────────
const envPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const DATABASE_URL = process.env.DATABASE_URL;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const META_AD_ACCOUNT_IDS = (process.env.META_AD_ACCOUNT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const META_GRAPH_URL = 'https://graph.facebook.com/v21.0';

if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL not set in env');
  process.exit(1);
}

const TRUSTED = new Set(
  META_AD_ACCOUNT_IDS.flatMap((raw) => {
    const bare = raw.replace(/^act_/i, '');
    return bare ? [bare, `act_${bare}`] : [];
  })
);
const isTrusted = (acctId) => {
  if (!acctId) return false;
  const id = String(acctId).trim();
  const bare = id.replace(/^act_/i, '');
  return TRUSTED.has(id) || TRUSTED.has(bare) || TRUSTED.has(`act_${bare}`);
};

const FOREIGN_REGEX = /\b(ALDI|LIDL|WALMART|TESCO|COSTCO|CARREFOUR|KROGER|TARGET CORP|JD\s*SPORTS|MARBLE BLAST|TRENITALIA|FRECCIA|NORSE ORGANIC|H&M|ZARA)\b/i;
const MINEBLOCK_BRAND = /(mineblock|minerforge|miner\s*forge|bitcoin miner|btc miner)/i;

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
});

async function q(sql, params = []) {
  const r = await pool.query(sql, params);
  return r.rows;
}

async function resolveOwnership(metaAdId) {
  if (!metaAdId || !META_ACCESS_TOKEN) return { error: 'no token or id' };
  try {
    const url = `${META_GRAPH_URL}/${metaAdId}?fields=name,account_id,effective_status,creative{video_id}&access_token=${META_ACCESS_TOKEN}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const data = await resp.json();
    if (!resp.ok || data.error) return { error: data.error?.message || `HTTP ${resp.status}` };
    const acct = data.account_id ? String(data.account_id) : null;
    const acctAct = acct ? (acct.startsWith('act_') ? acct : `act_${acct}`) : null;
    if (!acctAct) return { error: 'no account_id in response' };
    return { accountId: acctAct, adName: data.name || null, isTrusted: isTrusted(acctAct), status: data.effective_status };
  } catch (e) {
    return { error: e.message };
  }
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log('║      BRIEF PIPELINE CONTAMINATION VERIFICATION                    ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');

  // ── 1. Headline counts ──────────────────────────────────────────
  console.log('\n[1/5] Headline counts');
  const refCounts = await q(`
    SELECT source, COALESCE(is_quarantined,FALSE) AS quarantined, status, COUNT(*)::int AS n
      FROM brief_pipeline_references
     GROUP BY source, COALESCE(is_quarantined,FALSE), status
     ORDER BY n DESC
  `);
  console.log('   brief_pipeline_references by (source, quarantined, status):');
  for (const r of refCounts) {
    console.log(`     ${String(r.source).padEnd(8)} ${r.quarantined ? '🔴 QUARANTINED' : '🟢 active     '} status=${String(r.status).padEnd(13)} → ${r.n} rows`);
  }

  const caCounts = await q(`
    SELECT
      COUNT(*)::int AS total,
      SUM(CASE WHEN meta_ad_id IS NOT NULL THEN 1 ELSE 0 END)::int AS with_meta_ad_id,
      SUM(CASE WHEN COALESCE(is_linkage_quarantined,FALSE) THEN 1 ELSE 0 END)::int AS linkage_quarantined,
      SUM(CASE WHEN meta_account_verified_at IS NOT NULL THEN 1 ELSE 0 END)::int AS verified_stamped,
      SUM(CASE WHEN meta_account_verified_at >= NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END)::int AS verified_fresh
      FROM creative_analysis
  `);
  console.log('   creative_analysis:');
  console.log(`     total=${caCounts[0].total} with_meta_ad_id=${caCounts[0].with_meta_ad_id} linkage_quarantined=${caCounts[0].linkage_quarantined} verified_stamped=${caCounts[0].verified_stamped} verified_fresh=${caCounts[0].verified_fresh}`);

  // ── 2. Foreign-brand transcript scan (pre-fix surface) ──────────
  console.log('\n[2/5] Transcript foreign-brand scan');
  const dirty = await q(`
    SELECT id, ad_archive_id, headline, status, COALESCE(is_quarantined,FALSE) AS quarantined,
           LEFT(transcript, 200) AS transcript_head
      FROM brief_pipeline_references
     WHERE source = 'meta'
       AND transcript IS NOT NULL
       AND transcript ~* '\\m(ALDI|LIDL|WALMART|TESCO|COSTCO|CARREFOUR|KROGER|JD\\s*SPORTS|MARBLE BLAST|TRENITALIA|FRECCIA|NORSE ORGANIC|H&M|ZARA)\\M'
     ORDER BY created_at DESC
  `);
  if (dirty.length === 0) {
    console.log('   🟢 ZERO refs with foreign-brand transcript signal.');
  } else {
    console.log(`   🔴 ${dirty.length} refs flagged. Detail:`);
    for (const r of dirty) {
      console.log(`     [${r.quarantined ? 'Q' : ' '}] id=${r.id} ad=${r.ad_archive_id} status=${r.status}`);
      console.log(`         headline: ${(r.headline || '').slice(0, 80)}`);
      console.log(`         transcript: ${(r.transcript_head || '').replace(/\s+/g, ' ').slice(0, 150)}`);
    }
  }

  // ── 3. Re-resolve ownership for every non-quarantined META ref ──
  console.log('\n[3/5] Live Meta ownership re-check for every active META ref');
  const live = await q(`
    SELECT id, ad_archive_id, headline, imported_metadata, status
      FROM brief_pipeline_references
     WHERE source = 'meta' AND COALESCE(is_quarantined,FALSE) = FALSE
     ORDER BY created_at DESC
  `);
  console.log(`   ${live.length} active META refs to verify…`);
  let okCount = 0, foreignCount = 0, errCount = 0;
  const foreigners = [];
  for (const r of live) {
    let md = r.imported_metadata;
    if (typeof md === 'string') { try { md = JSON.parse(md); } catch { md = null; } }
    const metaAdId = md?.ad_id || r.ad_archive_id || null;
    if (!metaAdId) { errCount++; continue; }
    const owned = await resolveOwnership(metaAdId);
    if (owned.error) {
      errCount++;
    } else if (!owned.isTrusted) {
      foreignCount++;
      foreigners.push({ id: r.id, ad_archive_id: r.ad_archive_id, headline: r.headline, foreign_account: owned.accountId, meta_ad_name: owned.adName });
    } else {
      okCount++;
    }
  }
  console.log(`   🟢 owned_ok=${okCount}   🔴 foreign=${foreignCount}   ⚠ meta_error=${errCount}`);
  if (foreigners.length) {
    console.log('   Foreign-account refs (will be quarantined in step 4):');
    for (const f of foreigners) {
      console.log(`     id=${f.id} headline="${(f.headline || '').slice(0, 60)}" → Meta account ${f.foreign_account} (Meta name: "${(f.meta_ad_name || '').slice(0, 50)}")`);
    }
  }

  // ── 4. Quarantine the foreigners ────────────────────────────────
  console.log('\n[4/5] Quarantine foreign-account refs');
  if (foreigners.length === 0) {
    console.log('   🟢 Nothing to quarantine.');
  } else {
    for (const f of foreigners) {
      const reason = `Live re-audit ${new Date().toISOString().slice(0,10)}: Meta ad ${f.ad_archive_id} (${f.meta_ad_name || 'unnamed'}) belongs to account ${f.foreign_account}, NOT Mineblock's.`;
      await q(
        `UPDATE brief_pipeline_references
            SET is_quarantined = TRUE, quarantine_reason = $1, quarantined_at = NOW(),
                status = 'error', analysis_error = $1, updated_at = NOW()
          WHERE id = $2`,
        [reason, f.id]
      );
      console.log(`   🔴→Q  id=${f.id} quarantined`);
    }
  }

  // ── 5. Post-quarantine confirmation ─────────────────────────────
  console.log('\n[5/5] Post-quarantine state');
  const after = await q(`
    SELECT
      SUM(CASE WHEN COALESCE(is_quarantined,FALSE) THEN 1 ELSE 0 END)::int AS quarantined,
      SUM(CASE WHEN COALESCE(is_quarantined,FALSE) = FALSE THEN 1 ELSE 0 END)::int AS active,
      COUNT(*)::int AS total
      FROM brief_pipeline_references WHERE source = 'meta'
  `);
  const a = after[0];
  console.log(`   meta refs:  total=${a.total}  🟢 active=${a.active}  🔴 quarantined=${a.quarantined}`);
  const stillDirty = await q(`
    SELECT COUNT(*)::int AS n FROM brief_pipeline_references
     WHERE source = 'meta'
       AND COALESCE(is_quarantined,FALSE) = FALSE
       AND transcript IS NOT NULL
       AND transcript ~* '\\m(ALDI|LIDL|WALMART|TESCO|COSTCO|CARREFOUR|KROGER|JD\\s*SPORTS|MARBLE BLAST|TRENITALIA|FRECCIA|NORSE ORGANIC|H&M|ZARA)\\M'
  `);
  console.log(`   active refs with foreign-brand transcript signal: ${stillDirty[0].n}`);

  // ── Verdict ────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  if (stillDirty[0].n === 0 && foreignCount === 0) {
    console.log('║  ✅ VERDICT: CLEAN — no foreign content in any active META ref     ║');
  } else if (stillDirty[0].n === 0) {
    console.log(`║  ✅ VERDICT: CLEAN after quarantine — ${foreignCount} foreign refs locked     ║`);
  } else {
    console.log(`║  ⚠ VERDICT: ${stillDirty[0].n} active refs still show foreign brand text            ║`);
  }
  console.log('╚══════════════════════════════════════════════════════════════════╝\n');

  await pool.end();
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
