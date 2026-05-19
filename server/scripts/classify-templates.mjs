/**
 * classify-templates.mjs
 *
 * Async one-time job: iterates all statics_templates where is_document_template IS NULL
 * (unclassified), sends the thumbnail to Claude Vision, classifies it as document or
 * image-based, and writes the result back to the DB.
 *
 * Also extracts compatible angle_tags based on archetype and content signals.
 *
 * Usage:
 *   node server/scripts/classify-templates.mjs
 *   node server/scripts/classify-templates.mjs --limit=100   # dry run a subset
 *   node server/scripts/classify-templates.mjs --dry-run     # log only, no DB writes
 *
 * Runs against DATABASE_URL and ANTHROPIC_API_KEY from .env
 */

import 'dotenv/config';
import postgres from 'postgres';
import Anthropic from '@anthropic-ai/sdk';

const isDryRun  = process.argv.includes('--dry-run');
const limitArg  = process.argv.find(a => a.startsWith('--limit='));
const MAX_ROWS  = limitArg ? parseInt(limitArg.split('=')[1]) : Infinity;
const BATCH     = 10; // concurrent Claude calls
const DELAY_MS  = 500; // ms between batches (rate limit buffer)

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 5 });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Angle tag mapping by archetype ──────────────────────────────────────────
const ARCHETYPE_ANGLE_TAGS = {
  document:        ['apology', 'anti_fake', 'skeptic', 'hater_deflection'],
  testimonial:     ['social_proof', 'skeptic', 'accidental_winner'],
  problem_solution:['skeptic', 'anti_fake', 'urgency'],
  bold_claim:      ['anti_fake', 'ai_chip_pov', 'skeptic'],
  before_after:    ['skeptic', 'accidental_winner'],
  urgency:         ['urgency', 'promo'],
  us_vs_them:      ['anti_fake', 'hater_deflection'],
  social_proof:    ['social_proof', 'accidental_winner'],
  native:          ['skeptic', 'apology', 'ai_chip_pov'],
  meme:            ['hater_deflection', 'accidental_winner', 'anti_fake'],
  google_search:   ['skeptic', 'anti_fake'],
  apple_notes:     ['apology', 'skeptic', 'accidental_winner'],
  statistics:      ['ai_chip_pov', 'skeptic', 'blockchain_proof'],
  feature_benefit: ['ai_chip_pov', 'promo', 'urgency'],
  headline:        ['bold_claim', 'urgency', 'promo'],
};

const CLASSIFICATION_PROMPT = `You are classifying advertisement templates to determine their rendering strategy.

Look at this ad template image and answer these questions in JSON:

1. is_document_template: Is the background primarily TEXT (like a letter, apology statement, correction notice, editorial, or document with paragraphs of body copy)? Answer TRUE. OR is the background primarily an IMAGE, product photo, or graphical design with overlaid short text? Answer FALSE.

2. archetype: The single best category from this list:
   document | testimonial | problem_solution | bold_claim | before_after | urgency | us_vs_them | social_proof | native | meme | google_search | apple_notes | statistics | feature_benefit | headline | other

3. angle_tags: Array of compatible ad angles (pick 2-4 from):
   apology | anti_fake | skeptic | accidental_winner | hater_deflection | ai_chip_pov | promo | urgency | social_proof | blockchain_proof | bold_claim

4. confidence: Your confidence in this classification: high | medium | low

Respond ONLY with valid JSON, no commentary:
{
  "is_document_template": true/false,
  "archetype": "...",
  "angle_tags": ["...", "..."],
  "confidence": "high|medium|low",
  "reasoning": "one sentence"
}`;

async function classifyTemplate(template) {
  const { id, image_url, name, category } = template;

  // Determine image source for Claude
  let imageContent;
  if (!image_url) {
    // No thumbnail — classify by name/category heuristic
    return classifyByHeuristic(template);
  }

  try {
    if (image_url.startsWith('data:image/')) {
      // Inline base64
      const [header, base64] = image_url.split(',');
      const mediaType = header.replace('data:', '').replace(';base64', '');
      imageContent = { type: 'base64', media_type: mediaType, data: base64 };
    } else if (image_url.startsWith('http')) {
      imageContent = { type: 'url', url: image_url };
    } else {
      // Relative path or unknown — fallback to heuristic
      return classifyByHeuristic(template);
    }

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',  // cheapest, fast enough for vision classification
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: imageContent },
          { type: 'text', text: CLASSIFICATION_PROMPT }
        ]
      }]
    });

    const text = response.content[0]?.text?.trim() || '';
    // Extract JSON (sometimes Claude adds surrounding text despite instructions)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`No JSON in response: ${text.substring(0, 100)}`);
    const parsed = JSON.parse(jsonMatch[0]);

    return {
      id,
      is_document_template: parsed.is_document_template === true,
      archetype:            parsed.archetype || 'other',
      angle_tags:           Array.isArray(parsed.angle_tags) ? parsed.angle_tags : [],
      classification_method: 'claude_vision',
      confidence:           parsed.confidence || 'medium',
      reasoning:            parsed.reasoning || '',
    };
  } catch (err) {
    console.warn(`  ⚠️  Claude Vision failed for ${id.substring(0,8)} (${name?.substring(0,30)}): ${err.message} — using heuristic fallback`);
    return classifyByHeuristic(template);
  }
}

