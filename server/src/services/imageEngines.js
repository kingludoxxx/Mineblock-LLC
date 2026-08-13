// ─────────────────────────────────────────────────────────────────────────────
// imageEngines — unified abstraction over NanoBanana + OpenAI image gen.
//
// Both engines expose the same submit/poll contract so routes/staticsGeneration.js
// can route through getEngine(name) without per-engine branching.
//
//   engine.submit(prompt, imageUrls, ratio) -> taskId
//   engine.poll(taskId)                     -> resultImageUrl (URL or data URI)
//   engine.isConfigured()                   -> boolean
//   engine.name                             -> 'nanobanana' | 'openai'
//   engine.label                            -> human-readable label
// ─────────────────────────────────────────────────────────────────────────────

import {
  submitToNanoBanana,
  pollNanoBanana,
  isNanoBananaConfigured,
} from './imageGeneration.js';

import {
  submitToOpenAI,
  pollOpenAI,
  isOpenAIConfigured,
  getOpenAIModel,
} from './openaiImageGen.js';

const ENGINES = {
  nanobanana: {
    name: 'nanobanana',
    label: 'NanoBanana',
    submit: submitToNanoBanana,
    poll:   pollNanoBanana,
    isConfigured: isNanoBananaConfigured,
    describe: () => 'google/nano-banana-edit (via Kie.ai)',
  },
  openai: {
    name: 'openai',
    label: 'OpenAI',
    // Pass-through preserves the optional mask 4th arg (only OpenAI uses it).
    submit: (prompt, imgs, ratio, mask) => submitToOpenAI(prompt, imgs, ratio, mask),
    poll:   pollOpenAI,
    isConfigured: isOpenAIConfigured,
    describe: () => `OpenAI ${getOpenAIModel()}`,
  },
};

/**
 * Resolve an engine by name. Falls back to NanoBanana for unknown names
 * (rather than throwing) so older callers / legacy DB rows without an
 * engine field keep working.
 *
 * NOTE — this fallback deliberately does NOT track DEFAULT_ENGINE, and that is
 * not an oversight. A row with a null image_engine predates the engine column,
 * which means it really was generated on NanoBanana; resolving it to today's
 * default would mislabel history and cause cross-engine style drift when such a
 * row is resized or adjusted. New work must pass `x || DEFAULT_ENGINE` at the
 * call site instead of relying on this fallback.
 */
export function getEngine(name) {
  const key = String(name || '').toLowerCase();
  if (ENGINES[key]) return ENGINES[key];
  return ENGINES.nanobanana;
}

/**
 * List engines + their availability for the UI's engine picker.
 */
export function listEngines() {
  return Object.values(ENGINES).map(e => ({
    name: e.name,
    label: e.label,
    available: e.isConfigured(),
    describe: e.describe(),
  }));
}

// DEFAULT_ENGINE — OpenAI, not NanoBanana.
//
// Changed 2026-08-12 after a controlled A/B on the live Puure instance: the
// SAME reference, angle and product rendered through both engines. Claude's
// copy was correct in both runs; NanoBanana corrupted it at render time
// ("collagen scaffod", "an't reach", "waelenghts", "Nirrty-Ure Dollars"),
// while gpt-image-2 rendered every word correctly. Text fidelity is the whole
// point of a static ad, so the default has to be the engine that can spell.
//
// Tradeoff accepted by the operator: gpt-image-2 took 187s vs NanoBanana's 88s
// and costs more per image. NanoBanana remains fully available per-request via
// body.image_engine — it is a better choice for text-free product shots.
export const DEFAULT_ENGINE = 'openai';
