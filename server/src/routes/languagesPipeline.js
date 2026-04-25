/**
 * Video Ads Languages Pipeline
 *
 * Generates localized ClickUp cards for winning English video ads.
 * Supported languages: ES (Spanish), FR (French), DT (Dutch), IT (Italian)
 *
 * Endpoints:
 *   GET  /source-tasks          — list Video Ads Pipeline tasks for the picker
 *   GET  /languages-tasks       — list existing language cards
 *   POST /generate              — main: translate + create ClickUp cards + Frame.io subfolders
 */

import express from 'express';
import { pgQuery } from '../db/pg.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import logger from '../utils/logger.js';
import sendSlackAlert from '../utils/slackAlert.js';

const router = express.Router();
router.use(authenticate, requirePermission('languages-pipeline', 'access'));

// ── ClickUp config ──────────────────────────────────────────────────────────
const CLICKUP_TOKEN = process.env.CLICKUP_API_TOKEN || '';
const CLICKUP_API = 'https://api.clickup.com/api/v2';
const VIDEO_ADS_LIST_ID = '901518716584';   // Source: "Video Ad Pipeline"
const LANGUAGES_LIST_ID = '901523010131';   // Target: "Video Ads Languages"

// ── Custom field IDs (source list — Video Ad Pipeline) ───────────────────────
const SOURCE_FIELDS = {
  adsFrameLink: 'd90f9f25-d7a0-4eb4-9ded-aca0b4519a3b',
  briefNumber:  '62b61cc4-2d35-4dfc-86f4-a3913e2bbca3',
  angle:        '7e740c52-a05b-4b3b-9798-0801acd84b8a',
  briefType:    '98d04d2d-9575-4363-8eee-9bf150b1c319',
  creativeType: 'b7f50dff-c752-47a7-830d-c3780021a27f',
  creationWeek: 'a609d8d0-661e-400f-87cb-2557bd48857b',
  editor:       'a9613cd9-715a-4a2a-bbbb-fbb7f664980a',
};

// ── Custom field IDs (target list — Video Ads Languages) ────────────────────
const LANG_FIELDS = {
  languageCode:      'e06cbf5b-db98-4bc0-80d7-65ad788d1b69',
  sourceCard:        '767a4055-7e27-4ada-a6ff-292e8e30c80b',
  sourceFrameFolder: '7c12e7a2-eb85-4dc5-83e8-d4a8056ea425',
  adsFrameLink:      'd90f9f25-d7a0-4eb4-9ded-aca0b4519a3b',
  briefNumber:       '62b61cc4-2d35-4dfc-86f4-a3913e2bbca3',
  creationWeek:      'a609d8d0-661e-400f-87cb-2557bd48857b',
};

// Language Code dropdown option orderindexes (from field e06cbf5b)
const LANG_CODE_ORDERINDEX = { ES: 0, FR: 1, DT: 2, IT: 3 };

// Language → human-readable target market (used in translation prompt)
const LANG_META = {
  ES: { name: 'Spanish', market: 'Spanish-speaking Facebook audience (Spain and Latin America)' },
  FR: { name: 'French',  market: 'French-speaking Facebook audience (France and Belgium)' },
  DT: { name: 'Dutch',   market: 'Dutch-speaking Facebook audience (Netherlands and Belgium)' },
  IT: { name: 'Italian', market: 'Italian-speaking Facebook audience (Italy)' },
};

const VALID_LANG_CODES = Object.keys(LANG_META);

// ── Frame.io config ──────────────────────────────────────────────────────────
const FRAMEIO_API_V4   = 'https://api.frame.io/v4';
const FRAMEIO_ACCOUNT_ID = '4d65ef83-9323-4ef2-ae6a-585d38cce2af';
const FRAMEIO_PROJECT_ID = '19c0ce1f-f357-4da8-ba1f-bd7eb201e660';
const FRAMEIO_CLIENT_ID  = process.env.FRAMEIO_CLIENT_ID || '';
const FRAMEIO_CLIENT_SECRET = process.env.FRAMEIO_CLIENT_SECRET || '';
const ADOBE_IMS_TOKEN    = 'https://ims-na1.adobelogin.com/ims/token/v3';

