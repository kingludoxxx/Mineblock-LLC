import { Router } from 'express';
import { pgQuery } from '../db/pg.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = Router();

router.use(authenticate, requirePermission('products', 'access'));

// ── MinerForge Pro — Canonical Angle Library ────────────────────────────────
// Seeded on startup if the product has fewer than 6 angles.
// Update this array to add, remove, or edit angles — then redeploy.

const MINERFORGE_ANGLES = [
  {
    id: 'angle_seed_001',
    name: 'Anti-Fake / Competitor Callout',
    funnel_stage: 'middle',
    hook_strategy: 'Voice his suspicion BEFORE he can use it as a reason to scroll. He is in filtering mode, not buying mode — this angle has to pass his filter first, then convert him.',
    lead_with: 'The market is flooded with fakes and he already suspects it. Most miners you see in your feed never actually mine. We tested the knockoffs — zero blockchain activity. MinerForge Pro is the original. Verified on chain. You can check it yourself right now.',
    tone: 'Confident and evidence-based. Slightly confrontational toward the fakes — never defensive about MinerForge Pro. The tone of a company with nothing to hide. Calm authority, not anger.',
    copy_directives: `- Open by voicing his suspicion — agree with his filter before trying to pass it
- Immediately give him the verification mechanism: blockchain data is neutral, public, unfakeable
- Show the specific contrast: competitor dashboard shows numbers / competitor blockchain shows nothing
- MinerForge Pro: real blockchain activity, publicly verifiable
- Never be defensive about the category — be the product that proves itself
- Lead with external proof, never brand claims
- End with a "verify yourself" CTA — pull up any block explorer right now`,
    required_elements: [
      'Competitor comparison showing zero blockchain activity',
      'MinerForge Pro blockchain activity (specific, verifiable)',
      '"Verify yourself" call to action',
      'Block explorer reference — tell them exactly where to look',
    ],
    headline_examples: [
      'Not all miners actually mine',
      'We tested the knockoffs. Zero blockchain activity.',
      'Their dashboard shows numbers. Their blockchain shows nothing.',
      'Same look. No actual mining.',
      'The blockchain does not lie.',
      'Check the blockchain. Find zero.',
      'Real mining vs screen animation.',
    ],
    banned_phrases: ['trust us', 'best miner', 'buy now', 'limited time offer', 'join thousands'],
    created_at: new Date().toISOString(),
  },
  {
    id: 'angle_seed_002',
    name: 'Skeptic to Believer / Blockchain Proof',
    funnel_stage: 'middle',
    hook_strategy: 'Put someone exactly like him on screen — a skeptic who went and checked the data himself. Walk through the blockchain verification step by step. Specific block numbers are not optional — they are the proof. Remove them and the angle collapses into another unverifiable claim.',
    lead_with: 'I was certain this was a scam. So I checked the blockchain myself. Block 891,612. Solo mined. One miner. One wallet. Full reward. These are not coming from warehouses. Small devices sitting on desks somewhere.',
    tone: 'First-person skeptic voice. Analytical, methodical, personal. Not a pitch — a discovery story told by someone who did the homework. He is walking the viewer through what he found, not what the company told him.',
    copy_directives: `- Open from the perspective of a skeptic who was exactly where the viewer is now
- Walk through the verification process step by step — not abstractly
- Use SPECIFIC block numbers (e.g. Block 891,612) — without specifics this is just another claim
- "Solo mined. One wallet. Full reward." — the three facts that prove it is real
- End at the pivot: "I stopped doubting and started running one"
- The blockchain does not care what anyone thinks — it just records what happened
- Viewer should feel like they watched someone do the research they would do`,
    required_elements: [
      'Specific block number (e.g. Block 891,612)',
      'Solo mine details: one miner, one wallet, full reward',
      'Block explorer — tell them exactly where to pull the data',
      'Personal pivot: skeptic → believer',
    ],
    headline_examples: [
      'I was certain this was a scam',
      'So I checked the blockchain myself',
      'Block 891,612. Solo mined.',
      'One miner. One wallet. Full reward.',
      'Small devices sitting on desks somewhere',
      'Solo blocks get found every single day',
      'The blockchain does not care what anyone thinks',
      'Pull up any block explorer right now',
    ],
    banned_phrases: ['you should trust', 'our company', 'we promise', 'guaranteed results', 'everyone is doing it'],
    created_at: new Date().toISOString(),
  },
  {
    id: 'angle_seed_003',
    name: 'Accidental Winner / Passive Success',
    funnel_stage: 'bottom',
    hook_strategy: 'Give him a face-saving justification for buying. The character did not buy because he believed in it — he bought to end a family argument. That gives this buyer permission to buy without admitting he is trying at something uncertain. The almost-unplugged moment is critical — it creates the retroactive near-miss that makes the outcome feel earned by the device, not lucky.',
    lead_with: 'He bought it to end a family argument. Plugged it in behind the TV stand. Forgot it existed. He checked it maybe twice — both times out of obligation. He almost unplugged it. Every 10 minutes that little device was quietly taking a shot. One Sunday morning, a notification he almost deleted as spam. 3.125 Bitcoin. Straight to his wallet.',
    tone: 'Story-driven, calm, unhurried. The tone of someone watching a movie. No urgency, no hype. The device did the work — not the buyer, not the brand. Understated is more powerful than excited.',
    copy_directives: `- Tell a story — the viewer is watching a character, not receiving a pitch
- The purchase motivation must be face-saving: bought to end an argument, not because he believed
- Plug in and forget — low commitment, no babysitting, no maintenance
- The almost-unplugged moment is mandatory — it creates the near-miss tension
- Resolution is quiet and specific: a notification he almost deleted as spam
- Use the exact figure: 3.125 Bitcoin (the current block reward) — specificity makes it real
- The device earns the win, not luck and not the buyer's effort
- Device works quietly in the background while he lives his normal life`,
    required_elements: [
      'Face-saving purchase motivation (ends an argument, not a big commitment)',
      'Plug in and forget — no monitoring required',
      'The almost-unplugged moment',
      'Specific block reward: 3.125 Bitcoin',
      'A notification he almost deleted as spam',
    ],
    headline_examples: [
      'He bought it to end a family argument',
      'Plugged it in behind the TV stand. Forgot it existed.',
      'He almost unplugged it',
      'Every 10 minutes that little device was quietly taking a shot',
      'One Sunday morning',
      '3.125 Bitcoin. Straight to his wallet.',
      'Set it. Forget it.',
      'Still trying while you sleep',
      'You never touch it again',
    ],
    banned_phrases: ['get rich quick', 'easy money', 'guaranteed win', 'you will definitely', 'passive income opportunity'],
    created_at: new Date().toISOString(),
  },
  {
    id: 'angle_seed_004',
    name: 'Hater Deflection',
    funnel_stage: 'bottom',
    hook_strategy: 'Mirror his internal skepticism as an external mocking comment. Then respond with confidence and minimal explanation. The less the brand explains itself the stronger the signal — long defensive responses tell him the hater might have been right. Short confident redirection to blockchain proof tells him the product does not need defending.',
    lead_with: '"You will never make anything with that 😂" — Still here. Still mining. 144 attempts since you said that. The blockchain disagrees.',
    tone: 'Confident, non-reactive, unshakeable. The tone of someone who does not need to win the argument because the data wins it for them. Never defensive, never angry. Walking away, not fighting back.',
    copy_directives: `- Open with a specific hater comment — the mockery voice activates his "prove them wrong" instinct
- Do NOT argue back — confidence is shown by not needing to argue
- Redirect immediately to blockchain data as the neutral third party
- "Still here. Still mining." — present tense, calm, undeniable
- Specific counter: 144 attempts since you said that (10 min intervals × 24 hrs = 144 per day)
- Short is stronger than long — every extra sentence is one more sign it needed defending
- End on "Check the ledger" — let the data speak, not the brand`,
    required_elements: [
      'Opening hater comment with laugh emoji (specific and realistic)',
      '"Still here. Still mining." response',
      '144 attempts stat (10-minute intervals × 24 hours)',
      'Blockchain reference as neutral proof — "Check the ledger"',
    ],
    headline_examples: [
      '"You will never make anything with that 😂"',
      '"Nobody wins those 😂"',
      '"Good luck with your little toy miner 😂"',
      'Still here. Still mining.',
      'Blockchain disagrees.',
      '144 attempts since you said that',
      'Check the ledger.',
      'Everyone has an opinion until you show them the data',
      'The proof is on the blockchain. Not in the comments.',
    ],
    banned_phrases: ['actually...', 'let me explain', 'you are wrong because', 'statistics show', 'many experts'],
    created_at: new Date().toISOString(),
  },
  {
    id: 'angle_seed_005',
    name: 'Apology / False Confession',
    funnel_stage: 'bottom',
    hook_strategy: 'Open with a confession that signals honesty. Rebuild every product claim inside that trust framework using the yes ladder — restating facts as verified truths one by one. Keep the confession itself minor — the price being lower than promised is perfect. A more serious admission would undermine the product. Then close with the corrected offer and the guarantee.',
    lead_with: 'I owe you an apology. I got one thing wrong. Two years later I am correcting the record. I told people the launch price was the best deal. It was not. The price is lower now than when I launched it.',
    tone: 'Honest, slightly humble, direct. Not apologetic to the point of weakness — correcting the record like a confident person who is not afraid to admit a small mistake. The honesty is what earns the trust, not the severity of the admission.',
    copy_directives: `- Open with the apology — "I owe you an apology" — no preamble, no setup
- Keep the confession minor: the price was lower than I claimed, not a product failure
- Rebuild trust claim by claim using the yes ladder: "Yes it is true that... yes it is true that..."
- Each "yes" restates a product fact as a verified truth the listener already suspects is real
- Include: people message me not because they won, but because they feel like they have a real shot
- Close with the corrected price and the 30-day guarantee
- The honesty signal is the conversion mechanism — once he trusts the messenger, the product sells itself`,
    required_elements: [
      '"I owe you an apology" opening — no setup, no preamble',
      'The false confession: price lower than originally claimed',
      'Yes ladder: "Yes it is true that..." × 3 product claims',
      '"They message me not because they won — because for the first time they feel like they have a real shot"',
      'Corrected price + 30-day guarantee close',
    ],
    headline_examples: [
      'I owe you an apology',
      'I got one thing wrong',
      'Two years later I am correcting the record',
      'I told people the launch price was the best deal. It was not.',
      'Yes it is true that...',
      'Here is what I should have told you from the start',
      'I lied about one thing. The price.',
    ],
    banned_phrases: ['act now', 'limited supply', 'selling out fast', 'do not miss out', 'last chance'],
    created_at: new Date().toISOString(),
  },
  {
    id: 'angle_seed_006',
    name: 'AI Chip POV / Mechanism Explainer',
    funnel_stage: 'middle',
    hook_strategy: 'Make the technology feel alive and simple. Each "I am" statement is a product claim delivered without feeling like a pitch. The chip speaks in first person — this neutrality removes the sales layer and lets the mechanism explain itself directly. The chip does not want anything from the buyer. It just explains what it does.',
    lead_with: 'I am the chip inside MinerForge Pro. I try every 10 minutes. Forever. I am solo mining — no pool, no splitting with thousands of strangers. If we find a block, everything goes to your wallet. I am 1 watt. 11 cents a month. I never stop. You never have to.',
    tone: 'Factual, direct, mechanical. First-person chip voice — not enthusiastic, not salesy. The chip has no agenda. It states facts and only facts. The calm authority of something that does exactly one thing and does it without stopping.',
    copy_directives: `- The chip speaks in first person throughout — never break to third person
- "I am" structure for each claim: feature → what it means for the buyer
- NEVER use sales language — the chip does not sell, it describes
- Cover the four key facts in order: attempts (144/day), solo mining, power draw (1W/11¢), blockchain verification
- The blockchain verification is the credibility anchor — "every attempt is real and public"
- End on the loop: "You plug me in once and I never stop trying" — the device does the work forever
- Demystify without jargon — after hearing this, he can explain it to a skeptical partner`,
    required_elements: [
      '"I am the chip inside MinerForge Pro" opening line',
      '144 attempts per day (every 10 minutes)',
      'Solo mining — no pool, no splitting, full reward to your wallet',
      '1 watt power draw — approximately 11 cents per month',
      'Blockchain verification — every attempt is real and public',
      '"You plug me in once and I never stop trying" closing',
    ],
    headline_examples: [
      'I am the chip inside MinerForge Pro',
      'I try every 10 minutes. Forever.',
      'I am solo mining. No pool. No splitting.',
      'If we find a block everything goes to your wallet',
      'I am 1 watt. 11 cents a month.',
      'I am blockchain verified. Every attempt is real and public.',
      'I never stop. You never have to.',
      '144 times per day. Automatically. Without you lifting a finger.',
      'You plug me in once and I never stop trying',
    ],
    banned_phrases: ['buy now', 'incredible opportunity', 'amazing results', 'you will love', 'everyone is talking about'],
    created_at: new Date().toISOString(),
  },
];