function classifyByHeuristic(template) {
  const { id, name, category } = template;
  const nameL = (name || '').toLowerCase();
  const catL  = (category || '').toLowerCase();

  const isDoc =
    catL.includes('apolog') || nameL.includes('apolog') ||
    catL.includes('correction') || nameL.includes('correction') ||
    catL.includes('editorial') || nameL.includes('letter') ||
    nameL.includes('statement') || nameL.includes('official');

  const archetype = catL.includes('testimonial') ? 'testimonial'
    : catL.includes('social proof') ? 'social_proof'
    : catL.includes('problem') ? 'problem_solution'
    : catL.includes('bold') ? 'bold_claim'
    : catL.includes('urgency') ? 'urgency'
    : catL.includes('vs') || catL.includes('them') ? 'us_vs_them'
    : catL.includes('before') ? 'before_after'
    : catL.includes('native') ? 'native'
    : catL.includes('meme') ? 'meme'
    : catL.includes('google') ? 'google_search'
    : catL.includes('apple') ? 'apple_notes'
    : catL.includes('statistic') ? 'statistics'
    : catL.includes('feature') ? 'feature_benefit'
    : isDoc ? 'document'
    : 'other';

  return {
    id,
    is_document_template: isDoc,
    archetype,
    angle_tags: ARCHETYPE_ANGLE_TAGS[archetype] || [],
    classification_method: 'heuristic',
    confidence: 'low',
    reasoning: `Classified by name/category heuristic (no Claude Vision)`,
  };
}

async function writeResults(results) {
  if (isDryRun) {
    console.log('[DRY RUN] Would write:', results.map(r => `${r.id.substring(0,8)} → ${r.is_document_template ? '📄 doc' : '🖼️  img'} (${r.archetype})`).join(', '));
    return;
  }

  for (const r of results) {
    await sql`
      UPDATE statics_templates SET
        is_document_template  = ${r.is_document_template},
        archetype             = ${r.archetype},
        angle_tags            = ${sql.array(r.angle_tags)},
        classification_method = ${r.classification_method},
        classified_at         = NOW()
      WHERE id = ${r.id}
    `;
  }
}

async function main() {
  console.log(`🔍 Template Classification Job starting`);
  console.log(`   Mode: ${isDryRun ? 'DRY RUN (no DB writes)' : 'LIVE'}`);
  console.log(`   Max rows: ${MAX_ROWS === Infinity ? 'all' : MAX_ROWS}`);
  console.log(`   Batch size: ${BATCH}`);

  // Count unclassified
  const [{ count }] = await sql`SELECT COUNT(*) FROM statics_templates WHERE is_document_template IS NULL`;
  const total = Math.min(parseInt(count), MAX_ROWS);
  console.log(`   Unclassified templates: ${count} | Processing: ${total}\n`);

  if (total === 0) {
    console.log('✅ All templates already classified. Nothing to do.');
    await sql.end();
    return;
  }

  let processed = 0;
  let docCount = 0;
  let imgCount = 0;
  let errorCount = 0;

  // Fetch in pages to avoid loading 1738 thumbnails at once
  const PAGE_SIZE = 50;
  let offset = 0;

  while (processed < total) {
    const rows = await sql`
      SELECT id, name, category, image_url
      FROM statics_templates
      WHERE is_document_template IS NULL
      ORDER BY id
      LIMIT ${Math.min(PAGE_SIZE, total - processed)}
      OFFSET ${offset}
    `;
    if (rows.length === 0) break;

    // Process in concurrent batches of BATCH
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const results = await Promise.all(chunk.map(classifyTemplate));

      // Log results
      for (const r of results) {
        const icon = r.is_document_template ? '📄' : '🖼️ ';
        const conf = r.confidence === 'high' ? '✓' : r.confidence === 'medium' ? '~' : '?';
        console.log(`  ${icon} [${conf}] ${r.id.substring(0,8)} → ${r.archetype} | tags:${r.angle_tags.slice(0,3).join(',')} | ${r.classification_method}`);
        if (r.is_document_template) docCount++; else imgCount++;
      }

      try {
        await writeResults(results);
      } catch (writeErr) {
        console.error(`  ❌ DB write failed for batch: ${writeErr.message}`);
        errorCount++;
      }

      processed += chunk.length;
      console.log(`  Progress: ${processed}/${total} (📄 ${docCount} doc, 🖼️  ${imgCount} img, ❌ ${errorCount} err)\n`);

      if (i + BATCH < rows.length) await new Promise(r => setTimeout(r, DELAY_MS));
    }

    offset += PAGE_SIZE;
  }

  console.log('\n✅ Classification complete');
  console.log(`   Total processed: ${processed}`);
  console.log(`   Document templates: ${docCount}`);
  console.log(`   Image templates:    ${imgCount}`);
  console.log(`   Errors:             ${errorCount}`);

  await sql.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