// In-module token cache (separate from clickupWebhook.js — independent module)
let v4TokenCache = { accessToken: null, expiresAt: 0 };

// ── Anthropic config ─────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const CLAUDE_MODEL = 'claude-sonnet-4-6';

// ══════════════════════════════════════════════════════════════════════════════
// ClickUp Helpers
// ══════════════════════════════════════════════════════════════════════════════

async function clickupFetch(url, options = {}) {
  const res = await fetch(`${CLICKUP_API}${url}`, {
    ...options,
    headers: {
      Authorization: CLICKUP_TOKEN,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ClickUp API ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

/** Extract a readable value from a ClickUp custom field */
function getFieldValue(task, fieldId) {
  const field = task.custom_fields?.find((f) => f.id === fieldId);
  if (!field || field.value == null) return null;

  if (field.type === 'url' || field.type === 'short_text' || field.type === 'text') {
    return field.value || null;
  }
  if (field.type === 'number') {
    return field.value;
  }
  if (field.type === 'drop_down' && field.type_config?.options) {
    const idx = parseInt(field.value, 10);
    const opt = field.type_config.options.find((o) => o.orderindex === idx);
    return opt?.name || null;
  }
  if (field.type === 'users' && Array.isArray(field.value)) {
    return field.value.map((u) => u.username?.split(' ')[0]).filter(Boolean).join(', ') || null;
  }
  if (field.type === 'list_relationship' && Array.isArray(field.value)) {
    return field.value.map((t) => t.name).join(', ') || null;
  }
  return field.value;
}

/** Get ISO week label for this week: WK17_2026 */
function getWeekLabel() {
  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const days = Math.floor((now - startOfYear) / 86400000);
  const weekNum = Math.ceil((days + startOfYear.getDay() + 1) / 7);
  return `WK${String(weekNum).padStart(2, '0')}_${now.getFullYear()}`;
}

/**
 * Build the language card name by inserting langCode after the first segment.
 * "MR - B0223 - NN - ..." → "MR - ES - B0223 - NN - ..."
 */
function buildLanguageTaskName(originalName, langCode) {
  const parts = originalName.trim().split(' - ');
  if (parts.length < 2) return `${originalName} - ${langCode}`;
  return [parts[0], langCode, ...parts.slice(1)].join(' - ');
}

/**
 * Parse Frame.io folder ID from a Frame.io URL.
 * Format: https://next.frame.io/project/:projectId/:folderId
 */
function parseFrameFolderId(frameUrl) {
  if (!frameUrl) return null;
  const match = frameUrl.match(/\/project\/[^/]+\/([^/?#]+)/);
  return match?.[1] || null;
}

/**
 * Check if a language card already exists in the Languages list.
 * Uses the name pattern: "- LANG - BCODE -" (e.g. "- ES - B0223 -")
 */
async function checkDuplicate(langCode, briefCode) {
  // Search with page limit — languages list will remain small
  const data = await clickupFetch(
    `/list/${LANGUAGES_LIST_ID}/task?include_closed=true&limit=100`
  );
  const pattern = `- ${langCode} - ${briefCode} -`.toLowerCase();
  return (data.tasks || []).some((t) => t.name.toLowerCase().includes(pattern));
}

// ══════════════════════════════════════════════════════════════════════════════
// Frame.io Helpers
// ══════════════════════════════════════════════════════════════════════════════

async function loadV4Tokens() {
  const rows = await pgQuery(
    "SELECT value FROM system_settings WHERE key = 'frameio_oauth'"
  );
  const raw = rows?.[0]?.value;
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw;
}

async function saveV4Tokens(tokens) {
  await pgQuery(
    `INSERT INTO system_settings (key, value, description, updated_at)
     VALUES ('frameio_oauth', $1::jsonb, 'Frame.io v4 OAuth tokens (Adobe IMS)', NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [JSON.stringify(tokens)]
  );
  v4TokenCache = { accessToken: null, expiresAt: 0 };
}

async function refreshV4Token() {
  const stored = await loadV4Tokens();
  if (!stored?.refresh_token) {
    throw new Error('No Frame.io refresh_token stored — re-authorize at /api/v1/webhook/frameio-oauth-start');
  }
  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: stored.refresh_token,
    client_id:     FRAMEIO_CLIENT_ID,
    client_secret: FRAMEIO_CLIENT_SECRET,
  });
  const res = await fetch(ADOBE_IMS_TOKEN, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Adobe IMS refresh failed ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  const newTokens = {
    access_token:  json.access_token,
    refresh_token: json.refresh_token || stored.refresh_token,
    expires_at:    Date.now() + (json.expires_in || 86400) * 1000 - 60_000,
    token_type:    json.token_type || 'Bearer',
  };
  await saveV4Tokens(newTokens);
  return newTokens.access_token;
}

async function getV4AccessToken() {
  if (v4TokenCache.accessToken && Date.now() < v4TokenCache.expiresAt) {
    return v4TokenCache.accessToken;
  }
  const stored = await loadV4Tokens();
  if (stored?.access_token && stored.expires_at > Date.now() + 30_000) {
    v4TokenCache = { accessToken: stored.access_token, expiresAt: stored.expires_at };
    return stored.access_token;
  }
  const refreshed = await refreshV4Token();
  const updatedStored = await loadV4Tokens();
  v4TokenCache = {
    accessToken: refreshed,
    expiresAt:   updatedStored?.expires_at || Date.now() + 3600_000,
  };
  return refreshed;
}

async function frameioFetchV4(url, options = {}) {
  const token = await getV4AccessToken();
  const makeReq = (t) =>
    fetch(`${FRAMEIO_API_V4}${url}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${t}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
  let res = await makeReq(token);
  if (res.status === 401) {
    const freshToken = await refreshV4Token();
    res = await makeReq(freshToken);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Frame.io v4 ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Create a Frame.io subfolder under parentFolderId.
 * Returns { folderId, folderUrl } or null on failure.
 */
async function createFrameFolder(parentFolderId, folderName) {
  try {
    const resp = await frameioFetchV4(
      `/accounts/${FRAMEIO_ACCOUNT_ID}/folders/${parentFolderId}/folders`,
      {
        method: 'POST',
        body:   JSON.stringify({ data: { name: folderName } }),
      }
    );
    const newId = resp?.data?.id || resp?.id;
    if (!newId) {
      logger.error(`[languagesPipeline] createFrameFolder got no id: ${JSON.stringify(resp).slice(0, 200)}`);
      return null;
    }
    const folderUrl = `https://next.frame.io/project/${FRAMEIO_PROJECT_ID}/${newId}`;
    return { folderId: newId, folderUrl };
  } catch (err) {
    logger.error(`[languagesPipeline] createFrameFolder failed: ${err.message}`);
    return null;
  }
}

/**
 * Get existing language subfolder or create it.
 * Returns { folderId, folderUrl, existed } or null on total failure.
 */
async function getOrCreateLangSubfolder(sourceFolderId, langCode) {
  try {
    // v4 folder-children endpoint (v2 /assets/{id}/children is not used in v4 auth context)
    const resp = await frameioFetchV4(
      `/accounts/${FRAMEIO_ACCOUNT_ID}/folders/${sourceFolderId}/children?page_size=100`
    );
    const items = Array.isArray(resp) ? resp : (resp?.data || []);
    const existing = items.find(
      (c) => c.name === langCode && (c.type === 'folder' || c._type === 'folder' || c.item_type === 'folder')
    );
    if (existing) {
      return {
        folderId:  existing.id,
        folderUrl: `https://next.frame.io/project/${FRAMEIO_PROJECT_ID}/${existing.id}`,
        existed:   true,
      };
    }
  } catch (err) {
    logger.warn(`[languagesPipeline] Could not list subfolder children: ${err.message}`);
    // Fall through to creation attempt
  }
  const created = await createFrameFolder(sourceFolderId, langCode);
  return created ? { ...created, existed: false } : null;
}

// ══════════════════════════════════════════════════════════════════════════════
// Claude Translation
// ══════════════════════════════════════════════════════════════════════════════

/** Strip HTML tags and normalize whitespace from a ClickUp description */
function stripHtml(text) {
  if (!text) return '';
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Build the translation prompt for a given language code and script */
function buildTranslationPrompt(langCode, script) {
  const { name, market } = LANG_META[langCode];
  return `You are a senior direct-response copywriter and localization specialist with native fluency in ${name}. You specialize in Facebook and TikTok video ads for ${market}.

Localize the following Facebook video ad script into ${name}.

━━━ WHAT THIS IS ━━━
A production script for a video ad. It contains:
1. A visual direction block (editor instructions — layout, B-roll descriptions, on-screen text labels in quotes).
2. The ad copy: hooks (H1/H2/H3) and a body script for the voiceover.

Translate EVERYTHING into ${name} — both sections, all headers, all quoted on-screen labels.

━━━ HARD RULES ━━━

HOOK LABELS:
• H1, H2, H3 stay EXACTLY as H1, H2, H3. Never change them to G1, G2, A1, A2 or anything else.

SECTION HEADERS — ALL must be translated:
• "Visual Style Reference" → translate to natural ${name}
• "Layout Match" / "Layout" → translate
• "Hooks (First 3 seconds)" → translate the header, keep H1/H2/H3 labels
• "Body Script" → translate
• No English section header may remain in the output.

ON-SCREEN TEXT LABELS (quoted text inside the visual block):
• Translate them into ${name} — they are the actual text that will appear on screen for a ${name}-speaking audience.
• Exception: "PCB" stays "PCB" everywhere (it is a universally recognised abbreviation, even within translated labels).
• Example: "0 Moving Parts" → translate; "Industrial PCB" → translate but keep "PCB".

CONTENT FIDELITY:
• Do NOT add any word, sentence, or phrase not in the original. No filler, no commentary, no "let's find out".
• Do NOT remove any selling point, number, or CTA element.
• When the original says "0 [noun]" to mean zero quantity — render it as a clean positive or numerical statement in ${name}. Do NOT construct a double negative (e.g. French "Il ne possède 0 pièces" is wrong; write "0 pièces mobiles" or "aucune pièce mobile" instead).

TECHNICAL TERMS THAT STAY IN ENGLISH:
• "PCB" — keep as-is even inside translated labels.
• "B-roll" — video production term, keep as-is.
• Numbers, codes, specs: 0, 1, 24/7, 52%, 144, 90, 9x16, MINER10 — exact.
• Product name: Miner Forge PRO 2.0 — exact.

COMMON PHRASES TO TRANSLATE (do not leave in English):
• "high-speed" → translate fully.
• "home miner" → translate ("miner voor thuisgebruik", "miner domestico", etc.).
• Any compound English descriptor must be translated. No partial translations.

LANGUAGE REGISTER:
• Neutral, pan-regional ${name}. No dialect-specific slang. Must work across all of ${market}.
• Conversational and direct — like a trusted friend who knows their subject.
• Not formal. Not slang. Clean and smooth.
• No diminutives to describe the product (no "cosita", "cosina", "juguetito", etc.) — the product is premium.
• Use informal address (tu / jij) appropriate for social media, but keep it respectful and neutral.
• Read every sentence aloud mentally. If it sounds awkward when spoken, rewrite it.

FORMATTING:
• Preserve ALL markdown exactly: **bold** stays **bold**, bullets stay bullets, --- stays ---.
• Do not add or remove blank lines.
• No meta-words inside the output: no "Translated:", "Note:", "Script:", etc.

━━━ SCRIPT TO LOCALIZE ━━━
${script}

━━━ OUTPUT ━━━
Return ONLY the localized script. Nothing before it. Nothing after it.`;
}

/** Call Claude Sonnet with retry on rate-limit */
async function callClaude(prompt, maxTokens = 8096) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const makeRequest = () =>
    fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      CLAUDE_MODEL,
        max_tokens: maxTokens,
        temperature: 0.7,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

  let res = await makeRequest();

  // Single retry on 429 (rate limit) after 3s
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 3000));
    res = await makeRequest();
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude API ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  return data.content?.[0]?.text?.trim() || '';
}

// ══════════════════════════════════════════════════════════════════════════════
// Route Handlers
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /source-tasks
 * Returns tasks from "Video Ad Pipeline" for the picker UI.
 * Supports ?search= query param.
 */
router.get('/source-tasks', async (req, res) => {
  try {
    const search = (req.query.search || '').toLowerCase().trim();
    let page = 0;
    let allTasks = [];
    let hasMore = true;

    // Fetch up to 5 pages (500 tasks) to cover the full pipeline
    while (hasMore && page < 5) {
      const data = await clickupFetch(
        `/list/${VIDEO_ADS_LIST_ID}/task?page=${page}&limit=100&include_closed=false`
      );
      const tasks = data.tasks || [];
      allTasks = allTasks.concat(tasks);
      hasMore = tasks.length === 100;
      page++;
    }

    // Filter and shape for the UI
    const result = allTasks
      .filter((t) => !search || t.name.toLowerCase().includes(search))
      .map((t) => ({
        id:         t.id,
        name:       t.name,
        status:     t.status?.status || '',
        url:        t.url,
        frameLink:  getFieldValue(t, SOURCE_FIELDS.adsFrameLink),
        briefNumber: getFieldValue(t, SOURCE_FIELDS.briefNumber),
        hasScript:  !!(t.description?.trim()),
      }))
      .sort((a, b) => (b.briefNumber || 0) - (a.briefNumber || 0));

    res.json({ tasks: result, total: result.length });
  } catch (err) {
    logger.error(`[languagesPipeline] /source-tasks error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /languages-tasks
 * Returns existing cards in the "Video Ads Languages" list.
 */
router.get('/languages-tasks', async (req, res) => {
  try {
    let page = 0;
    let allTasks = [];
    let hasMore = true;

    while (hasMore && page < 10) {
      const data = await clickupFetch(
        `/list/${LANGUAGES_LIST_ID}/task?page=${page}&limit=100&include_closed=true`
      );
      const tasks = data.tasks || [];
      allTasks = allTasks.concat(tasks);
      hasMore = tasks.length === 100;
      page++;
    }

    const result = allTasks.map((t) => ({
      id:       t.id,
      name:     t.name,
      status:   t.status?.status || '',
      url:      t.url,
      langCode: getFieldValue(t, LANG_FIELDS.languageCode),
      frameLink: getFieldValue(t, LANG_FIELDS.adsFrameLink),
    }));

    res.json({ tasks: result, total: result.length });
  } catch (err) {
    logger.error(`[languagesPipeline] /languages-tasks error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /generate
 * Main endpoint: translate source tasks into target languages.
 *
 * Body: {
 *   taskIds:       string[]   — ClickUp task IDs from Video Ads Pipeline
 *   languageCodes: string[]   — e.g. ["ES", "FR"]
 * }
 *
 * Returns array of results, one per (taskId × langCode) pair.
 */
router.post('/generate', async (req, res) => {
  const { taskIds, languageCodes } = req.body;

  // ── Input validation ──
  if (!Array.isArray(taskIds) || taskIds.length === 0) {
    return res.status(400).json({ error: 'taskIds must be a non-empty array' });
  }
  if (!Array.isArray(languageCodes) || languageCodes.length === 0) {
    return res.status(400).json({ error: 'languageCodes must be a non-empty array' });
  }
  const invalid = languageCodes.filter((l) => !VALID_LANG_CODES.includes(l));
  if (invalid.length > 0) {
    return res.status(400).json({ error: `Unsupported language codes: ${invalid.join(', ')}. Valid: ${VALID_LANG_CODES.join(', ')}` });
  }
  if (taskIds.length > 20) {
    return res.status(400).json({ error: 'Maximum 20 source tasks per request' });
  }

  logger.info(`[languagesPipeline] Generating: ${taskIds.length} tasks × ${languageCodes.join(',')} = ${taskIds.length * languageCodes.length} cards`);

  const results = [];

  // ── Process each source task ──
  for (const taskId of taskIds) {
    let sourceTask;
    try {
      sourceTask = await clickupFetch(`/task/${taskId}`);
    } catch (err) {
      logger.error(`[languagesPipeline] Failed to fetch task ${taskId}: ${err.message}`);
      results.push({
        taskId,
        sourceName: taskId,
        status: 'error',
        error:  'fetch_failed',
        message: err.message,
      });
      continue;
    }

    const sourceName = sourceTask.name || '';
    const rawScript  = sourceTask.description || '';
    const script     = stripHtml(rawScript).trim();
    const sourceUrl  = sourceTask.url || `https://app.clickup.com/t/${taskId}`;

    // Extract brief code from name (B0223 pattern)
    const briefCodeMatch = sourceName.match(/\b(B\d{4})\b/);
    const briefCode = briefCodeMatch?.[1] || 'BXXXX';

    // Extract source Frame.io folder ID
    const sourceFrameLink = getFieldValue(sourceTask, SOURCE_FIELDS.adsFrameLink);
    const sourceFolderId  = parseFrameFolderId(sourceFrameLink);

    // ── Check for missing script ──
    if (!script) {
      logger.warn(`[languagesPipeline] Task "${sourceName}" has no script`);
      sendSlackAlert(
        `[Languages Pipeline] Source task "${sourceName}" skipped — no script found in description.`,
        { level: 'warning', source: 'LanguagesPipeline', fields: { task_id: taskId } }
      ).catch(() => {});
      results.push({
        taskId,
        sourceName,
        status: 'error',
        error:  'missing_script',
        message: 'Task description is empty — no script to translate.',
      });
      continue;
    }

    // ── Process each language ──
    for (const langCode of languageCodes) {
      const pairId = `${taskId}:${langCode}`;

      // 1. Duplicate check
      try {
        const isDuplicate = await checkDuplicate(langCode, briefCode);
        if (isDuplicate) {
          logger.info(`[languagesPipeline] ${pairId} — already exists, skipping`);
          results.push({
            taskId,
            langCode,
            sourceName,
            status:  'skipped',
            reason:  'already_exists',
            message: `A "${langCode}" card for ${briefCode} already exists in the Languages list.`,
          });
          continue;
        }
      } catch (err) {
        logger.warn(`[languagesPipeline] Duplicate check failed for ${pairId}: ${err.message}`);
        // Non-fatal — proceed with creation (worst case: creates a duplicate)
      }

      // 2. Translate script
      let translatedScript;
      try {
        const prompt = buildTranslationPrompt(langCode, script);
        translatedScript = await callClaude(prompt);
        if (!translatedScript) throw new Error('Claude returned empty translation');
      } catch (err) {
        logger.error(`[languagesPipeline] Translation failed for ${pairId}: ${err.message}`);
        sendSlackAlert(
          `[Languages Pipeline] Translation failed for "${sourceName}" → ${langCode}: ${err.message.slice(0, 200)}`,
          { level: 'error', source: 'LanguagesPipeline', fields: { task_id: taskId, lang: langCode } }
        ).catch(() => {});
        results.push({
          taskId,
          langCode,
          sourceName,
          status: 'error',
          error:  'translation_failed',
          message: err.message,
        });
        continue;
      }

      // 3. Build language-card name
      const langTaskName = buildLanguageTaskName(sourceName, langCode);

      // 4. Frame.io: create or reuse language subfolder
      let frameResult  = null;
      let frameWarning = null;
      if (sourceFolderId) {
        frameResult = await getOrCreateLangSubfolder(sourceFolderId, langCode);
        if (!frameResult) {
          frameWarning = 'subfolder_failed';
          logger.warn(`[languagesPipeline] Frame.io subfolder creation failed for ${pairId}`);
          sendSlackAlert(
            `[Languages Pipeline] Frame.io subfolder creation failed for "${langTaskName}" — card will be created without frame link.`,
            { level: 'warning', source: 'LanguagesPipeline', fields: { task_id: taskId, lang: langCode } }
          ).catch(() => {});
        }
      } else {
        frameWarning = 'no_source_frame_link';
        logger.warn(`[languagesPipeline] No source Frame.io link on "${sourceName}" — skipping subfolder`);
      }

      // 5. Create ClickUp task in Languages list
      let newTask;
      try {
        const taskDescription = [
          `🌐 Language: ${langCode} | ${LANG_META[langCode].name}`,
          `🔗 Original card: ${sourceUrl}`,
          sourceFrameLink ? `📁 Original Frame.io folder: ${sourceFrameLink}` : '',
          '',
          '─── Translated Script ───',
          '',
          translatedScript,
        ].filter((l) => l !== null).join('\n');

        newTask = await clickupFetch(`/list/${LANGUAGES_LIST_ID}/task`, {
          method: 'POST',
          body: JSON.stringify({
            name:        langTaskName,
            description: taskDescription,
            status:      'edit queue',
          }),
        });
      } catch (err) {
        logger.error(`[languagesPipeline] ClickUp task creation failed for ${pairId}: ${err.message}`);
        sendSlackAlert(
          `[Languages Pipeline] Failed to create ClickUp card "${langTaskName}": ${err.message.slice(0, 200)}`,
          { level: 'error', source: 'LanguagesPipeline', fields: { task_id: taskId, lang: langCode } }
        ).catch(() => {});
        results.push({
          taskId,
          langCode,
          sourceName,
          langTaskName,
          status: 'error',
          error:  'clickup_create_failed',
          message: err.message,
        });
        continue;
      }

      const newTaskId  = newTask.id;
      const newTaskUrl = newTask.url || `https://app.clickup.com/t/${newTaskId}`;

      // 6. Set custom fields (non-fatal — log failures but don't abort)
      const fieldOps = [
        // Language Code dropdown
        clickupFetch(`/task/${newTaskId}/field/${LANG_FIELDS.languageCode}`, {
          method: 'POST',
          body: JSON.stringify({ value: LANG_CODE_ORDERINDEX[langCode] }),
        }).catch((e) => logger.warn(`[languagesPipeline] Set languageCode failed: ${e.message}`)),

        // Source Card URL
        clickupFetch(`/task/${newTaskId}/field/${LANG_FIELDS.sourceCard}`, {
          method: 'POST',
          body: JSON.stringify({ value: sourceUrl }),
        }).catch((e) => logger.warn(`[languagesPipeline] Set sourceCard failed: ${e.message}`)),

        // Brief Number
        getFieldValue(sourceTask, SOURCE_FIELDS.briefNumber) != null
          ? clickupFetch(`/task/${newTaskId}/field/${LANG_FIELDS.briefNumber}`, {
              method: 'POST',
              body: JSON.stringify({ value: getFieldValue(sourceTask, SOURCE_FIELDS.briefNumber) }),
            }).catch((e) => logger.warn(`[languagesPipeline] Set briefNumber failed: ${e.message}`))
          : Promise.resolve(),

        // Creation Week
        clickupFetch(`/task/${newTaskId}/field/${LANG_FIELDS.creationWeek}`, {
          method: 'POST',
          body: JSON.stringify({ value: getWeekLabel() }),
        }).catch((e) => logger.warn(`[languagesPipeline] Set creationWeek failed: ${e.message}`)),
      ];

      // Source Frame Folder link
      if (sourceFrameLink) {
        fieldOps.push(
          clickupFetch(`/task/${newTaskId}/field/${LANG_FIELDS.sourceFrameFolder}`, {
            method: 'POST',
            body: JSON.stringify({ value: sourceFrameLink }),
          }).catch((e) => logger.warn(`[languagesPipeline] Set sourceFrameFolder failed: ${e.message}`))
        );
      }

      // Ads Frame Link (language subfolder)
      if (frameResult?.folderUrl) {
        fieldOps.push(
          clickupFetch(`/task/${newTaskId}/field/${LANG_FIELDS.adsFrameLink}`, {
            method: 'POST',
            body: JSON.stringify({ value: frameResult.folderUrl }),
          }).catch((e) => logger.warn(`[languagesPipeline] Set adsFrameLink failed: ${e.message}`))
        );
      }

      await Promise.allSettled(fieldOps);

      logger.info(`[languagesPipeline] ✅ Created: "${langTaskName}" → ${newTaskUrl}`);

      results.push({
        taskId,
        langCode,
        sourceName,
        langTaskName,
        status:      'created',
        newTaskId,
        newTaskUrl,
        frameUrl:    frameResult?.folderUrl || null,
        frameExisted: frameResult?.existed ?? null,
        frameWarning: frameWarning || null,
      });
    }
  }

  // Summary log
  const created = results.filter((r) => r.status === 'created').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const errors  = results.filter((r) => r.status === 'error').length;
  logger.info(`[languagesPipeline] Done — created: ${created}, skipped: ${skipped}, errors: ${errors}`);

  res.json({ results, summary: { created, skipped, errors, total: results.length } });
});

export default router;
