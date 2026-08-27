/**
 * Static ad naming: PL - IM001 - Promo - CLAUDE
 *
 * WHY THE NAME MATTERS MORE THAN IT LOOKS
 * A launched ad used to be called "Promo - 1". Nothing in that string ties it to
 * the card that produced it, so a winner in Meta cannot be resolved back to a
 * creative — which is precisely what the iterations flow needs in order to
 * generate variations of what is working. `ad_name` is also the join key used by
 * the Triple Whale revenue queries, so this string is effectively the analytics
 * primary key for a creative. It has to be stable, unique and parseable.
 *
 * Shape, most-significant first:
 *   PL      product code   — which product's ads these are
 *   IM001   card number    — stable identity, assigned once, never reused
 *   Promo   angle          — read live from the product's angle library
 *   CLAUDE  creator        — who made it
 */
import { pgQuery } from '../db/pg.js';

export const DEFAULT_CREATOR = 'CLAUDE';

/** IM042. Padded to three so names sort correctly for the first 999 cards. */
export function formatIm(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num <= 0) return null;
  return `IM${String(Math.trunc(num)).padStart(3, '0')}`;
}

/**
 * The product's prefix. ad_code first, then short_name, then initials of the
 * name. Never returns empty — a nameless prefix would silently collapse
 * "PL - IM001" into " - IM001".
 */
export function productCode(product = {}) {
  const explicit = String(product.ad_code || '').trim();
  if (explicit) return explicit.toUpperCase();
  const short = String(product.short_name || '').trim();
  if (short) return short.toUpperCase();
  const name = String(product.name || '').trim();
  if (name) return name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'XX';
  return 'XX';
}

/**
 * Claim the next IM number for a product, atomically.
 *
 * A single UPSERT that increments and returns. NOT `SELECT MAX+1`: batches run
 * three generations at once, two would read the same max, and the loser would
 * be rejected by the unique index only AFTER its image had been generated.
 *
 * Returns an integer, or null if the counter could not be claimed — callers
 * treat that as "no IM number yet" rather than failing the generation, because
 * an unnamed card is recoverable and a lost image is not.
 */
export async function claimImNumber(productId) {
  const pid = parseInt(productId, 10);
  if (!Number.isFinite(pid)) return null;
  try {
    const rows = await pgQuery(
      `INSERT INTO product_im_counters (product_id, next_im)
       VALUES ($1, 2)
       ON CONFLICT (product_id)
       DO UPDATE SET next_im = product_im_counters.next_im + 1, updated_at = NOW()
       RETURNING next_im - 1 AS im_number`,
      [pid],
    );
    const n = rows?.[0]?.im_number;
    return Number.isFinite(Number(n)) ? Number(n) : null;
  } catch (err) {
    console.error(`[staticNaming] could not claim IM number for product ${pid}: ${err.message}`);
    return null;
  }
}

/**
 * Seed a product's counter above the highest IM already assigned.
 *
 * Used after a backfill. Without it the counter would restart at 1 and the next
 * generated card would collide with a backfilled one.
 */
export async function syncCounter(productId) {
  const pid = parseInt(productId, 10);
  if (!Number.isFinite(pid)) return null;
  const rows = await pgQuery(
    `SELECT COALESCE(MAX(im_number), 0) + 1 AS next FROM spy_creatives WHERE product_id = $1`,
    [pid],
  );
  const next = Number(rows?.[0]?.next) || 1;
  await pgQuery(
    `INSERT INTO product_im_counters (product_id, next_im) VALUES ($1, $2)
     ON CONFLICT (product_id) DO UPDATE SET next_im = GREATEST(product_im_counters.next_im, $2), updated_at = NOW()`,
    [pid, next],
  );
  return next;
}

/**
 * Build the naming variables for one creative. Everything the patterns can
 * reference lives here, so the pattern language and the data stay in step.
 *
 * A creative's own im_number wins; a ratio child falls back to its parent's,
 * because 1:1 / 4:5 / 9:16 of one card share one identity.
 */
export function namingVars(creative = {}, product = {}, extra = {}) {
  const im = creative.im_number ?? creative.parent_im_number ?? null;
  const ratio = String(creative.aspect_ratio || '').replace(':', 'x');
  return {
    code: productCode(product),
    im: formatIm(im) || '',
    imnum: im ?? '',
    angle: creative.angle || extra.angle || 'General',
    creator: String(creative.creator || DEFAULT_CREATOR).toUpperCase(),
    ratio,
    product: creative.product_name || product.name || '',
    ...extra,
  };
}

/**
 * Collapse the artefacts an empty variable leaves behind.
 *
 * A card with no IM number would otherwise render "PL -  - Promo - CLAUDE".
 * Meta accepts that; a human reading a report does not.
 */
export function tidyName(s) {
  return String(s || '')
    .replace(/\s*-\s*-\s*/g, ' - ')
    .replace(/^\s*-\s*/, '')
    .replace(/\s*-\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