let tableReady = false;

// ── Ensure Table Exists ─────────────────────────────────────────────

async function ensureTable() {
  if (tableReady) return;

  await pgQuery(`
    CREATE TABLE IF NOT EXISTS product_profiles (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      price TEXT,
      category TEXT DEFAULT 'supplement',
      logo_url TEXT,
      product_code TEXT,
      logos JSONB DEFAULT '[]',
      fonts JSONB DEFAULT '[]',
      product_images JSONB DEFAULT '[]',
      oneliner TEXT,
      tagline TEXT,
      customer_avatar TEXT,
      customer_frustration TEXT,
      customer_dream TEXT,
      big_promise TEXT,
      mechanism TEXT,
      differentiator TEXT,
      voice TEXT,
      guarantee TEXT,
      benefits JSONB DEFAULT '[]',
      angles JSONB DEFAULT '[]',
      scripts JSONB DEFAULT '[]',
      offers JSONB DEFAULT '[]',
      target_demographics TEXT,
      brand_colors JSONB DEFAULT '{}',
      short_name TEXT,
      product_type TEXT,
      product_group TEXT,
      unit_details TEXT,
      product_url TEXT,
      pain_points TEXT,
      common_objections TEXT,
      winning_angles TEXT,
      custom_angles_text TEXT,
      compliance_restrictions TEXT,
      competitive_edge TEXT,
      offer_details TEXT,
      max_discount TEXT,
      discount_codes TEXT,
      bundle_variants TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Migrations for existing tables
  await pgQuery(`
    DO $$ BEGIN
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS logos JSONB DEFAULT '[]';
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS fonts JSONB DEFAULT '[]';
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS product_code TEXT;
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS short_name TEXT;
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS product_type TEXT;
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS product_group TEXT;
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS unit_details TEXT;
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS product_url TEXT;
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS pain_points TEXT;
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS common_objections TEXT;
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS winning_angles TEXT;
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS custom_angles_text TEXT;
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS compliance_restrictions TEXT;
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS competitive_edge TEXT;
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS offer_details TEXT;
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS max_discount TEXT;
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS discount_codes TEXT;
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS bundle_variants TEXT;
      ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS notes TEXT;
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$;
  `);

  tableReady = true;
}

ensureTable().then(seedMinerAngles).catch(console.error);

// ── Seed MinerForge Pro angles on startup ───────────────────────────────────
// Runs once per server start. Skips if the product already has 6+ angles.
// To force re-seed: temporarily change the condition below to angles.length < 999.

async function seedMinerAngles() {
  try {
    const products = await pgQuery(
      `SELECT id, angles FROM product_profiles WHERE name ILIKE '%miner%forge%' ORDER BY updated_at DESC LIMIT 1`
    );
    if (!products.length) {
      console.log('[productProfiles] seedMinerAngles: no MinerForge product found — skipping');
      return;
    }
    const product = products[0];
    let existing = product.angles;
    if (typeof existing === 'string') { try { existing = JSON.parse(existing); } catch { existing = []; } }
    if (!Array.isArray(existing)) existing = [];

    if (existing.length >= MINERFORGE_ANGLES.length) {
      console.log(`[productProfiles] seedMinerAngles: product ${product.id} already has ${existing.length} angles — skipping`);
      return;
    }

    await pgQuery(
      `UPDATE product_profiles SET angles = $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(MINERFORGE_ANGLES), product.id]
    );
    console.log(`[productProfiles] seedMinerAngles: wrote ${MINERFORGE_ANGLES.length} angles to product ${product.id}`);
  } catch (err) {
    console.error('[productProfiles] seedMinerAngles error:', err.message);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

const UPDATABLE_FIELDS = [
  'name', 'description', 'price', 'category', 'product_code', 'logo_url', 'logos', 'fonts', 'product_images',
  'oneliner', 'tagline', 'customer_avatar', 'customer_frustration',
  'customer_dream', 'big_promise', 'mechanism', 'differentiator', 'voice',
  'guarantee', 'benefits', 'angles', 'scripts', 'offers',
  'target_demographics', 'brand_colors',
  'short_name', 'product_type', 'product_group', 'unit_details', 'product_url',
  'pain_points', 'common_objections', 'winning_angles', 'custom_angles_text',
  'compliance_restrictions', 'competitive_edge', 'offer_details',
  'max_discount', 'discount_codes', 'bundle_variants', 'notes',
];

const JSONB_FIELDS = new Set([
  'product_images', 'logos', 'fonts', 'benefits', 'angles', 'scripts', 'offers', 'brand_colors',
]);

// postgres.js unsafe() returns JSONB columns as strings — parse them before sending
function parseRow(row) {
  if (!row) return row;
  const out = { ...row };
  for (const field of JSONB_FIELDS) {
    if (typeof out[field] === 'string') {
      try { out[field] = JSON.parse(out[field]); } catch { out[field] = field === 'brand_colors' ? {} : []; }
    }
  }
  return out;
}

// ── GET / — List all profiles ───────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    await ensureTable();
    // Only select lightweight columns for the list view — skip product_images, logos, fonts, scripts
    // which can be megabytes of data (2.7MB+). Detail view (GET /:id) returns everything.
    const rows = await pgQuery(`
      SELECT id, name, short_name, product_code, category, price, description, big_promise, mechanism,
             differentiator, customer_avatar, voice, competitive_edge, guarantee, benefits, angles,
             target_demographics, customer_frustration, customer_dream, pain_points, common_objections,
             winning_angles, custom_angles_text, max_discount, discount_codes, bundle_variants,
             offer_details, compliance_restrictions, brand_colors, offers,
             product_images->>0 AS first_image,
             created_at, updated_at
      FROM product_profiles ORDER BY updated_at DESC
    `);
    return res.json({ success: true, data: rows.map(parseRow) });
  } catch (err) {
    console.error('GET /product-profiles error:', err);
    return res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── GET /:id — Get single profile ───────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    await ensureTable();
    const rows = await pgQuery('SELECT * FROM product_profiles WHERE id = $1', [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: { message: 'Profile not found' } });
    }
    return res.json({ success: true, data: parseRow(rows[0]) });
  } catch (err) {
    console.error('GET /product-profiles/:id error:', err);
    return res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── POST / — Create profile ─────────────────────────────────────────

router.post('/', async (req, res) => {
  try {
    await ensureTable();

    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: { message: 'name is required' } });
    }

    const fields = ['name'];
    const values = [name.trim()];
    let idx = 2;

    for (const field of UPDATABLE_FIELDS) {
      if (field === 'name') continue;
      if (req.body[field] !== undefined) {
        fields.push(field);
        const v = req.body[field];
        values.push(JSONB_FIELDS.has(field) ? (typeof v === 'string' ? v : JSON.stringify(v)) : v);
        idx++;
      }
    }

    const placeholders = fields.map((f, i) => JSONB_FIELDS.has(f) ? `$${i + 1}::jsonb` : `$${i + 1}`).join(', ');
    const columns = fields.join(', ');

    const rows = await pgQuery(
      `INSERT INTO product_profiles (${columns}) VALUES (${placeholders}) RETURNING *`,
      values
    );

    return res.status(201).json({ success: true, data: parseRow(rows[0]) });
  } catch (err) {
    console.error('POST /product-profiles error:', err);
    return res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── PUT /:id — Update profile ───────────────────────────────────────

router.put('/:id', async (req, res) => {
  try {
    await ensureTable();

    const setClauses = [];
    const values = [];
    let idx = 1;

    for (const field of UPDATABLE_FIELDS) {
      if (req.body[field] !== undefined) {
        if (JSONB_FIELDS.has(field)) {
          setClauses.push(`${field} = $${idx}::jsonb`);
          const v = req.body[field];
          values.push(typeof v === 'string' ? v : JSON.stringify(v));
        } else {
          setClauses.push(`${field} = $${idx}`);
          values.push(req.body[field]);
        }
        idx++;
      }
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ success: false, error: { message: 'No fields to update' } });
    }

    setClauses.push(`updated_at = NOW()`);
    values.push(req.params.id);

    const rows = await pgQuery(
      `UPDATE product_profiles SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      values,
      { timeout: 30_000 } // 30s for large base64 image payloads
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: { message: 'Profile not found' } });
    }

    return res.json({ success: true, data: parseRow(rows[0]) });
  } catch (err) {
    console.error('PUT /product-profiles/:id error:', err);
    return res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── DELETE /:id — Delete profile ────────────────────────────────────

router.delete('/:id', async (req, res) => {
  try {
    await ensureTable();
    const rows = await pgQuery(
      'DELETE FROM product_profiles WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: { message: 'Profile not found' } });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('DELETE /product-profiles/:id error:', err);
    return res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── POST /:id/images — Add image URL ───────────────────────────────

router.post('/:id/images', async (req, res) => {
  try {
    await ensureTable();
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ success: false, error: { message: 'url is required' } });
    }

    const rows = await pgQuery(
      `UPDATE product_profiles
       SET product_images = product_images || $1::jsonb,
           updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [JSON.stringify([url]), req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: { message: 'Profile not found' } });
    }
    return res.json({ success: true, data: parseRow(rows[0]) });
  } catch (err) {
    console.error('POST /product-profiles/:id/images error:', err);
    return res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── DELETE /:id/images — Remove image URL ───────────────────────────

router.delete('/:id/images', async (req, res) => {
  try {
    await ensureTable();
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ success: false, error: { message: 'url is required' } });
    }

    const rows = await pgQuery(
      `UPDATE product_profiles
       SET product_images = (
         SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
         FROM jsonb_array_elements(product_images) AS elem
         WHERE elem #>> '{}' != $1
       ),
       updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [url, req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: { message: 'Profile not found' } });
    }
    return res.json({ success: true, data: parseRow(rows[0]) });
  } catch (err) {
    console.error('DELETE /product-profiles/:id/images error:', err);
    return res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── POST /:id/scripts — Add script ─────────────────────────────────

router.post('/:id/scripts', async (req, res) => {
  try {
    await ensureTable();
    const { title, content, type } = req.body;
    if (!title || !content) {
      return res.status(400).json({ success: false, error: { message: 'title and content are required' } });
    }

    const script = {
      id: `script_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      title,
      content,
      type: type || 'other',
      created_at: new Date().toISOString(),
    };

    const rows = await pgQuery(
      `UPDATE product_profiles
       SET scripts = scripts || $1::jsonb,
           updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [JSON.stringify([script]), req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: { message: 'Profile not found' } });
    }
    return res.json({ success: true, data: parseRow(rows[0]) });
  } catch (err) {
    console.error('POST /product-profiles/:id/scripts error:', err);
    return res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── DELETE /:id/scripts/:scriptId — Remove script ───────────────────

router.delete('/:id/scripts/:scriptId', async (req, res) => {
  try {
    await ensureTable();

    const rows = await pgQuery(
      `UPDATE product_profiles
       SET scripts = (
         SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
         FROM jsonb_array_elements(scripts) AS elem
         WHERE elem->>'id' != $1
       ),
       updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [req.params.scriptId, req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: { message: 'Profile not found' } });
    }
    return res.json({ success: true, data: parseRow(rows[0]) });
  } catch (err) {
    console.error('DELETE /product-profiles/:id/scripts/:scriptId error:', err);
    return res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── POST /:id/angles — Add angle ───────────────────────────────────
// Full angle schema:
// { name, funnel_stage, hook_strategy, lead_with, tone, copy_directives,
//   required_elements[], headline_examples[], banned_phrases[], color_style }

router.post('/:id/angles', async (req, res) => {
  try {
    await ensureTable();
    const {
      name, funnel_stage, hook_strategy, lead_with, tone,
      copy_directives, required_elements, headline_examples, banned_phrases, color_style,
    } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, error: { message: 'name is required' } });
    }

    const angle = {
      id: `angle_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      funnel_stage: funnel_stage || '',
      hook_strategy: hook_strategy || '',
      lead_with: lead_with || '',
      tone: tone || '',
      copy_directives: copy_directives || '',
      required_elements: Array.isArray(required_elements) ? required_elements : [],
      headline_examples: Array.isArray(headline_examples) ? headline_examples : [],
      banned_phrases: Array.isArray(banned_phrases) ? banned_phrases : [],
      color_style: color_style || '',
      created_at: new Date().toISOString(),
    };

    const rows = await pgQuery(
      `UPDATE product_profiles
       SET angles = angles || $1::jsonb,
           updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [JSON.stringify([angle]), req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: { message: 'Profile not found' } });
    }
    return res.json({ success: true, data: parseRow(rows[0]) });
  } catch (err) {
    console.error('POST /product-profiles/:id/angles error:', err);
    return res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── PUT /:id/angles/:angleId — Update a single angle ──────────────

router.put('/:id/angles/:angleId', async (req, res) => {
  try {
    await ensureTable();
    const { id, angleId } = req.params;
    const {
      name, funnel_stage, hook_strategy, lead_with, tone,
      copy_directives, required_elements, headline_examples, banned_phrases, color_style,
    } = req.body;

    // Load the current angles array
    const rows = await pgQuery('SELECT angles FROM product_profiles WHERE id = $1', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: { message: 'Profile not found' } });
    }
    let angles = rows[0].angles;
    if (typeof angles === 'string') { try { angles = JSON.parse(angles); } catch { angles = []; } }
    if (!Array.isArray(angles)) angles = [];

    const idx = angles.findIndex(a => a.id === angleId);
    if (idx === -1) {
      return res.status(404).json({ success: false, error: { message: 'Angle not found' } });
    }

    const updated = {
      ...angles[idx],
      ...(name !== undefined && { name }),
      ...(funnel_stage !== undefined && { funnel_stage }),
      ...(hook_strategy !== undefined && { hook_strategy }),
      ...(lead_with !== undefined && { lead_with }),
      ...(tone !== undefined && { tone }),
      ...(copy_directives !== undefined && { copy_directives }),
      ...(Array.isArray(required_elements) && { required_elements }),
      ...(Array.isArray(headline_examples) && { headline_examples }),
      ...(Array.isArray(banned_phrases) && { banned_phrases }),
      ...(color_style !== undefined && { color_style }),
    };
    angles[idx] = updated;

    const result = await pgQuery(
      `UPDATE product_profiles SET angles = $1::jsonb, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [JSON.stringify(angles), id]
    );
    return res.json({ success: true, data: parseRow(result[0]) });
  } catch (err) {
    console.error('PUT /product-profiles/:id/angles/:angleId error:', err);
    return res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── DELETE /:id/angles/:angleId — Remove a single angle ────────────

router.delete('/:id/angles/:angleId', async (req, res) => {
  try {
    await ensureTable();
    const rows = await pgQuery(
      `UPDATE product_profiles
       SET angles = (
         SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
         FROM jsonb_array_elements(angles) AS elem
         WHERE elem->>'id' != $1
       ),
       updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [req.params.angleId, req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: { message: 'Profile not found' } });
    }
    return res.json({ success: true, data: parseRow(rows[0]) });
  } catch (err) {
    console.error('DELETE /product-profiles/:id/angles/:angleId error:', err);
    return res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── POST /:id/benefits — Add benefit ───────────────────────────────

router.post('/:id/benefits', async (req, res) => {
  try {
    await ensureTable();
    const { text } = req.body;
    if (!text) {
      return res.status(400).json({ success: false, error: { message: 'text is required' } });
    }

    const benefit = {
      id: `benefit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      text,
      created_at: new Date().toISOString(),
    };

    const rows = await pgQuery(
      `UPDATE product_profiles
       SET benefits = benefits || $1::jsonb,
           updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [JSON.stringify([benefit]), req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: { message: 'Profile not found' } });
    }
    return res.json({ success: true, data: parseRow(rows[0]) });
  } catch (err) {
    console.error('POST /product-profiles/:id/benefits error:', err);
    return res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── POST /:id/ai-fill — AI auto-fill from product URL ─────────────
router.post('/:id/ai-fill', async (req, res) => {
  try {
    await ensureTable();
    const { url } = req.body;
    if (!url || !url.trim()) {
      return res.status(400).json({ success: false, error: { message: 'url is required' } });
    }

    // Fetch the product page
    let pageContent;
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(15000),
      });
      pageContent = await resp.text();
      // Strip HTML tags for cleaner text, keep structure
      pageContent = pageContent
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 15000); // Limit to avoid token overflow
    } catch (fetchErr) {
      return res.status(400).json({ success: false, error: { message: `Failed to fetch URL: ${fetchErr.message}` } });
    }

    // Call Claude to extract product info
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic();

    const extraction = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `Analyze this product page content and extract ALL available product information. Return a JSON object with these fields (use empty string "" for any field you cannot determine):

{
  "name": "Full product name",
  "short_name": "Short/abbreviated name",
  "product_type": "Product type (e.g. Capsules, Powder, Cream, Software, Course)",
  "product_group": "Product category (e.g. Supplements, Skincare, SaaS)",
  "unit_details": "Unit/packaging info (e.g. 1 Jar / 24 Capsules, Monthly subscription)",
  "price": "Price as shown",
  "description": "Full product description and how it works (2-3 paragraphs)",
  "oneliner": "One punchy sentence about the product",
  "tagline": "Short marketing tagline",
  "big_promise": "The #1 transformation/result the product delivers",
  "mechanism": "How the product works — the unique mechanism or approach",
  "differentiator": "What makes this different from competitors",
  "customer_avatar": "Who is this product for — detailed customer profile",
  "customer_frustration": "What problems/frustrations does the customer have",
  "customer_dream": "What does the ideal outcome look like for the customer",
  "target_demographics": "Age, gender, location, income level etc.",
  "voice": "Brand voice and tone description",
  "pain_points": "Customer pain points and emotional triggers that drive purchase",
  "common_objections": "Common objections and how to handle them (bullet points with arrows)",
  "winning_angles": "Marketing angles that would work well for this product",
  "custom_angles_text": "Creative new angles to test",
  "guarantee": "Money-back guarantee or risk reversal",
  "competitive_edge": "What makes this better than alternatives and why buy now",
  "offer_details": "Current offers, discounts, bundles",
  "max_discount": "Maximum discount percentage allowed in ads (e.g. 30% off)",
  "discount_codes": "Active discount/promo codes and what they do (e.g. SAVE20 = 20% off first order)",
  "bundle_variants": "Available product bundles/variants with pricing (e.g. 1 bottle $49, 3 bottles $117, 6 bottles $198)",
  "compliance_restrictions": "Claims the AI should NEVER make (health claims, guarantees, etc.)",
  "benefits": ["benefit 1", "benefit 2", "benefit 3"]
}

Return ONLY valid JSON, no markdown or explanation.

Product page content:
${pageContent}`
      }]
    });

    let extracted;
    try {
      const text = extraction.content[0].text.trim();
      // Handle potential markdown code blocks
      const jsonStr = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
      extracted = JSON.parse(jsonStr);
    } catch (parseErr) {
      return res.status(500).json({ success: false, error: { message: 'Failed to parse AI response' } });
    }

    // Save extracted data to the profile
    const setClauses = [];
    const values = [];
    let idx = 1;

    const fieldsToSave = [
      'name', 'short_name', 'product_type', 'product_group', 'unit_details',
      'price', 'description', 'oneliner', 'tagline', 'big_promise', 'mechanism',
      'differentiator', 'customer_avatar', 'customer_frustration', 'customer_dream',
      'target_demographics', 'voice', 'pain_points', 'common_objections',
      'winning_angles', 'custom_angles_text', 'guarantee', 'competitive_edge',
      'offer_details', 'max_discount', 'discount_codes', 'bundle_variants',
      'compliance_restrictions',
    ];

    for (const field of fieldsToSave) {
      if (typeof extracted[field] === 'string' && extracted[field].trim()) {
        setClauses.push(`${field} = $${idx}`);
        values.push(extracted[field]);
        idx++;
      }
    }

    // Handle benefits array
    if (Array.isArray(extracted.benefits) && extracted.benefits.length > 0) {
      setClauses.push(`benefits = $${idx}::jsonb`);
      values.push(JSON.stringify(extracted.benefits));
      idx++;
    }

    // Save product URL
    setClauses.push(`product_url = $${idx}`);
    values.push(url);
    idx++;

    setClauses.push('updated_at = NOW()');
    values.push(req.params.id);

    const rows = await pgQuery(
      `UPDATE product_profiles SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: { message: 'Profile not found' } });
    }

    return res.json({ success: true, data: parseRow(rows[0]), extracted });
  } catch (err) {
    console.error('POST /product-profiles/:id/ai-fill error:', err);
    return res.status(500).json({ success: false, error: { message: err.message } });
  }
});

export default router;
