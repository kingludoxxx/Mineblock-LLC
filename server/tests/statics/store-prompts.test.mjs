// Every store has its own statics prompts (Ludo 2026-09-14: "if I change the prompt of the static pipeline of one
// store, this doesn't apply to all the stores"). Found on the live stores the same day:
//   1. saving prompts kept 3 of the 6 (openai_image, both iteration prompts were dropped),
//   2. a stored row missing any of the 6 was judged invalid, so EVERY store silently ran the code's baked prompts
//      and an operator's edit never took effect,
//   3. right after a save the cache held the 3-key row, so OpenAI generations ran on the NanoBanana prompt,
//   4. a boot could overwrite a store's stored Claude prompt with the code default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStorePrompts, promptsToSave, bootPromptRepair } from '../../src/utils/storePrompts.js';

const KEYS = ['claude_analysis', 'nanobanana_image', 'openai_image', 'ai_adjustment', 'nanobanana_iteration', 'openai_iteration'];
const DEFAULTS = Object.fromEntries(KEYS.map((k) => [k, `DEFAULT ${k}`]));

test('S1: a store row with only some prompts: its own prompts win, the missing ones come from the defaults', () => {
  const row = { claude_analysis: 'STORE claude', nanobanana_image: 'STORE nb', ai_adjustment: 'STORE adj' };
  const p = resolveStorePrompts(row, DEFAULTS, KEYS);
  assert.equal(p.claude_analysis, 'STORE claude');
  assert.equal(p.openai_image, 'DEFAULT openai_image', 'OpenAI never falls back to the NanoBanana prompt');
  assert.deepEqual(Object.keys(p).sort(), [...KEYS].sort());
});

test('S2: no row, a legacy/garbage row, or empty strings resolve to the defaults key by key', () => {
  assert.deepEqual(resolveStorePrompts(null, DEFAULTS, KEYS), DEFAULTS);
  assert.deepEqual(resolveStorePrompts('not json', DEFAULTS, KEYS), DEFAULTS);
  assert.deepEqual(resolveStorePrompts({ claudeAnalysis: { x: 1 } }, DEFAULTS, KEYS), DEFAULTS);
  assert.equal(resolveStorePrompts({ claude_analysis: '   ' }, DEFAULTS, KEYS).claude_analysis, 'DEFAULT claude_analysis');
  assert.equal(resolveStorePrompts(JSON.stringify({ openai_image: 'STORE oai' }), DEFAULTS, KEYS).openai_image, 'STORE oai', 'a row stored as a JSON string is read');
});

test('S3: saving keeps every prompt the operator sent, and only known keys', () => {
  const incoming = { ...Object.fromEntries(KEYS.map((k) => [k, `EDIT ${k}`])), injected: 'x' };
  assert.deepEqual(promptsToSave(incoming, KEYS), Object.fromEntries(KEYS.map((k) => [k, `EDIT ${k}`])));
});

test('S4: saving refuses a missing or empty prompt by name', () => {
  assert.throws(() => promptsToSave({ claude_analysis: 'a' }, KEYS), /nanobanana_image/);
});

test('S5: a boot never overwrites a prompt the store has; it only adds the ones the store lacks', () => {
  const row = { claude_analysis: 'STORE claude WITHOUT any signature', nanobanana_image: 'STORE nb', ai_adjustment: 'STORE adj' };
  const plan = bootPromptRepair(row, DEFAULTS, KEYS);
  assert.equal(plan.write, true);
  assert.equal(plan.value.claude_analysis, 'STORE claude WITHOUT any signature', 'the store prompt is kept');
  assert.equal(plan.value.openai_image, 'DEFAULT openai_image');
  assert.deepEqual(plan.added.sort(), ['nanobanana_iteration', 'openai_image', 'openai_iteration']);
  const complete = bootPromptRepair(plan.value, DEFAULTS, KEYS);
  assert.equal(complete.write, false, 'a complete row is never rewritten');
  assert.equal(bootPromptRepair(null, DEFAULTS, KEYS).write, false, 'no row: nothing is created at boot');
});

test('S6: the live routes use these rules: loader, save and boot, and no code path force-overwrites a store prompt', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../src/routes/staticsGeneration.js', import.meta.url), 'utf8');
  assert.match(src, /resolveStorePrompts\(rows\.length \? rows\[0\]\.value : null, getDefaultStaticsPrompts\(\), STATICS_PROMPT_KEYS\)/, 'loader');
  assert.match(src, /promptsToSave\(incoming, STATICS_PROMPT_KEYS\)/, 'save');
  assert.match(src, /bootPromptRepair\(rows\.length \? rows\[0\]\.value : null/, 'boot');
  assert.ok(!/force-overwrite|isValidPromptsShape|STATICS_CLAUDE_SIGNATURE/.test(src), 'the old overwrite/all-or-nothing code is gone');
});
