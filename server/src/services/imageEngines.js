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

export const DEFAULT_ENGINE = 'nanobanana';
