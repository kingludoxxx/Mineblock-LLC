/**
 * adStyle — persistent style classification for scraped League ads.
 *
 * The operator's requirement, verbatim: "the tool needs to identify the ad's
 * style from the League BEFORE importing the videos." Until now that judgement
 * was re-made per selection run by the fit triage — paid for every time,
 * invisible in the UI, and unusable as a filter. This classifies each ad ONCE,
 * stores the tag on brand_spy.ads.style, and everything downstream (League
 * filters, autopilot selection, dedup-by-style) reads a column.
 *
 * Style vocabulary is the hook-architecture vocabulary plus PROMO/EXPLAINER,
 * so a stored style and a generated brief's architecture speak the same
 * language and can be compared later (a PROMO source that generated a STORY
 * brief is a signal worth seeing).
 */

import { pgQuery } from '../db/pg.js';

export const AD_STYLES = ['PROMO', 'STORY', 'DEMO', 'REVERSAL', 'EXPLAINER', 'LISTICLE', 'OTHER'];
const CHUNK = 25;

/** Pure and unit-testable: model text -> Map(index -> style) or null. */
export function parseStyles(text, poolSize) {
  try {
    const arr = JSON.parse(String(text).replace(/^```json\s*|\s*```$/g, '').trim());
    if (!Array.isArray(arr)) return null;
    const out = new Map();
    for (const r of arr) {
      const i = Number(r?.i);
      const style = String(r?.style || '').toUpperCase();
      if (!Number.isInteger(i) || i < 0 || i >= poolSize) continue;
      if (!AD_STYLES.includes(style)) continue;
      out.set(i, style);
    }
    return out.size ? out : null;
  } catch { return null; }
}

async function classifyChunk(ads) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !ads.length) return null;
  const list = ads.map((a, i) =>
    `${i}. headline: ${String(a.headline || '(none)').slice(0, 90)}\n   copy: ${String(a.body_text || '').replace(/\s+/g, ' ').slice(0, 240)}${a.transcript ? `\n   transcript: ${String(a.transcript).replace(/\s+/g, ' ').slice(0, 320)}` : ''}`
  ).join('\n');
  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 900,
    system: 'You classify ad creatives by structural style. Return only JSON.',
    messages: [{ role: 'user', content:
`Classify each ad's STYLE — the structure of the creative, not its topic:
PROMO (the offer/discount is the ad) · STORY (protagonist, pivot, resolution) · DEMO (person shows a result) · REVERSAL (apparent negative that flips, e.g. "why I'm returning this") · EXPLAINER (mechanism/authority teaches) · LISTICLE (a framed list: "3 reasons…") · OTHER

ADS:
${list}

Return ONLY a JSON array: [{"i":0,"style":"PROMO"}]` }],
  };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return parseStyles(j.content?.[0]?.text || '', ads.length);
  } catch { return null; }
}

/**
 * Classify up to `limit` untagged ads (active, tiered — the ones selection can
 * ever see). Resumable by design: each run tags what it can and the next run
 * continues where it stopped, so a backfill is just calling this until it
 * returns tagged: 0.
 */
export async function classifyUntaggedAds({ limit = 200 } = {}) {
  const ads = await pgQuery(`
    SELECT a.id, a.headline, a.body_text, a.transcript
    FROM brand_spy.ads a
    WHERE a.style IS NULL
      AND a.is_active = TRUE
      AND a.tier IN ('BANGER','CHAMP','A','B','C')
      AND (length(COALESCE(a.transcript,'')) > 80 OR length(COALESCE(a.body_text,'')) > 80)
    ORDER BY a.tier_score DESC NULLS LAST
    LIMIT $1
  `, [Math.min(500, Math.max(1, Number(limit) || 200))]);

  let tagged = 0, chunksOk = 0;
  const chunksTotal = Math.ceil(ads.length / CHUNK);
  for (let off = 0; off < ads.length; off += CHUNK) {
    const part = ads.slice(off, off + CHUNK);
    const styles = await classifyChunk(part);
    if (!styles) continue;
    chunksOk++;
    for (const [i, style] of styles) {
      await pgQuery(`UPDATE brand_spy.ads SET style = $1 WHERE id = $2`, [style, part[i].id]);
      tagged++;
    }
  }
  const remaining = await pgQuery(`
    SELECT COUNT(*)::int AS n FROM brand_spy.ads a
    WHERE a.style IS NULL AND a.is_active = TRUE
      AND a.tier IN ('BANGER','CHAMP','A','B','C')
      AND (length(COALESCE(a.transcript,'')) > 80 OR length(COALESCE(a.body_text,'')) > 80)
  `);
  return { candidates: ads.length, tagged, chunksOk, chunksTotal, remaining: remaining[0].n };
}
