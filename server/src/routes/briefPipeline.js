import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { pgQuery } from '../db/pg.js';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  getAdAccounts, getPages, getPixels, getCampaigns, getAdSets,
  getCustomAudiences, createAdSet, createFlexibleAdCreative, createAd,
  uploadAdImage, uploadAdVideo, uploadAdImageFromUrl, isMetaAdsConfigured, getAllAdAccountIds
} from '../services/metaAdsApi.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const YTDLP_PATH = join(__dirname, '..', '..', '..', 'bin', 'yt-dlp');

const router = Router();

// ── Config ────────────────────────────────────────────────────────────
const CLICKUP_TOKEN = process.env.CLICKUP_API_TOKEN || '';
const VIDEO_ADS_LIST = '901518716584';
const MEDIA_BUYING_LIST = '901518769621';
const CLICKUP_API = 'https://api.clickup.com/api/v2';
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const META_AD_ACCOUNT_IDS = (process.env.META_AD_ACCOUNT_IDS || '').split(',').filter(Boolean);
const META_GRAPH_URL = 'https://graph.facebook.com/v21.0';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-6';

const headers = {
  Authorization: CLICKUP_TOKEN,
  'Content-Type': 'application/json',
};

// ── ClickUp Field IDs ─────────────────────────────────────────────────
const FIELD_IDS = {
  briefNumber: '62b61cc4-2d35-4dfc-86f4-a3913e2bbca3',
  briefType: '98d04d2d-9575-4363-8eee-9bf150b1c319',
  parentBriefId: '4f72235e-0a41-4824-9e67-d27e38ba16d9',
  idea: '0c5460ee-2645-4892-815d-7913fb5d241d',
  angle: '7e740c52-a05b-4b3b-9798-0801acd84b8a',
  creativeType: 'b7f50dff-c752-47a7-830d-c3780021a27f',
  editor: 'a9613cd9-715a-4a2a-bbbb-fbb7f664980a',
  creationWeek: 'a609d8d0-661e-400f-87cb-2557bd48857b',
  creativeStrategist: '372d59af-e573-4eb4-be9f-31cb02f3ad5b',
  copywriter: '3a55a5ef-6ed7-4cd3-b8ad-10ad2eeec472',
  product: '7bc3b414-363e-421e-9445-473b4b8ccf18',
  avatar: '4ad59f88-89cc-45e5-bc56-0027a4ab8624',
  creator: 'be5a2a58-f355-4fac-8263-2824725eaa64',
  namingConvention: 'c97d93bc-ad82-4b90-98e0-092df383d9b8',
  adsFrameLink: 'd90f9f25-d7a0-4eb4-9ded-aca0b4519a3b',
};

// ── Dropdown Option IDs ───────────────────────────────────────────────
const ANGLE_OPTIONS = {
  NA: '2933a618-a7aa-4b42-9e61-c5ee9e0903e5',
  Lottery: '4a493db2-441e-46db-9c58-7b7c3fd0a163',
  Againstcompetition: '0efc2411-1a1a-4d1d-96c6-760e6cff503e',
  'BTC Made easy': '4a1ef4f4-d3e1-4dd3-90a5-b2bd9303d423',
  GTRS: 'c1c56755-f2e4-410d-9f5f-9b3e048c1b36',
  livestream: 'c5e44df4-d814-41dc-acf2-58ab90a2726c',
  Hiddenopportunity: '068ce448-b78e-4b4e-b531-180c422daaa4',
  Rebranding: '1c4f33a4-1034-4101-93ca-93842ca7dc92',
  Missedopportunity: '74f4e8a6-d831-454f-9b39-f15026765a6e',
  BTCFARM: '666601ea-21c1-4685-b1c0-7a951f84dc5f',
  Sale: 'f6cca7fe-4626-4592-90a5-f30efb7a62ba',
  Scarcity: 'e15fc1b9-d90b-4e1b-a4d8-04553e3b8d15',
  Breakingnews: 'e5cd049f-13a5-45e4-a8d7-6b78f0acc9a3',
  Offer: 'e0c1d0fd-b376-4146-8887-ad7c0c209489',
  Reaction: 'bbe5f0c0-8bbf-45a2-bc04-fbcebb11e242',
};

const BRIEF_TYPE_OPTIONS = {
  NN: '1e274045-a4b3-4b0d-85c2-d7ec1a347d3c',
  IT: 'e0999d3c-faab-4d4e-8336-a6272dab8393',
};

const CREATIVE_TYPE_OPTIONS = {
  Mashup: 'a72f1eeb-b245-4a4a-8982-271b52f2650f',
  ShortVid: '02526d2e-ff4f-43db-a586-daf937f6ba86',
  UGC: '95b8cafc-8b15-4a22-be53-7e7398d49d6f',
  VSL: 'ba975681-cebb-416c-8b1f-0880a9cd9e56',
  'Mini VSL': 'e5efc26b-a8bc-4306-9ede-cec47d37ce32',
  'Long VSL': '3cdf6abf-a162-4e81-b32c-e30ae3c7d4ba',
  Cartoon: '3edf3ba9-2518-4699-808d-364ed6831383',
};

const CREATIVE_TYPE_CODES = {
  Mashup: 'HX',
  ShortVid: 'VX',
  UGC: 'UX',
  VSL: 'VL',
  'Mini VSL': 'MV',
  'Long VSL': 'LV',
  Cartoon: 'CT',
};

// ── Relationship Task IDs ─────────────────────────────────────────────
const PRODUCT_TASK_IDS = {
  MR: '86c75fure',
  TX: '86c7jxxtj',
};

const AVATAR_TASK_IDS = {
  Cryptoaddict: '86c7hf58v',
  MoneySeeker: '86c7m5417',
  'Test Avatar': '86c75fyjh',
  Aware: '86c8jhvfk',
  NA: null,
};

const CREATOR_NA_TASK_ID = '86c7n9cvr';

const USER_IDS = {
  Ludovico: 266421907,
  Antoni: 94595626,
  Faiz: 170558610,
  Uly: 106674594,
};

// ── Table Initialization ──────────────────────────────────────────────
let tablesReady = false;

async function ensureTables() {
  if (tablesReady) return;
  try {
    await pgQuery(`
      CREATE TABLE IF NOT EXISTS brief_pipeline_winners (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        creative_id TEXT NOT NULL,
        ad_name TEXT,
        product_code TEXT DEFAULT 'MR',
        angle TEXT,
        format TEXT,
        avatar TEXT,
        editor TEXT,
        hook_type TEXT,
        week TEXT,
        spend NUMERIC(12,2) DEFAULT 0,
        revenue NUMERIC(12,2) DEFAULT 0,
        roas NUMERIC(8,2) DEFAULT 0,
        purchases INTEGER DEFAULT 0,
        cpa NUMERIC(10,2) DEFAULT 0,
        ctr NUMERIC(8,2) DEFAULT 0,
        impressions BIGINT DEFAULT 0,
        clicks BIGINT DEFAULT 0,
        cpm NUMERIC(10,2) DEFAULT 0,
        aov NUMERIC(10,2) DEFAULT 0,
        clickup_task_id TEXT,
        existing_iterations INTEGER DEFAULT 0,
        iteration_codes JSONB DEFAULT '[]',
        raw_script TEXT,
        parsed_script JSONB,
        status TEXT DEFAULT 'detected',
        detected_at TIMESTAMPTZ DEFAULT NOW(),
        selected_at TIMESTAMPTZ,
        winner_reason TEXT,
        iteration_readiness TEXT,
        iteration_mode TEXT,
        iteration_config JSONB,
        thumbnail_url TEXT,
        video_url TEXT,
        UNIQUE(creative_id)
      )
    `, [], { timeout: 15000 });

    // Add columns that may not exist on older tables
    await pgQuery(`ALTER TABLE brief_pipeline_winners ADD COLUMN IF NOT EXISTS thumbnail_url TEXT`).catch(() => {});
    await pgQuery(`ALTER TABLE brief_pipeline_winners ADD COLUMN IF NOT EXISTS video_url TEXT`).catch(() => {});
    await pgQuery(`ALTER TABLE brief_pipeline_winners ADD COLUMN IF NOT EXISTS iteration_mode TEXT`).catch(() => {});
    await pgQuery(`ALTER TABLE brief_pipeline_winners ADD COLUMN IF NOT EXISTS iteration_config JSONB`).catch(() => {});

    await pgQuery(`
      CREATE TABLE IF NOT EXISTS brief_pipeline_generated (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        winner_id UUID REFERENCES brief_pipeline_winners(id),
        parent_creative_id TEXT NOT NULL,
        iteration_mode TEXT,
        aggressiveness TEXT DEFAULT 'medium',
        win_analysis JSONB,
        hooks JSONB DEFAULT '[]',
        body TEXT,
        iteration_direction TEXT,
        novelty_score NUMERIC(3,1),
        aggression_score NUMERIC(3,1),
        coherence_score NUMERIC(3,1),
        overall_score NUMERIC(3,1),
        verdict TEXT,
        scores_json JSONB,
        rank INTEGER,
        brief_number INTEGER,
        product_code TEXT DEFAULT 'MR',
        angle TEXT,
        format TEXT,
        avatar TEXT,
        editor TEXT,
        strategist TEXT DEFAULT 'Ludovico',
        creator TEXT DEFAULT 'NA',
        naming_convention TEXT,
        status TEXT DEFAULT 'generated',
        clickup_task_id TEXT,
        clickup_task_url TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        approved_at TIMESTAMPTZ,
        pushed_at TIMESTAMPTZ
      )
    `, [], { timeout: 15000 });

    await pgQuery(`
      CREATE TABLE IF NOT EXISTS brief_pipeline_analysis_cache (
        creative_id TEXT PRIMARY KEY,
        script_hash TEXT,
        win_analysis JSONB,
        analyzed_at TIMESTAMPTZ DEFAULT NOW()
      )
    `, [], { timeout: 15000 });

    // Recover any winners stuck in 'generating' from a previous crash
    const stuck = await pgQuery(
      `UPDATE brief_pipeline_winners SET status = 'detected' WHERE status = 'generating' RETURNING creative_id`
    ).catch(() => []);
    if (stuck.length) {
      console.log(`[BriefPipeline] Recovered ${stuck.length} stuck winners: ${stuck.map(r => r.creative_id).join(', ')}`);
    }

    tablesReady = true;
    console.log('[BriefPipeline] Tables ready');
  } catch (err) {
    console.error('[BriefPipeline] Table creation error:', err.message);
    throw err;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

async function clickupFetch(url, options = {}) {
  const fullUrl = url.startsWith('http') ? url : `${CLICKUP_API}${url}`;
  const res = await fetch(fullUrl, { ...options, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ClickUp API error ${res.status}: ${text}`);
  }
  return res.json();
}

function getISOWeekNumber() {
  const now = new Date();
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return { weekNum, year: d.getUTCFullYear() };
}

function getCurrentWeekLabel() {
  const { weekNum, year } = getISOWeekNumber();
  return `WK${String(weekNum).padStart(2, '0')}_${year}`;
}

/**
 * Call Claude API and return parsed JSON from the response.
 */
async function callClaude(systemPrompt, userPrompt, maxTokens = 3000, { fast = false, rawText = false } = {}) {
  const messages = [
    { role: 'user', content: userPrompt },
  ];

  const body = {
    model: fast ? 'claude-haiku-4-5-20251001' : CLAUDE_MODEL,
    max_tokens: maxTokens,
    messages,
    system: systemPrompt,
  };

  const res = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || '';

  // Raw text mode — return plain text without JSON parsing
  if (rawText) return text.trim();

  // Strip markdown fences if present, then extract JSON
  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Claude returned no JSON block. Response: ${cleaned.slice(0, 500)}`);
  }
  try {
    return JSON.parse(jsonMatch[0]);
  } catch (parseErr) {
    // Try to fix common issues: trailing commas, truncated responses
    let fixable = jsonMatch[0]
      .replace(/,\s*([}\]])/g, '$1');  // remove trailing commas
    // If still truncated, try to close open braces
    const opens = (fixable.match(/\{/g) || []).length;
    const closes = (fixable.match(/\}/g) || []).length;
    for (let i = 0; i < opens - closes; i++) fixable += '}';
    const openBrackets = (fixable.match(/\[/g) || []).length;
    const closeBrackets = (fixable.match(/\]/g) || []).length;
    for (let i = 0; i < openBrackets - closeBrackets; i++) fixable += ']';
    try { return JSON.parse(fixable); } catch {}
    throw new Error(`Failed to parse Claude JSON: ${parseErr.message}\nRaw: ${jsonMatch[0].slice(0, 300)}`);
  }
}

/**
 * Classify why a winner is winning.
 */
function classifyWinner(winner) {
  if (winner.roas >= 3.0 && winner.total_spend >= 500) return 'volume_winner';
  if (winner.roas >= 2.0) return 'high_roas';
  if (winner.total_spend >= 50 && winner.total_spend <= 500 && winner.roas >= 1.5) return 'rising_star';
  if (winner.cpa <= 20) return 'efficiency_winner';
  return 'high_roas';
}

/**
 * Classify iteration readiness.
 */
function classifyReadiness(winner, existingIterations) {
  if (winner.total_spend < 100) return 'not_enough_data';
  if (existingIterations >= 8) return 'over_iterated';
  return 'ready';
}

/**
 * Count existing iterations for a creative in ClickUp.
 */
async function countIterations(creativeId) {
  let page = 0;
  let hasMore = true;
  const iterations = [];

  while (hasMore) {
    const data = await clickupFetch(
      `/list/${VIDEO_ADS_LIST}/task?page=${page}&limit=100&include_closed=true&subtasks=true`
    );
    const tasks = data.tasks || [];

    for (const task of tasks) {
      const parentField = task.custom_fields?.find(f => f.id === FIELD_IDS.parentBriefId);
      const briefTypeField = task.custom_fields?.find(f => f.id === FIELD_IDS.briefType);

      const briefType = briefTypeField?.type_config?.options?.find(
        o => o.orderindex === briefTypeField?.value
      )?.name;

      if (briefType === 'IT') {
        const parentValue = parentField?.value;
        if (parentValue && parentValue.includes(creativeId)) {
          const briefMatch = task.name?.match(/B(\d{2,5})/);
          if (briefMatch) {
            iterations.push({
              code: `B${briefMatch[1].padStart(4, '0')}`,
              taskId: task.id,
              name: task.name,
              status: task.status?.status,
            });
          }
        }
      }
    }

    hasMore = tasks.length === 100;
    page++;
  }

  return iterations;
}

/**
 * Extract script from a ClickUp task (description + comments).
 */
async function extractScript(clickupTaskId) {
  const task = await clickupFetch(`/task/${clickupTaskId}`);
  const description = task.description || task.text_content || '';

  const comments = await clickupFetch(`/task/${clickupTaskId}/comment`);
  const commentText = (comments.comments || [])
    .map(c => c.comment_text || '')
    .join('\n\n');

  return {
    raw: description + '\n\n' + commentText,
    taskName: task.name,
    status: task.status?.status,
  };
}

/**
 * Find the ClickUp task ID for a creative by its brief code (e.g. B0003).
 */
async function findClickUpTaskByBriefCode(briefCode) {
  const briefNum = parseInt(briefCode.replace(/^B0*/, ''), 10);
  if (isNaN(briefNum)) return null;

  let page = 0;
  let hasMore = true;

  while (hasMore) {
    const data = await clickupFetch(
      `/list/${VIDEO_ADS_LIST}/task?page=${page}&limit=100&include_closed=true&subtasks=true`
    );
    const tasks = data.tasks || [];

    for (const task of tasks) {
      const briefField = task.custom_fields?.find(f => f.id === FIELD_IDS.briefNumber);
      const taskBriefNum = briefField?.value != null ? parseInt(briefField.value, 10) : null;
      const nameMatch = task.name?.match(/B0*(\d+)/);
      const nameBriefNum = nameMatch ? parseInt(nameMatch[1], 10) : null;

      if (taskBriefNum === briefNum || nameBriefNum === briefNum) {
        return task.id;
      }
    }

    hasMore = tasks.length === 100;
    page++;
  }

  return null;
}

/**
 * Get the next available brief number from ClickUp.
 */
async function getNextBriefNumber() {
  let maxBrief = 0;
  let page = 0;
  let hasMore = true;

  while (hasMore) {
    const data = await clickupFetch(
      `/list/${VIDEO_ADS_LIST}/task?page=${page}&limit=100&include_closed=true&subtasks=true`
    );
    const tasks = data.tasks || [];

    for (const task of tasks) {
      const briefField = task.custom_fields?.find(f => f.id === FIELD_IDS.briefNumber);
      if (briefField?.value != null) {
        const num = parseInt(briefField.value, 10);
        if (!isNaN(num) && num > maxBrief) maxBrief = num;
      }
      const match = task.name?.match(/B(\d{2,5})/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (!isNaN(num) && num > maxBrief) maxBrief = num;
      }
    }

    hasMore = tasks.length === 100;
    page++;
  }

  return maxBrief + 1;
}

/**
 * Build the naming convention string.
 */
// Map angle names to short codes for naming conventions
const ANGLE_ABBREV = {
  'pain point': 'PP', 'social proof': 'SP', 'before/after': 'BA',
  'curiosity hook': 'CH', 'direct offer': 'DO', 'authority': 'AU',
};
function abbreviateAngle(angle) {
  if (!angle || angle === 'NA') return 'NA';
  const key = angle.toLowerCase().trim();
  if (ANGLE_ABBREV[key]) return ANGLE_ABBREV[key];
  // Custom angle — take first 2 words, capitalize initials
  return angle.split(/\s+/).slice(0, 3).map(w => w[0]?.toUpperCase()).join('') || angle.slice(0, 6);
}

function buildNamingConvention({ product_code, brief_number, parent_creative_id, avatar, angle, format, strategist, creator, editor, week }) {
  const briefId = `B${String(brief_number).padStart(4, '0')}`;
  return [
    product_code || 'MR',
    briefId,
    'IT',
    parent_creative_id,
    avatar || 'NA',
    abbreviateAngle(angle),
    format || 'Mashup',
    strategist || 'Ludovico',
    creator || 'NA',
    editor || 'Antoni',
    week || getCurrentWeekLabel(),
  ].join(' - ');
}

// ── Transcribe video/audio with Gemini ───────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

async function transcribeWithGemini(mediaUrl) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured — cannot transcribe video');

  console.log(`[BriefPipeline] Downloading media for transcription: ${mediaUrl.slice(0, 80)}...`);

  // Download the media file
  const mediaRes = await fetch(mediaUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MineblockBot/1.0)' },
    redirect: 'follow',
    signal: AbortSignal.timeout(60000),
  });

  if (!mediaRes.ok) throw new Error(`Failed to download media: HTTP ${mediaRes.status}`);

  const buffer = Buffer.from(await mediaRes.arrayBuffer());
  const contentType = mediaRes.headers.get('content-type') || 'video/mp4';
  const sizeMB = buffer.length / 1024 / 1024;

  console.log(`[BriefPipeline] Media downloaded: ${sizeMB.toFixed(1)}MB (${contentType})`);

  const transcriptionPrompt = `Transcribe ALL spoken words in this video/audio. Return ONLY the transcript as plain text — no timestamps, no speaker labels, no commentary, no formatting. Just the exact words spoken, preserving the natural flow and paragraph breaks. If there are multiple speakers, separate their lines with paragraph breaks.`;
  // Use current Gemini models — 1.5 models are deprecated (404)
  const models = ['gemini-2.0-flash', 'gemini-2.0-flash-lite'];
  const mime = contentType.split(';')[0];

  // For files > 15MB, use Gemini File API (upload first, then reference)
  if (sizeMB > 15) {
    console.log(`[BriefPipeline] Large file (${sizeMB.toFixed(1)}MB) — using Gemini File API upload`);
    const fileUri = await uploadToGeminiFileApi(buffer, mime);
    if (fileUri) {
      const requestBody = {
        contents: [{ parts: [
          { fileData: { mimeType: mime, fileUri } },
          { text: transcriptionPrompt },
        ]}],
        generationConfig: { maxOutputTokens: 4096, temperature: 0.1 },
      };
      // Try twice — first pass, then wait 60s and retry (rate limit resets per minute)
      let result = await callGeminiWithRetry(models, requestBody);
      if (result) return result;
      console.log('[BriefPipeline] All Gemini models rate-limited, waiting 60s for reset...');
      await new Promise(r => setTimeout(r, 60000));
      result = await callGeminiWithRetry(models, requestBody);
      if (result) return result;
    }
  }

  // Inline base64 approach (works well for files < 15MB)
  const base64Data = buffer.toString('base64');
  const requestBody = {
    contents: [{ parts: [
      { inlineData: { mimeType: mime, data: base64Data } },
      { text: transcriptionPrompt },
    ]}],
    generationConfig: { maxOutputTokens: 4096, temperature: 0.1 },
  };

  // Try twice — first pass, then wait 60s and retry if rate-limited
  let result = await callGeminiWithRetry(models, requestBody);
  if (result) return result;
  console.log('[BriefPipeline] All Gemini models rate-limited, waiting 60s for reset...');
  await new Promise(r => setTimeout(r, 60000));
  result = await callGeminiWithRetry(models, requestBody);
  if (result) return result;

  throw new Error('Video transcription failed — Gemini rate limit. Please wait 1-2 minutes and try again, or paste the script text manually.');
}

// Upload file to Gemini File API for large media
async function uploadToGeminiFileApi(buffer, mimeType) {
  try {
    // Step 1: Start resumable upload
    const startRes = await fetch(
      `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': buffer.length.toString(),
          'X-Goog-Upload-Header-Content-Type': mimeType,
        },
        body: JSON.stringify({ file: { displayName: 'ad-video-transcription' } }),
        signal: AbortSignal.timeout(30000),
      }
    );

    const uploadUrl = startRes.headers.get('x-goog-upload-url');
    if (!uploadUrl) {
      console.warn('[BriefPipeline] Gemini File API: no upload URL returned');
      return null;
    }

    // Step 2: Upload the file bytes
    console.log(`[BriefPipeline] Uploading ${(buffer.length / 1024 / 1024).toFixed(1)}MB to Gemini File API...`);
    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': buffer.length.toString(),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: buffer,
      signal: AbortSignal.timeout(120000),
    });

    const uploadData = await uploadRes.json();
    const fileUri = uploadData?.file?.uri;
    const state = uploadData?.file?.state;

    if (!fileUri) {
      console.warn('[BriefPipeline] Gemini File API: no file URI in response', JSON.stringify(uploadData).slice(0, 200));
      return null;
    }

    // Step 3: Wait for file processing (poll until ACTIVE)
    if (state !== 'ACTIVE') {
      console.log(`[BriefPipeline] File uploaded, waiting for processing (state: ${state})...`);
      const fileName = uploadData.file.name;
      for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const checkRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${GEMINI_API_KEY}`);
        const checkData = await checkRes.json();
        if (checkData.state === 'ACTIVE') {
          console.log('[BriefPipeline] File processing complete');
          return checkData.uri;
        }
        if (checkData.state === 'FAILED') {
          console.warn('[BriefPipeline] File processing failed');
          return null;
        }
      }
      console.warn('[BriefPipeline] File processing timed out');
      return null;
    }

    console.log(`[BriefPipeline] File uploaded and ready: ${fileUri.slice(0, 80)}`);
    return fileUri;
  } catch (err) {
    console.warn('[BriefPipeline] Gemini File API upload error:', err.message);
    return null;
  }
}

// Call Gemini with retry across multiple models
async function callGeminiWithRetry(models, requestBody) {
  let lastError = null;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) {
          // Longer backoff on retry — 30s for rate limits
          const backoff = lastError?.includes('Rate limited') ? 30000 : 10000;
          console.log(`[BriefPipeline] Retrying ${model} in ${backoff / 1000}s...`);
          await new Promise(r => setTimeout(r, backoff));
        }
        console.log(`[BriefPipeline] Trying Gemini model: ${model} (attempt ${attempt + 1})`);
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
        const geminiRes = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(120000),
        });

        if (geminiRes.status === 429) {
          console.warn(`[BriefPipeline] ${model} rate limited (429), trying next model...`);
          lastError = `${model}: Rate limited`;
          break; // Skip retries on same model, move to next model
        }

        if (geminiRes.status === 404) {
          console.warn(`[BriefPipeline] ${model} not found (404), skipping...`);
          lastError = `${model}: Model not found`;
          break; // Skip retries, model doesn't exist
        }

        if (!geminiRes.ok) {
          const errText = await geminiRes.text();
          lastError = `${model}: HTTP ${geminiRes.status}`;
          console.warn(`[BriefPipeline] ${model} failed: HTTP ${geminiRes.status} — ${errText.slice(0, 150)}`);
          continue;
        }

        const geminiData = await geminiRes.json();
        const transcript = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (transcript && transcript.length >= 20) {
          console.log(`[BriefPipeline] Transcription complete with ${model}: ${transcript.length} chars`);
          return transcript.trim();
        }
        lastError = `${model}: Empty transcript`;
      } catch (err) {
        lastError = `${model}: ${err.message}`;
        console.warn(`[BriefPipeline] ${model} error:`, err.message);
      }
    }
  }
  return null;
}


// Sanitize URL for safe shell usage — reject anything with shell metacharacters
function sanitizeUrlForShell(url) {
  if (!url || typeof url !== 'string') return null;
  // Only allow http/https URLs with safe characters
  if (!/^https?:\/\/[^\s"'`$;|&()<>\\]+$/.test(url)) return null;
  return url;
}

// ── Smart URL extraction: handles FB Ad Library, Atria, direct video, HTML pages ──
// ── Extract video URL from any page using yt-dlp ────────────────────
// Extract video metadata (title, description, ad copy) using yt-dlp — no API needed
async function extractMetadataWithYtdlp(pageUrl) {
  if (!existsSync(YTDLP_PATH)) return null;
  const safeUrl = sanitizeUrlForShell(pageUrl);
  if (!safeUrl) { console.warn('[BriefPipeline] Rejected unsafe URL for yt-dlp'); return null; }
  try {
    console.log(`[BriefPipeline] Extracting metadata with yt-dlp: ${safeUrl.slice(0, 100)}`);
    const result = execSync(
      `"${YTDLP_PATH}" -j --no-warnings --skip-download "${safeUrl}"`,
      { timeout: 45000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    const data = JSON.parse(result);
    return {
      title: data.title || '',
      description: data.description || '',
      uploader: data.uploader || '',
      duration: data.duration || 0,
    };
  } catch (err) {
    console.warn('[BriefPipeline] yt-dlp metadata extraction failed:', err.message?.slice(0, 150));
    return null;
  }
}

async function extractVideoUrlWithYtdlp(pageUrl, { audioOnly = false } = {}) {
  if (!existsSync(YTDLP_PATH)) {
    console.warn('[BriefPipeline] yt-dlp not available at', YTDLP_PATH);
    return null;
  }
  const safeUrl = sanitizeUrlForShell(pageUrl);
  if (!safeUrl) { console.warn('[BriefPipeline] Rejected unsafe URL for yt-dlp'); return null; }

  // For transcription: prefer smallest audio to avoid huge uploads to Gemini
  // For other uses: get best video
  const strategies = audioOnly ? [
    // Audio-only strategies (small files, fast transcription)
    `"${YTDLP_PATH}" --get-url --no-warnings -f "worstaudio[ext=m4a]/worstaudio/worst" "${safeUrl}"`,
    `"${YTDLP_PATH}" --get-url --no-warnings -f "bestaudio[ext=m4a]/bestaudio" "${safeUrl}"`,
    `"${YTDLP_PATH}" --get-url --no-warnings -f "worst" "${safeUrl}"`,
  ] : [
    `"${YTDLP_PATH}" --get-url --no-warnings -f "best[ext=mp4]/best" "${safeUrl}"`,
    `"${YTDLP_PATH}" --get-url --no-warnings -f "best" "${safeUrl}"`,
    `"${YTDLP_PATH}" --get-url --no-warnings --force-generic-extractor "${safeUrl}"`,
  ];

  for (let i = 0; i < strategies.length; i++) {
    try {
      console.log(`[BriefPipeline] yt-dlp strategy ${i + 1}${audioOnly ? ' (audio)' : ''} for: ${pageUrl.slice(0, 100)}`);
      const result = execSync(strategies[i], {
        timeout: 45000,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      const firstUrl = result.split('\n').find(line => line.startsWith('http'));
      if (firstUrl) {
        console.log(`[BriefPipeline] yt-dlp extracted URL (strategy ${i + 1}): ${firstUrl.slice(0, 120)}...`);
        return firstUrl;
      }
    } catch (err) {
      console.warn(`[BriefPipeline] yt-dlp strategy ${i + 1} failed:`, err.message?.slice(0, 200));
    }
  }

  return null;
}

async function extractScriptFromUrl(url) {
  // Strategy 1: Facebook Ad Library URL → yt-dlp extract video → Gemini transcribe
  const fbAdMatch = url.match(/facebook\.com\/ads\/library\/?\?.*id=(\d+)/i)
    || url.match(/fb\.com\/ads\/library\/?\?.*id=(\d+)/i);
  if (fbAdMatch) {
    const adId = fbAdMatch[1];
    console.log(`[BriefPipeline] Facebook Ad Library detected, ad ID: ${adId}`);

    // Step 1: Extract metadata (title, description, ad copy) — instant, no API calls
    const metadata = await extractMetadataWithYtdlp(url);
    if (metadata) {
      const adCopy = [metadata.title, metadata.description].filter(Boolean).join('\n\n').trim();
      if (adCopy.length > 50) {
        console.log(`[BriefPipeline] Got ad copy from metadata (${adCopy.length} chars), using as script reference`);
        // For short ad copy + long video, append note that there's likely more spoken content
        if (metadata.duration > 30 && adCopy.length < 300) {
          console.log(`[BriefPipeline] Ad copy is short (${adCopy.length} chars) for ${metadata.duration}s video — will also try audio transcription`);
        } else {
          return adCopy;
        }
      }
    }

    // Step 2: Try audio transcription with yt-dlp + Gemini (audio-only = small file)
    const audioUrl = await extractVideoUrlWithYtdlp(url, { audioOnly: true });
    if (audioUrl) {
      try {
        const transcript = await transcribeWithGemini(audioUrl);
        // If we also have metadata, combine them for richer context
        if (metadata?.description && metadata.description.length > 30) {
          return `[AD COPY]\n${metadata.title || ''}\n${metadata.description}\n\n[VOICEOVER TRANSCRIPT]\n${transcript}`;
        }
        return transcript;
      } catch (audioErr) {
        console.warn(`[BriefPipeline] Audio transcription failed:`, audioErr.message);
        // If we have metadata ad copy, use that as fallback
        if (metadata) {
          const adCopy = [metadata.title, metadata.description].filter(Boolean).join('\n\n').trim();
          if (adCopy.length > 50) {
            console.log(`[BriefPipeline] Using metadata ad copy as fallback (${adCopy.length} chars)`);
            return `[AD COPY FROM METADATA — audio transcription was not available]\n${adCopy}`;
          }
        }
      }
    }

    // Step 3: Try full video transcription
    const videoUrl = await extractVideoUrlWithYtdlp(url);
    if (videoUrl) {
      try {
        return await transcribeWithGemini(videoUrl);
      } catch (videoErr) {
        console.warn(`[BriefPipeline] Video transcription failed:`, videoErr.message);
        // If we have ANY metadata, use it rather than failing completely
        if (metadata) {
          const adCopy = [metadata.title, metadata.description].filter(Boolean).join('\n\n').trim();
          if (adCopy.length > 20) {
            console.log(`[BriefPipeline] Using metadata as last resort (${adCopy.length} chars)`);
            return `[AD COPY FROM METADATA — video transcription failed]\n${adCopy}`;
          }
        }
      }
    }

    // Step 4: Fallback to Meta API
    try {
      return await extractFromMetaAdId(adId);
    } catch (apiErr) {
      // If we have metadata from step 1, use it rather than completely failing
      if (metadata) {
        const adCopy = [metadata.title, metadata.description].filter(Boolean).join('\n\n').trim();
        if (adCopy.length > 20) return `[AD COPY FROM METADATA — all extraction methods failed]\n${adCopy}`;
      }
      console.error(`[BriefPipeline] All extraction failed for FB ad ${adId}. yt-dlp: ${existsSync(YTDLP_PATH) ? 'installed' : 'NOT INSTALLED'}, META_ACCESS_TOKEN: ${META_ACCESS_TOKEN ? 'set' : 'NOT SET'}`);
      throw new Error(`Could not extract ad ${adId}. This is a video ad that requires transcription. Try: (1) Right-click the video → "Copy video address" and paste the direct .mp4 link, or (2) Use "Paste Text" to paste the script manually.`);
    }
  }

  // Strategy 1b: Any Facebook video URL → yt-dlp (audio first, then video)
  const isFacebookUrl = /facebook\.com|fb\.com|fb\.watch/i.test(url);
  if (isFacebookUrl) {
    const audioUrl = await extractVideoUrlWithYtdlp(url, { audioOnly: true });
    if (audioUrl) {
      try { return await transcribeWithGemini(audioUrl); } catch {}
    }
    const videoUrl = await extractVideoUrlWithYtdlp(url);
    if (videoUrl) {
      return await transcribeWithGemini(videoUrl);
    }
  }

  // Strategy 2: Atria URL → fetch Atria page (has server-rendered content) → fallback to Meta API
  const atriaMatch = url.match(/tryatria\.com\/ad\//i);
  if (atriaMatch) {
    console.log(`[BriefPipeline] Atria ad detected: ${url}`);
    try {
      // Atria pages often have ad text in the HTML — try fetching directly first
      const atriaRes = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      const atriaHtml = await atriaRes.text();
      console.log(`[BriefPipeline] Atria page HTML: ${atriaHtml.length} chars`);

      // Try extracting ad text from Atria page HTML
      if (atriaHtml.length > 500) {
        // Look for video URLs first (Atria often embeds the ad video)
        const videoPatterns = [
          /(?:src|data-src|poster|content|url)\s*[=:]\s*["']?(https?:\/\/[^"'\s>]+\.(?:mp4|webm|mov)(?:\?[^"'\s>]*)?)/gi,
          /"(?:video_url|videoUrl|video_src|source|src|url|mp4)"\s*:\s*"(https?:\/\/[^"]+\.(?:mp4|webm|mov)[^"]*)"/gi,
          /"(https?:\\\/\\\/[^"]*?\.mp4[^"]*)"/gi,
        ];
        let videoUrl = null;
        for (const pattern of videoPatterns) {
          const match = pattern.exec(atriaHtml);
          if (match?.[1]) {
            videoUrl = match[1].replace(/\\\//g, '/').replace(/&amp;/g, '&');
            break;
          }
        }
        if (videoUrl) {
          console.log(`[BriefPipeline] Found video in Atria page, transcribing: ${videoUrl.slice(0, 100)}`);
          return await transcribeWithGemini(videoUrl);
        }

        // Try extracting text content via Claude
        const extracted = await callClaude(
          'You are a text extraction tool for ad pages. Extract any ad copy, ad script, voiceover text, or sales copy from this HTML.',
          `Extract the main ad copy or script text from this Atria ad page. Return ONLY the ad text as plain text, no commentary. If you find a video transcript or ad copy, return it. If there is no readable ad text, respond with exactly "NO_CONTENT_FOUND".\n\nHTML (first 20000 chars):\n${atriaHtml.slice(0, 20000)}`,
          2000,
          { rawText: true },
        );
        if (extracted && extracted !== 'NO_CONTENT_FOUND' && extracted.length >= 50) {
          console.log(`[BriefPipeline] Extracted ${extracted.length} chars from Atria page`);
          return extracted;
        }
      }

      // Fallback: try Meta API with extracted ad ID
      const metaIdMatch = url.match(/\/m(\d+)/i) || url.match(/(\d{10,})/);
      if (metaIdMatch) {
        console.log(`[BriefPipeline] Atria page had no content, trying Meta API with ID: ${metaIdMatch[1]}`);
        return await extractFromMetaAdId(metaIdMatch[1]);
      }
    } catch (err) {
      console.warn(`[BriefPipeline] Atria extraction failed:`, err.message);
      // Try Meta API as last resort
      const metaIdMatch = url.match(/\/m(\d+)/i) || url.match(/(\d{10,})/);
      if (metaIdMatch) {
        return await extractFromMetaAdId(metaIdMatch[1]);
      }
    }
    throw new Error('Atria pages require a browser to load. Right-click the video on the Atria page → "Copy video address" and paste the direct video URL, or paste the ad script text manually.');
  }

  // Strategy 3: Direct media URL
  const isDirectMedia = /\.(mp4|mp3|wav|webm|m4a|ogg|mov)(\?|$)/i.test(url);
  if (isDirectMedia) {
    console.log(`[BriefPipeline] Direct media URL detected`);
    return await transcribeWithGemini(url);
  }

  // Strategy 4: Fetch HTML page
  const fetchRes = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  const contentType = fetchRes.headers.get('content-type') || '';

  // If response is media, transcribe directly
  if (contentType.startsWith('audio/') || contentType.startsWith('video/')) {
    return await transcribeWithGemini(url);
  }

  const html = await fetchRes.text();

  // Strategy 5: Try to extract ad text from HTML
  if (html.length > 200) {
    const extracted = await callClaude(
      'You are a text extraction tool for ad pages.',
      `Extract the main ad copy, sales text, or video script from this HTML. If there is readable ad copy or sales text, return it as plain text. If the page is mostly JavaScript with no readable content, respond with exactly "NO_CONTENT_FOUND".\n\nHTML (first 15000 chars):\n${html.slice(0, 15000)}`,
      2000,
      { rawText: true },
    );
    if (extracted && extracted !== 'NO_CONTENT_FOUND' && extracted.length >= 50) {
      return extracted;
    }
  }

  // Strategy 6: Search HTML for video URLs → transcribe
  console.log(`[BriefPipeline] No text found, searching for video URLs in HTML`);
  const videoUrlPatterns = [
    /(?:src|href|data-src|data-video|content|url)\s*[=:]\s*["']?(https?:\/\/[^"'\s>]+\.(?:mp4|webm|m4v|mov)(?:\?[^"'\s>]*)?)/gi,
    /property=["']og:video["'][^>]*content=["'](https?:\/\/[^"']+)/gi,
    /content=["'](https?:\/\/[^"']+)["'][^>]*property=["']og:video/gi,
    /"(?:video_url|videoUrl|video_src|video_sd_url|video_hd_url|source|src|url)"\s*:\s*"(https?:\/\/[^"]+\.(?:mp4|webm|m4v)[^"]*)"/gi,
  ];

  let videoUrl = null;
  for (const pattern of videoUrlPatterns) {
    const match = pattern.exec(html);
    if (match?.[1]) { videoUrl = match[1]; break; }
  }

  if (videoUrl) {
    console.log(`[BriefPipeline] Found video URL in HTML: ${videoUrl.slice(0, 80)}...`);
    return await transcribeWithGemini(videoUrl);
  }

  // Strategy 7: Last resort — try yt-dlp on the original URL (works for many video platforms)
  console.log(`[BriefPipeline] Trying yt-dlp as last resort for: ${url.slice(0, 80)}`);
  const ytdlpVideoUrl = await extractVideoUrlWithYtdlp(url);
  if (ytdlpVideoUrl) {
    return await transcribeWithGemini(ytdlpVideoUrl);
  }

  throw new Error('Could not extract ad content from this URL. For video ads: right-click the video → "Copy video address" and paste the direct .mp4 link. Or use "Paste Text" to paste the script manually.');
}

// ── Extract video/text from Meta ad ID → transcribe if needed ────────
async function extractFromMetaAdId(adId) {
  if (!META_ACCESS_TOKEN) {
    throw new Error('META_ACCESS_TOKEN not configured. Try pasting the ad text manually.');
  }

  const errors = [];

  // Strategy A: Ad Library API (works for ANY public ad, not just yours)
  try {
    console.log(`[BriefPipeline] Trying Ad Library API for ad ${adId}`);
    const libUrl = `${META_GRAPH_URL}/ads_archive?ad_reached_countries=US&search_terms=*&ad_archive_id=${adId}&fields=ad_snapshot_url,ad_creative_bodies,ad_creative_link_titles,ad_creative_link_descriptions&limit=1&access_token=${META_ACCESS_TOKEN}`;
    const libRes = await fetch(libUrl, { signal: AbortSignal.timeout(15000) });
    const libData = await libRes.json();
    console.log(`[BriefPipeline] Ad Library response:`, JSON.stringify(libData).slice(0, 300));

    if (libData.data?.length) {
      const ad = libData.data[0];

      // Try text bodies first
      const bodies = ad.ad_creative_bodies || [];
      if (bodies.length && bodies[0].length > 20) {
        const titles = ad.ad_creative_link_titles || [];
        const descs = ad.ad_creative_link_descriptions || [];
        let fullText = bodies.join('\n\n');
        if (titles.length) fullText = `${titles[0]}\n\n${fullText}`;
        if (descs.length) fullText += `\n\n${descs[0]}`;
        console.log(`[BriefPipeline] Got ad text from Ad Library: ${fullText.length} chars`);
        return fullText;
      }

      // Try snapshot URL for video extraction
      if (ad.ad_snapshot_url) {
        console.log(`[BriefPipeline] Fetching ad snapshot: ${ad.ad_snapshot_url}`);
        const snapRes = await fetch(ad.ad_snapshot_url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
          redirect: 'follow',
          signal: AbortSignal.timeout(15000),
        });
        const snapHtml = await snapRes.text();
        console.log(`[BriefPipeline] Snapshot HTML length: ${snapHtml.length}`);

        // Look for video URLs in snapshot (multiple patterns)
        const videoPatterns = [
          /"(?:sd_src_no_ratelimit|sd_src|hd_src|hd_src_no_ratelimit|video_url)"\s*:\s*"(https?:[^"]+)"/gi,
          /src=["'](https?:\/\/[^"']*?video[^"']*?\.mp4[^"']*)/gi,
          /src=["'](https?:\/\/[^"']*?\.mp4[^"']*)/gi,
          /"(https?:\\\/\\\/[^"]*?\.mp4[^"]*)"/gi,
        ];

        let videoSrc = null;
        for (const pattern of videoPatterns) {
          const match = pattern.exec(snapHtml);
          if (match?.[1]) {
            videoSrc = match[1].replace(/\\\//g, '/').replace(/&amp;/g, '&');
            break;
          }
        }

        if (videoSrc) {
          console.log(`[BriefPipeline] Found video in snapshot, transcribing: ${videoSrc.slice(0, 80)}...`);
          return await transcribeWithGemini(videoSrc);
        }

        // If no video found, try to extract any text content from snapshot
        const snapText = await callClaude(
          'You are a text extraction tool.',
          `Extract any ad copy, script text, or spoken dialogue from this HTML page. Return only the text, no commentary. If no ad text is found, respond "NO_CONTENT_FOUND".\n\nHTML:\n${snapHtml.slice(0, 15000)}`,
          2000,
          { rawText: true },
        );
        if (snapText && snapText !== 'NO_CONTENT_FOUND' && snapText.length > 30) {
          return snapText;
        }
      }
    } else {
      errors.push(`Ad Library: ${libData.error?.message || 'No results found'}`);
    }
  } catch (err) {
    errors.push(`Ad Library: ${err.message}`);
    console.warn(`[BriefPipeline] Ad Library API failed:`, err.message);
  }

  // Strategy B: Try your own ad accounts (works for your own ads)
  for (const accountId of META_AD_ACCOUNT_IDS) {
    try {
      const searchUrl = `${META_GRAPH_URL}/${accountId}/ads?fields=name,creative.fields(thumbnail_url,video_id,body,title,link_description)&filtering=[{"field":"ad.id","operator":"EQUAL","value":"${adId}"}]&limit=5&access_token=${META_ACCESS_TOKEN}`;
      const searchRes = await fetch(searchUrl, { signal: AbortSignal.timeout(10000) });
      const searchData = await searchRes.json();

      if (searchData.data?.length) {
        const creative = searchData.data[0].creative || {};
        if (creative.body && creative.body.length > 20) {
          let fullText = creative.body;
          if (creative.title) fullText = `${creative.title}\n\n${fullText}`;
          return fullText;
        }
        if (creative.video_id) {
          const vidRes = await fetch(`${META_GRAPH_URL}/${creative.video_id}?fields=source&access_token=${META_ACCESS_TOKEN}`);
          const vidData = await vidRes.json();
          if (vidData.source) return await transcribeWithGemini(vidData.source);
        }
      }
    } catch (err) {
      errors.push(`Account ${accountId}: ${err.message}`);
    }
  }

  // Strategy C: Try fetching the FB Ad Library page directly and scraping
  try {
    console.log(`[BriefPipeline] Trying direct FB Ad Library page fetch`);
    const fbPageUrl = `https://www.facebook.com/ads/library/?id=${adId}`;
    const fbRes = await fetch(fbPageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    const fbHtml = await fbRes.text();

    // Try to find video in the page
    const vidMatch = fbHtml.match(/"(?:sd_src_no_ratelimit|sd_src|hd_src)"\s*:\s*"(https?:[^"]+)"/i);
    if (vidMatch?.[1]) {
      const videoSrc = vidMatch[1].replace(/\\\//g, '/').replace(/&amp;/g, '&');
      console.log(`[BriefPipeline] Found video in FB page, transcribing`);
      return await transcribeWithGemini(videoSrc);
    }

    // Try to extract text from the page
    const fbText = await callClaude(
      'You are a text extraction tool.',
      `Extract any ad copy or text content from this Facebook Ad Library page HTML. Return only the ad text, no commentary. If no text found, respond "NO_CONTENT_FOUND".\n\nHTML:\n${fbHtml.slice(0, 20000)}`,
      2000,
      { rawText: true },
    );
    if (fbText && fbText !== 'NO_CONTENT_FOUND' && fbText.length > 30) {
      return fbText;
    }
  } catch (err) {
    errors.push(`Direct FB page: ${err.message}`);
  }

  throw new Error(`Could not extract ad ${adId}. Right-click the video → "Copy video address" and paste the direct .mp4 link, or paste the script text manually.`);
}

// ── Fetch product profile from DB ────────────────────────────────────
async function fetchProductProfile(productCode) {
  try {
    const rows = await pgQuery(
      `SELECT * FROM product_profiles WHERE LOWER(short_name) = LOWER($1) OR LOWER(product_code) = LOWER($1) OR LOWER(name) ILIKE '%' || LOWER($1) || '%' ORDER BY updated_at DESC LIMIT 1`,
      [productCode || 'MR']
    );
    if (!rows.length) {
      console.warn(`[BriefPipeline] No product profile found for code: ${productCode || 'MR'}`);
      return null;
    }
    const p = rows[0];
    // Parse JSONB fields
    for (const f of ['product_images', 'logos', 'fonts', 'brand_colors', 'benefits', 'angles', 'scripts', 'offers']) {
      if (p[f] && typeof p[f] === 'string') try { p[f] = JSON.parse(p[f]); } catch {}
    }
    return p;
  } catch (err) {
    console.error(`[BriefPipeline] fetchProductProfile error for ${productCode}:`, err.message);
    return null;
  }
}

function buildProductContextForBrief(p) {
  if (!p) return 'No product profile available.';
  const lines = [
    p.name             && `Product: ${p.name}`,
    p.description      && `Description: ${p.description}`,
    p.price            && `Price: ${p.price}`,
    p.product_url      && `Product URL: ${p.product_url}`,
    p.big_promise      && `Big Promise: ${p.big_promise}`,
    p.mechanism        && `Unique Mechanism: ${p.mechanism}`,
    p.benefits?.length && `Key Benefits: ${Array.isArray(p.benefits) ? p.benefits.map(b => b.text || b.name || b).join(', ') : p.benefits}`,
    p.differentiator   && `Differentiator: ${p.differentiator}`,
    p.guarantee        && `Guarantee: ${p.guarantee}`,
    p.customer_avatar  && `Target Customer: ${p.customer_avatar}`,
    p.customer_frustration && `Customer Frustration: ${p.customer_frustration}`,
    p.customer_dream   && `Customer Dream Outcome: ${p.customer_dream}`,
    p.target_demographics && `Target Demographics: ${p.target_demographics}`,
    p.voice            && `Brand Voice/Tone: ${p.voice}`,
    p.winning_angles   && `Winning Angles: ${p.winning_angles}`,
    p.angles?.length   && `Proven Angles: ${Array.isArray(p.angles) ? p.angles.map(a => a.name || a).join(', ') : p.angles}`,
    p.pain_points      && `Pain Points: ${p.pain_points}`,
    p.common_objections && `Common Objections: ${p.common_objections}`,
    p.competitive_edge && `Competitive Edge: ${p.competitive_edge}`,
    p.offer_details    && `Offer Details: ${p.offer_details}`,
    p.discount_codes   && `Discount Codes: ${p.discount_codes}`,
    p.bundle_variants  && `Bundle Variants: ${p.bundle_variants}`,
    p.offers?.length   && `Active Offers: ${Array.isArray(p.offers) ? p.offers.map(o => o.name || o.title || o.text || JSON.stringify(o)).join('; ') : p.offers}`,
    p.compliance_restrictions && `COMPLIANCE — Never claim: ${p.compliance_restrictions}`,
  ].filter(Boolean);
  return lines.join('\n');
}

// ── Claude Prompts ────────────────────────────────────────────────────

async function buildScriptParserPrompt(rawScript, taskName) {
  // If the raw input is very short or looks like metadata (product name, price), skip hook extraction
  const isMetadataLike = rawScript.length < 150 || /^[A-Z][\w\s]+[-–]\s*(Only\s*)?\$[\d.]+/i.test(rawScript.trim());

  let system = `You are a script parser for video ad briefs. Extract the structured components from the raw script text below.${isMetadataLike ? ' NOTE: The input appears to be brief ad copy or metadata, NOT a full script. Put the entire text in the body field. Do NOT invent or fabricate hooks that are not explicitly present.' : ''}`;
  let user = `RAW SCRIPT:
${rawScript}

TASK NAME: ${taskName}

Extract and return ONLY valid JSON:
{
  "hooks": [
    {
      "id": "H1",
      "text": "the full hook text",
      "mechanism": "fear" | "curiosity" | "social_proof" | "authority" | "controversy" | "shock" | "question" | "statistic" | "story" | "challenge",
      "length": "short" | "medium" | "long"
    }
  ],
  "body": "the full body script text, preserving paragraphs",
  "cta": "the call-to-action text if present",
  "format_notes": "any production notes, visual directions, or format instructions",
  "estimated_length_seconds": number,
  "villains": ["list of enemies/villains mentioned"],
  "proof_elements": ["list of proof mechanisms used"],
  "offer_mentioned": true/false,
  "discount_code_used": "MINER10" or null
}

RULES:
- Hooks are usually labeled H1, H2, H3 or Hook 1, Hook 2, Hook 3 or numbered
- If hooks aren't explicitly labeled, the first 1-3 sentences before the body are hooks
- The body is everything after the hooks until the CTA
- Preserve the exact wording — do NOT paraphrase or rewrite
- If the script has multiple sections (e.g. "Body:", "CTA:"), respect those boundaries`;

  // Check for custom prompt overrides
  try {
    const custom = await getCustomPrompts();
    if (custom?.scriptParser) {
      if (custom.scriptParser.system) system = custom.scriptParser.system;
      if (custom.scriptParser.user) user = custom.scriptParser.user;
    }
  } catch (customErr) {
    console.warn('[BriefPipeline] Custom prompt load error:', customErr.message);
  }

  return { system, user };
}

// ── 3-Agent Deep Analysis (replaces old single win analysis) ─────────
async function buildDeepAnalysisPrompts(winner, parsedScript, productContext) {
  const hooksFormatted = (parsedScript.hooks || [])
    .map(h => `${h.id}: ${h.text}`)
    .join('\n');
  const scriptText = `Hooks:\n${hooksFormatted}\n\nBody:\n${parsedScript.body || '(no body)'}`;
  const perfContext = `Performance (last 7 days): Spend $${winner.spend}, ROAS ${winner.roas}x, CPA $${winner.cpa}, CTR ${winner.ctr}%, Purchases ${winner.purchases}`;

  // ── Agent 1: Script DNA ──
  const dnaPrompt = {
    system: 'You are a senior direct-response strategist and copy analyst.',
    user: `# TASK
Deconstruct this winning ad into its core conversion components AND map its narrative structure step-by-step. Identify the logical engine — WHY this ad converts, not just what it says.

# AD CONTEXT
- Brief Code: ${winner.creative_id}
- Angle: ${winner.angle || 'NA'}
- Format: ${winner.format || 'Mashup'}
- ${perfContext}

# PRODUCT CONTEXT
${productContext}

# WINNING AD SCRIPT
${scriptText}

# OUTPUT (JSON only, no markdown, no backticks, no explanation)
{
  "core_angle": "the central persuasion angle driving the ad",
  "primary_emotion": "the dominant emotion leveraged",
  "secondary_emotions": ["list", "of", "supporting", "emotions"],
  "target_desire": "what the viewer wants that this ad promises",
  "target_fear": "what the viewer is afraid of that this ad addresses",
  "belief_shift": "what belief must change for the viewer to buy",
  "problem_presented": "the specific problem framed in the ad",
  "solution_presented": "how the product/offer is positioned as the answer",
  "mechanism": "the unique mechanism or reason WHY the solution works",
  "proof_type": "how credibility is established",
  "cta_type": "how the call to action is structured",
  "audience_awareness_level": "unaware / problem-aware / solution-aware / product-aware / most-aware",
  "narrative_structure": {
    "hook_type": "the hook technique used",
    "opening_tension": "what tension or open loop is created immediately",
    "problem_escalation": "how the problem is intensified after the hook",
    "explanation": "how the solution/mechanism is introduced and explained",
    "proof_moment": "where and how proof or credibility is delivered",
    "contrast": "any before/after or us-vs-them comparison (or null if absent)",
    "resolution": "how tension is resolved and the viewer is moved toward action",
    "cta_structure": "exact CTA approach"
  },
  "why_it_works": "1-2 sentences on WHY this ad converts",
  "core_argument": "the central argument in one sentence",
  "undeniable_truth": "the fact or truth used to make the argument believable",
  "what_makes_it_believable": "the credibility mechanism",
  "what_would_break_it": "the single change that would destroy this ad's effectiveness",
  "structural_skeleton": {
    "hook_framework": "the exact hook technique/framework used (e.g. 'confession/apology', 'warning', 'story opening', 'question', 'bold claim')",
    "rhetorical_devices": ["list every distinct rhetorical device or pattern used in the body — e.g. 'repetition (yes it's true that...)', 'twist reveal (here's where I lied)', 'us-vs-them comparison', 'social proof anecdote', 'stacking benefits'"],
    "section_by_section": ["list each section of the script in order — e.g. 'Apology/confession hook', 'Repetitive validation (5x yes statements)', 'Emotional testimonial', 'Twist reveal', 'Competitor callout', 'Urgency close'"],
    "signature_phrases": ["list any distinctive phrases or patterns that define this script's identity — e.g. 'Yes, it's true that...', 'Here's where I lied', 'A lottery ticket that never expires'"],
    "pacing_rhythm": "describe the sentence rhythm pattern (e.g. 'Short punchy opener, then long flowing validation paragraphs, then short twist')"
  }
}

# RULES
- Be precise, not generic. Every field must be specific to THIS ad.
- Do NOT rewrite the ad. Extract what makes it convert.
- Focus on reasoning, not wording.
- The structural_skeleton is CRITICAL — it must capture the exact rhetorical framework so iterations can replicate the same skeleton with different words.`
  };

  // ── Agent 2: Psychology ──
  const psychologyPrompt = {
    system: 'You are a consumer psychology expert and hook specialist for paid social ads.',
    user: `# TASK
Perform three analyses on this winning ad:
1. Map the emotional journey of the viewer at each stage
2. Deep-analyze every hook in the ad
3. Infer and validate the target audience against the product profile

# PRODUCT CONTEXT
${productContext}

# WINNING AD SCRIPT
${scriptText}

# OUTPUT (JSON only, no markdown, no backticks, no explanation)
{
  "emotional_arc": {
    "at_hook": "what the viewer feels in the first 1-3 seconds",
    "after_problem": "emotional state once the problem is presented",
    "during_explanation": "how the viewer feels as the mechanism/solution unfolds",
    "at_proof": "emotional response to the credibility moment",
    "before_cta": "emotional state right before the call to action",
    "final_state": "the emotion the viewer is left with"
  },
  "hooks": [
    {
      "text": "exact hook text from the ad",
      "hook_type": "curiosity / warning / contrarian / shock / story / authority / social proof / pattern interrupt",
      "scroll_stop_mechanism": "what specifically makes someone stop scrolling",
      "emotional_trigger": "the emotion activated by this hook",
      "why_it_works": "1 sentence on why this hook is effective",
      "strength": 8
    }
  ],
  "hook_patterns": {
    "shared_patterns": "what patterns all hooks share",
    "must_not_change": "what must stay fixed in any new hook variation"
  },
  "audience": {
    "who_is_this_for": "specific description of the target viewer",
    "what_they_already_believe": "existing beliefs the ad leverages",
    "what_they_are_skeptical_about": "doubts or objections they carry",
    "awareness_stage": "unaware / problem-aware / solution-aware / product-aware / most-aware",
    "implicit_objection_handled": "the objection the ad addresses without stating it directly",
    "product_alignment": "how well the ad matches the product profile's target customer"
  }
}

# RULES
- Describe FEELINGS, not content.
- Extract EXACT hook text. List every hook present.
- Cross-reference audience against the product profile.`
  };

  // ── Agent 3: Iteration Rules ──
  const rulesPrompt = {
    system: 'You are a senior creative director specializing in direct-response ad iteration for a media buying team.',
    user: `# TASK
Define the precise boundaries for iteration — what MUST stay fixed, what CAN be varied, and what is HIGH-RISK to change. This output directly constrains the script generator.

# PRODUCT CONTEXT
${productContext}

# WINNING AD SCRIPT
${scriptText}

# OUTPUT (JSON only, no markdown, no backticks, no explanation)
{
  "must_stay_fixed": [
    "list of elements that must NOT change in any iteration"
  ],
  "can_be_varied": [
    "list of elements safe to change"
  ],
  "high_risk_changes": [
    "list of changes that could break the ad"
  ],
  "safe_iteration_directions": [
    "specific creative directions that would produce strong variations"
  ],
  "hook_rules": {
    "must_preserve": "what every new hook must achieve",
    "safe_variations": "specific hook reframing ideas that maintain the core mechanism",
    "avoid": "hook approaches that would disconnect from the body"
  },
  "tone_boundaries": {
    "current_register": "the tone of the original",
    "acceptable_range": "how far the tone can shift",
    "never_do": "tone shifts that would break the ad"
  },
  "compliance_notes": "any claims that must stay within product profile compliance restrictions"
}

# RULES
- Be specific to THIS ad. Generic advice is useless.
- Think like a creative director briefing a copywriter.
- Keep each array item to ONE SHORT sentence (under 20 words). Be concise — no long explanations in list items.
- If the product profile has compliance restrictions, flag any original claims that are borderline.`
  };

  // Check for custom prompt overrides
  try {
    const custom = await getCustomPrompts();
    if (custom?.scriptDna) {
      if (custom.scriptDna.system) dnaPrompt.system = custom.scriptDna.system;
      if (custom.scriptDna.user) dnaPrompt.user = custom.scriptDna.user;
    }
    if (custom?.psychology) {
      if (custom.psychology.system) psychologyPrompt.system = custom.psychology.system;
      if (custom.psychology.user) psychologyPrompt.user = custom.psychology.user;
    }
    if (custom?.iterationRules) {
      if (custom.iterationRules.system) rulesPrompt.system = custom.iterationRules.system;
      if (custom.iterationRules.user) rulesPrompt.user = custom.iterationRules.user;
    }
  } catch (customErr) {
    console.warn('[BriefPipeline] Custom prompt load error (deep analysis):', customErr.message);
  }

  return { dnaPrompt, psychologyPrompt, rulesPrompt };
}

// buildIterationStrategyPrompt removed — directions now built from iterationRules.safe_iteration_directions
// Kept as comment for git history reference
function _deprecated_buildIterationStrategyPrompt(winAnalysis, parsedScript, config, productContext) {
  const hooksFormatted = (parsedScript.hooks || [])
    .map(h => `${h.id}: ${h.text}`)
    .join('\n');

  const fixedElements = (config.fixed_elements || []).join(', ') || 'none';
  const allElements = ['hook mechanism', 'proof type', 'CTA structure', 'villain/enemy', 'emotional driver'];
  const changeableElements = allElements
    .filter(e => !(config.fixed_elements || []).includes(e))
    .join(', ') || 'all';

  const system = `You are an iteration strategist for direct response video ads. Based on the win analysis of a proven ad, you propose specific iteration directions that preserve what works while introducing strategic variation.`;

  // Format the 3-agent analysis for the strategy prompt
  const { scriptDna, psychology, iterationRules } = winAnalysis || {};
  const analysisFormatted = [];
  if (scriptDna) {
    analysisFormatted.push(`SCRIPT DNA:
- Core Angle: ${scriptDna.core_angle || 'N/A'}
- Primary Emotion: ${scriptDna.primary_emotion || 'N/A'}
- Mechanism: ${scriptDna.mechanism || 'N/A'}
- Belief Shift: ${scriptDna.belief_shift || 'N/A'}
- Awareness Level: ${scriptDna.audience_awareness_level || 'N/A'}
- Why It Works: ${scriptDna.why_it_works || 'N/A'}
- What Would Break It: ${scriptDna.what_would_break_it || 'N/A'}`);
  }
  if (psychology) {
    if (psychology.emotional_arc) {
      const ea = psychology.emotional_arc;
      analysisFormatted.push(`EMOTIONAL ARC: ${ea.at_hook || '?'} → ${ea.after_problem || '?'} → ${ea.during_explanation || '?'} → ${ea.at_proof || '?'} → ${ea.before_cta || '?'} → ${ea.final_state || '?'}`);
    }
    if (psychology.hooks?.length) {
      analysisFormatted.push(`HOOK ANALYSIS:\n${psychology.hooks.map(h => `- "${h.text?.slice(0, 60)}..." — ${h.hook_type}, strength ${h.strength}/10, stops scroll because: ${h.scroll_stop_mechanism}`).join('\n')}`);
    }
    if (psychology.audience) {
      analysisFormatted.push(`AUDIENCE: ${psychology.audience.who_is_this_for || 'N/A'} — Awareness: ${psychology.audience.awareness_stage || 'N/A'}`);
    }
  }
  if (iterationRules) {
    analysisFormatted.push(`ITERATION BOUNDARIES:
MUST STAY FIXED: ${(iterationRules.must_stay_fixed || []).join('; ')}
CAN VARY: ${(iterationRules.can_be_varied || []).join('; ')}
HIGH-RISK (AVOID): ${(iterationRules.high_risk_changes || []).join('; ')}
SAFE DIRECTIONS: ${(iterationRules.safe_iteration_directions || []).join('; ')}`);
  }

  const user = `DEEP ANALYSIS:
${analysisFormatted.join('\n\n')}

ORIGINAL SCRIPT:
Hooks:
${hooksFormatted}

Body:
${parsedScript.body || '(no body)'}

ITERATION CONFIG:
- Mode: ${config.mode || 'hook_body'}
- Aggressiveness: ${config.aggressiveness || 'medium'}
- Number of variations: ${config.num_variations || 3}
- Fixed elements: ${fixedElements}
- Elements that can change: ${changeableElements}

PRODUCT CONTEXT:
${productContext}

Based on the analysis, propose exactly ${config.num_variations || 3} distinct iteration directions.

Each direction must:
1. Preserve the winning elements marked as "fixed"
2. Introduce a SPECIFIC, NAMED change (not vague like "try different hook")
3. Explain WHY this variation could outperform
4. Rate expected lift potential (low/medium/high)
5. Rate risk level (safe/moderate/bold)

ITERATION MODE RULES:
- hook_only: ONLY change hooks. Body stays identical.
- hook_body: Change hooks AND modify body. Keep same structure.
- full_reinterpretation: Rewrite everything. Keep same angle and core mechanism.
- angle_expansion: Keep the winning mechanism but apply it through a different angle.
- competitor_reframing: Keep the structure but change the enemy/villain.

AGGRESSIVENESS RULES:
- conservative: Minimal changes. Safe bets. Change 1-2 words in hooks, keep body 90%+ same.
- medium: Moderate changes. New hooks, body adjustments. Stay within proven patterns.
- aggressive: Bold moves. New hook mechanisms, restructured body, stronger claims.
- extreme: Maximum divergence. Completely new hooks, different emotional driver, shock value.

Return ONLY valid JSON:
{
  "directions": [
    {
      "id": 1,
      "name": "Fear Amplification",
      "description": "Intensify the scam-fear angle by opening with a specific victim story",
      "what_changes": "New H1 uses victim testimonial hook. H2 uses data-shock. Body adds proof element.",
      "what_stays": "Blockchain verification proof. Side-by-side comparison. CTA logic.",
      "why_it_could_win": "Victim stories have 2.3x higher hook rates in crypto niche",
      "expected_lift": "medium",
      "risk": "safe",
      "hook_direction": "Open with 'My neighbor bought a $30 Bitcoin miner. Here's what happened.'",
      "body_direction": "Same proof sequence but add victim context before the comparison",
      "emotional_shift": "fear → empathy → fear → solution"
    }
  ]
}`;

  return { system, user };
}

// ---------------------------------------------------------------------------
// 1:1 SCRIPT CLONE — Dedicated prompt for cloning competitor scripts
// ---------------------------------------------------------------------------

async function buildScriptClonePrompt(parsedScript, deepAnalysis, productContext) {
  const originalHooks = (parsedScript.hooks || [])
    .map(h => `${h.id}: ${h.text}`)
    .join('\n');

  const { scriptDna, psychology, iterationRules } = deepAnalysis || {};

  // Build the section-by-section breakdown from DNA
  let sectionFlow = '';
  if (scriptDna?.structural_skeleton?.section_by_section?.length) {
    sectionFlow = scriptDna.structural_skeleton.section_by_section
      .map((s, i) => `  ${i + 1}. ${s}`)
      .join('\n');
  }

  let rhetoricalDevices = '';
  if (scriptDna?.structural_skeleton?.rhetorical_devices?.length) {
    rhetoricalDevices = scriptDna.structural_skeleton.rhetorical_devices.join(', ');
  }

  let hookFramework = scriptDna?.structural_skeleton?.hook_framework || '';
  let pacingRhythm = scriptDna?.structural_skeleton?.pacing_rhythm || '';
  let signaturePhrases = '';
  if (scriptDna?.structural_skeleton?.signature_phrases?.length) {
    signaturePhrases = scriptDna.structural_skeleton.signature_phrases.join(' | ');
  }

  // Emotional arc
  let emotionalArc = '';
  if (psychology?.emotional_arc) {
    const ea = psychology.emotional_arc;
    emotionalArc = `${ea.at_hook || '?'} → ${ea.after_problem || '?'} → ${ea.during_explanation || '?'} → ${ea.at_proof || '?'} → ${ea.before_cta || '?'} → ${ea.final_state || '?'}`;
  }

  // Audience info
  let audienceContext = '';
  if (psychology?.audience) {
    const aud = psychology.audience;
    audienceContext = [
      aud.who_is_this_for ? `Who: ${aud.who_is_this_for}` : '',
      aud.existing_beliefs ? `Beliefs: ${aud.existing_beliefs}` : '',
      aud.awareness_stage ? `Awareness: ${aud.awareness_stage}` : '',
      aud.skepticism_level ? `Skepticism: ${aud.skepticism_level}` : '',
    ].filter(Boolean).join('\n');
  }

  const system = `You are an expert direct-response copywriter and creative strategist specializing in Facebook UGC-style video ad scripts. You adapt proven script structures from high-converting reference ads into new product categories while preserving the exact beat sequence of the original.

Your job is NOT to write new ads. Your job is to CLONE a proven ad script and adapt it for a different product. Preserve every structural and psychological element that makes the original convert.

You think like a performance creative strategist: winning ads work because of their STRUCTURE, PACING, EMOTIONAL FLOW, and FRAMEWORK. Not because of the specific product they sell. A winning format can be transplanted to any product if the adaptation is done with surgical precision.

WRITING RULES:
- You write like a real human speaking to camera. Warm, conversational, honest tone.
- You NEVER sound like ChatGPT or a marketing agency. No filler phrases, no corporate jargon, no "imagine a world where", no "in today's fast-paced world"
- You match the voice and energy of the original script exactly
- Short punchy sentences when the original uses them. Long flowing paragraphs when the original uses those
- You use the same level of aggression, the same register, the same "feel" as the original
- You NEVER add disclaimers, hedging language, or soften the copy unless the original does the same

FORMATTING RULES:
- Never use em dashes (—) or hyphens (-) inside any copy. Use periods, line breaks, or rewrite sentence structure instead.
- All pricing in USD
- Never directly promise the viewer will win or earn money
- Use distanced framing for all performance claims (e.g. "someone in the mining community", "results seen in the community")
- Never attribute wins to a named customer or client of the product
- Never invent product claims not supported by the product profile
- No discount codes in the script unless the product profile includes one
- End cleanly at the product URL with no additional copy after it`;

  const user = `# YOUR MISSION

Adapt the following reference script into a new Facebook UGC-style video ad script for our product. Preserve the exact beat structure of the reference script beat by beat. Do not summarize or compress beats. Every beat in the reference must appear in the output in the same order.

Replace the reference product's narrative, mechanism, and proof points with those of our product. Keep the tone conversational, warm, and direct. Write as if a real person is speaking to camera.

When analyzing the reference script, extract only its emotional and structural logic. Ignore any category-specific framing, product type, or industry context. The goal is to transplant the persuasion architecture, not the subject matter. Always find the emotional function of each beat first, then express it through our product.

# WHAT "1:1 CLONE" MEANS

A 1:1 clone is NOT:
- A summary of the original
- An "inspired by" rewrite
- A generic ad using similar themes

A 1:1 clone IS:
- The SAME number of sections in the SAME order
- The SAME rhetorical devices at the SAME structural points
- The SAME emotional beats hitting at the SAME moments
- The SAME pacing and rhythm
- The SAME hook framework
- The SAME word count (±10% tolerance)
- Every sentence maps to a sentence in the clone that serves the IDENTICAL PURPOSE

The ONLY things that change:
- Product name, features, and specific claims → swapped to OUR product
- Competitor-specific details → replaced with equivalent details for our product
- Exact phrasing → rephrased to avoid plagiarism (but same point, same energy, same purpose)

# OUR PRODUCT — USE THIS CONTEXT TO ADAPT ALL PRODUCT REFERENCES
${productContext}

# ═══════════════════════════════════════════════════════════
# ORIGINAL REFERENCE SCRIPT (THIS IS WHAT YOU ARE CLONING)
# ═══════════════════════════════════════════════════════════

## HOOKS (from the original):
${originalHooks}

## BODY (from the original):
${parsedScript.body || '(no body parsed)'}

## CTA (from the original):
${parsedScript.cta || '(no CTA parsed)'}

## FORMAT NOTES:
${parsedScript.format_notes || 'N/A'}

# ═══════════════════════════════════════════════════════════
# DEEP ANALYSIS OF THE ORIGINAL (from 3 specialist agents)
# ═══════════════════════════════════════════════════════════

## SCRIPT DNA
- Core Angle: ${scriptDna?.core_angle || 'N/A'}
- Primary Emotion: ${scriptDna?.primary_emotion || 'N/A'}
- Secondary Emotions: ${Array.isArray(scriptDna?.secondary_emotions) ? scriptDna.secondary_emotions.join(', ') : scriptDna?.secondary_emotions || 'N/A'}
- Belief Shift: ${scriptDna?.belief_shift || 'N/A'}
- Problem: ${scriptDna?.problem_presented || scriptDna?.problem || 'N/A'}
- Solution: ${scriptDna?.solution_presented || scriptDna?.solution || 'N/A'}
- Mechanism: ${scriptDna?.mechanism || 'N/A'}
- Proof Type: ${scriptDna?.proof_type || 'N/A'}
- Awareness Level: ${scriptDna?.audience_awareness_level || 'N/A'}
- Why It Works: ${scriptDna?.why_it_works || 'N/A'}
- What Would Break It: ${scriptDna?.what_would_break_it || 'N/A'}

## STRUCTURAL SKELETON — YOUR CLONE MUST MATCH THIS EXACTLY
- Hook Framework: ${hookFramework || 'N/A'}
- Rhetorical Devices: ${rhetoricalDevices || 'N/A'}
- Pacing/Rhythm: ${pacingRhythm || 'N/A'}
- Signature Patterns (use EQUIVALENT patterns for our product): ${signaturePhrases || 'N/A'}

Section-by-Section Flow (YOUR CLONE MUST FOLLOW THIS EXACT SEQUENCE):
${sectionFlow || '  (no section breakdown available — mirror the original body paragraph by paragraph)'}

## EMOTIONAL ARC — YOUR CLONE MUST HIT THESE SAME BEATS
${emotionalArc || 'Mirror the emotional flow of the original'}

## AUDIENCE PROFILE
${audienceContext || 'Same audience as the original — adapt product references only'}

## HOOK ANALYSIS
${psychology?.hooks?.length ? psychology.hooks.map(h => `- "${h.text || ''}": ${h.hook_type || ''} — ${h.why_it_works || ''}`).join('\n') : (psychology?.hook_analysis?.length ? psychology.hook_analysis.map(h => `- "${h.exact_text || h.text || ''}": ${h.type || ''} — ${h.why_it_works || ''}`).join('\n') : 'N/A')}

# ═══════════════════════════════════════════════════════════
# BEAT STRUCTURE PRESERVATION (MOST CRITICAL INSTRUCTION)
# ═══════════════════════════════════════════════════════════

Before writing the script, silently read the full reference script and identify each distinct beat. Number them internally. For each beat, identify its emotional function first. Ask: what is this beat doing for the viewer? Is it creating tension, relieving tension, building credibility, lowering resistance, or driving action?

Then express that same emotional function through our product. Do not merge beats. Do not skip beats. Do not add beats that are not present in the reference. The output must have the same number of beats as the reference in the same sequence.

If a beat from the reference has no direct equivalent for our product, do not invent a claim. Find the closest truthful emotional equivalent and note the substitution in the beat mapping.

# ═══════════════════════════════════════════════════════════
# CLONE EXECUTION RULES
# ═══════════════════════════════════════════════════════════

## RULE 1: BEAT-BY-BEAT BODY MAPPING
- Read the original body. Count every distinct beat/paragraph/section.
- Your clone MUST have the same number of beats in the same order.
- For each beat in the original, write a corresponding beat that:
  → Serves the SAME emotional function
  → Uses the SAME rhetorical device (if any)
  → Hits the SAME emotional note
  → Is roughly the SAME length (±15% words)
  → Sits in the SAME position in the script

## RULE 2: HOOK CLONING WITH PERSPECTIVE LOCK
- Generate exactly 3 hooks.
- All 3 hooks MUST use the SAME FRAMEWORK as the original hooks.
- If original hooks are confession/apology → your hooks are confession/apology about OUR product
- If original hooks are shocking stat → your hooks are shocking stat about OUR product
- H1: Closest energy match to the original's strongest hook. Tightest clone.
- H2: Same framework, slightly different angle of entry.
- H3: Same framework, different emotional texture.

PERSPECTIVE LOCK: Read the body script. Identify who is being spoken to and who is being spoken about. Every hook must use the exact same perspective, pronouns, and speaker frame as the first sentence of the body. If the body says "he'll have" and "he just plugs it in", the hook must speak to a second person about a third person. Never write a first-person hook if the body is in second person. Never write a self-buyer hook if the body is a gift-buyer script.

TENSION MATCH: The hook must create a tension, curiosity, or emotion that the first sentence of the body directly resolves. Read the first sentence of the body. Ask: what question or feeling does this sentence satisfy? Write the hook to create exactly that question or feeling.

ZERO BRIDGE NEEDED: After the hook plays, the first sentence of the body must be the natural next thing to say. There must be no gap, no gear shift, no tonal mismatch. Test each hook by reading it aloud followed immediately by the first sentence of the body. If it feels like two separate ads stitched together, rewrite it.

ANGLE VARIETY: Each hook must use a meaningfully different angle. Do not write two hooks using the same angle. Surface-level rewords of the same idea are not acceptable.

SCROLL STOP: The first two to four words of every hook must create an immediate reason to stop scrolling. Use a number, a direct address, a surprising claim, or a specific relatable scenario. Never open with a filler word, a generic greeting, or a weak setup.

PRODUCT SPECIFICITY: Every hook MUST reference at least one concrete product detail from the PRODUCT CONTEXT — the product name, a specific price point, the unique mechanism, a key benefit, or the discount code. A hook that could apply to any product is a failed hook. Hooks like "This product changed everything" or "You need to see this" are BANNED. Be as specific as the original hooks are about THEIR product, but about OUR product.

## RULE 3: PRODUCT SWAP PROTOCOL
- Every mention of the competitor's product → replace with our product name and details
- Every competitor benefit claim → find the EQUIVALENT benefit from our product profile and swap
- Every competitor-specific proof point → replace with equivalent proof from our product
- Every competitor price/offer → replace with our price/offer
- If no equivalent exists, use the closest relevant feature that serves the same persuasive purpose
- NEVER leave competitor references in the final script
- NEVER invent claims not supported by the product profile

## RULE 4: TONE LOCK
- Read the original script out loud in your mind. Note the energy.
- Your clone MUST match that exact energy.
- If the original uses slang → use slang
- If the original uses data → use data
- If the original is raw and emotional → be raw and emotional
- If the original is measured and authoritative → be measured and authoritative
- NEVER default to "marketing copy" voice. NEVER.

## RULE 5: LENGTH CONTROL
- Count the words in the original body.
- Your clone body must be within ±10% of that word count.
- This is a HARD CONSTRAINT. Do not write a 200-word clone of a 500-word script.

## RULE 6: ANTI-AI DETECTION
- No sentences starting with "Imagine...", "Picture this...", "In a world where...", "What if I told you..."
- No filler transitions: "But here's the thing", "Now here's where it gets interesting", "And that's not all"
- No listicle formatting unless the original uses it
- No over-explaining. If the original makes a bold claim and moves on, you make a bold claim and move on.
- Use contractions: "don't", "can't", "won't", "it's", "that's", "here's"
- Use sentence fragments where the original does
- Never use em dashes (—) or hyphens (-) inside any copy
- Write like you're talking to ONE person, not an audience

## RULE 7: CTA CLONING
- Match the CTA structure of the original
- Swap product/link references to ours
- End cleanly at the product URL with no additional copy after it

## RULE 8: COMPLIANCE
- Never directly promise the viewer will win or earn money
- Use distanced framing for all performance claims
- Never attribute wins to a named customer or client of the product
- All pricing in USD
- Never invent product claims not present in the product profile

# ═══════════════════════════════════════════════════════════
# OUTPUT FORMAT
# ═══════════════════════════════════════════════════════════

Return ONLY valid JSON, no markdown fences, no explanation:
{
  "hooks": [
    {
      "id": "H1",
      "text": "the hook text. Closest clone of the original's strongest hook.",
      "framework_used": "confession/pain/contrarian/etc. Must match original.",
      "maps_to_original": "which original hook this clones",
      "scroll_stop_reason": "why the first words stop the scroll",
      "perspective_check": "confirms pronoun/speaker frame matches body opener"
    },
    {
      "id": "H2",
      "text": "second hook. Same framework, different entry angle.",
      "framework_used": "same framework as H1",
      "maps_to_original": "which original hook this clones",
      "scroll_stop_reason": "why the first words stop the scroll",
      "perspective_check": "confirms pronoun/speaker frame matches body opener"
    },
    {
      "id": "H3",
      "text": "third hook. Same framework, different emotional texture.",
      "framework_used": "same framework as H1",
      "maps_to_original": "which original hook this clones",
      "scroll_stop_reason": "why the first words stop the scroll",
      "perspective_check": "confirms pronoun/speaker frame matches body opener"
    }
  ],
  "body": "the full cloned body script. Must have same number of beats as original. Each beat maps 1:1. Use natural paragraph breaks (double newlines). No markdown formatting. No em dashes or hyphens.",
  "cta": "the cloned call-to-action",
  "word_count": 0,
  "estimated_seconds": 0,
  "clone_fidelity": {
    "original_word_count": 0,
    "clone_word_count": 0,
    "original_sections": 0,
    "clone_sections": 0,
    "framework_match": "what framework was preserved",
    "product_swaps_made": "brief list of what product references were changed"
  },
  "beat_mapping": [
    {"beat": 1, "original": "what the original beat was", "clone": "what your clone beat is", "emotional_function": "what this beat does for the viewer", "substitution_note": "if any substitution was made and why, or null"}
  ],
  "key_adaptations": "2-3 sentences explaining what product-specific changes were made and why",
  "emotional_arc": "hook_emotion → middle_emotion → close_emotion (must match original arc)"
}`;

  // Check for custom prompt overrides from settings
  try {
    const custom = await getCustomPrompts();
    if (custom?.scriptClone) {
      if (custom.scriptClone.system) return { system: custom.scriptClone.system, user };
      if (custom.scriptClone.user) return { system, user: custom.scriptClone.user };
    }
  } catch (customErr) {
    console.warn('[BriefPipeline] Custom prompt load error:', customErr.message);
  }

  return { system, user };
}

// ---------------------------------------------------------------------------
// VARIANT GENERATOR — For generating creative variations (non-clone mode)
// ---------------------------------------------------------------------------

async function buildBriefGeneratorPrompt(parsedScript, deepAnalysis, direction, config, productContext) {
  const originalHooks = (parsedScript.hooks || [])
    .map(h => `${h.id}: ${h.text}`)
    .join('\n');

  // Build analysis context from the 3-agent results
  const { scriptDna, psychology, iterationRules } = deepAnalysis || {};
  const analysisLines = [];
  if (scriptDna) {
    analysisLines.push(`SCRIPT DNA:
- Core Angle: ${scriptDna.core_angle || 'N/A'}
- Primary Emotion: ${scriptDna.primary_emotion || 'N/A'}
- Belief Shift: ${scriptDna.belief_shift || 'N/A'}
- Mechanism: ${scriptDna.mechanism || 'N/A'}
- Awareness Level: ${scriptDna.audience_awareness_level || 'N/A'}
- Why It Works: ${scriptDna.why_it_works || 'N/A'}
- What Would Break It: ${scriptDna.what_would_break_it || 'N/A'}`);

    // Add structural skeleton — this is the most critical part for iteration fidelity
    if (scriptDna.structural_skeleton) {
      const sk = scriptDna.structural_skeleton;
      const skLines = [`STRUCTURAL SKELETON (YOUR ITERATION MUST FOLLOW THIS EXACT FRAMEWORK):`];
      if (sk.hook_framework) skLines.push(`Hook Framework: ${sk.hook_framework}`);
      if (sk.rhetorical_devices?.length) skLines.push(`Rhetorical Devices: ${sk.rhetorical_devices.join(' | ')}`);
      if (sk.section_by_section?.length) skLines.push(`Section Flow:\n  ${sk.section_by_section.map((s, i) => `${i + 1}. ${s}`).join('\n  ')}`);
      if (sk.signature_phrases?.length) skLines.push(`Signature Patterns (use equivalent patterns, NOT these exact words): ${sk.signature_phrases.join(' | ')}`);
      if (sk.pacing_rhythm) skLines.push(`Pacing: ${sk.pacing_rhythm}`);
      analysisLines.push(skLines.join('\n'));
    }
  }
  if (psychology?.emotional_arc) {
    const ea = psychology.emotional_arc;
    analysisLines.push(`EMOTIONAL ARC: ${ea.at_hook} → ${ea.after_problem} → ${ea.during_explanation} → ${ea.at_proof} → ${ea.before_cta} → ${ea.final_state}`);
  }
  if (iterationRules) {
    if (iterationRules.must_stay_fixed?.length) analysisLines.push(`MUST STAY FIXED:\n- ${iterationRules.must_stay_fixed.join('\n- ')}`);
    if (iterationRules.can_be_varied?.length) analysisLines.push(`CAN BE VARIED:\n- ${iterationRules.can_be_varied.join('\n- ')}`);
    if (iterationRules.high_risk_changes?.length) analysisLines.push(`HIGH-RISK (AVOID):\n- ${iterationRules.high_risk_changes.join('\n- ')}`);
    if (iterationRules.tone_boundaries) {
      analysisLines.push(`TONE: ${iterationRules.tone_boundaries.current_register || 'N/A'} — Range: ${iterationRules.tone_boundaries.acceptable_range || 'N/A'} — Never: ${iterationRules.tone_boundaries.never_do || 'N/A'}`);
    }
    if (iterationRules.hook_rules) {
      analysisLines.push(`HOOK RULES: Preserve: ${iterationRules.hook_rules.must_preserve || 'N/A'} | Avoid: ${iterationRules.hook_rules.avoid || 'N/A'}`);
    }
    if (iterationRules.compliance_notes) analysisLines.push(`COMPLIANCE: ${iterationRules.compliance_notes}`);
  }
  const analysisContext = analysisLines.length ? analysisLines.join('\n\n') : '';

  let system = `You are a senior direct-response copywriter who has spent $10M+ on Facebook and TikTok ads. You write ad copy that converts cold traffic — punchy, specific, emotionally loaded.

You generate variations of proven winners while preserving their psychological mechanism and conversion logic.

ABSOLUTE RULES FOR YOUR WRITING STYLE:
- Write like you're talking to ONE person, not an audience
- Every sentence must earn its place — cut anything that doesn't create desire, urgency, or curiosity
- Be SPECIFIC: "Save $47/month" not "save money". "Lost 23lbs in 6 weeks" not "achieve your goals". Always use the actual product name, price, mechanism, and benefits from the product context — NEVER write generic copy that could apply to any product
- NEVER use these AI-sounding words/phrases: "game-changer", "revolutionary", "cutting-edge", "seamless", "elevate", "unlock", "transform your", "discover the", "experience the", "take your X to the next level", "say goodbye to", "the future of"
- If it sounds like a LinkedIn post or a corporate press release, REWRITE IT
- Match the raw energy of the original — if the original is aggressive and bold, be equally aggressive and bold`;

  let user = `# OBJECTIVE

Generate a high-quality iteration of a winning ad script.

This iteration must:
- Preserve the original angle and mechanism
- Follow the same narrative flow
- Maintain the same emotional journey
- Use completely new wording, phrasing, and sentence structures
- The 3 hooks must blend PERFECTLY with the body — each hook must flow naturally into the body as if they were written together

The goal is to create a variation that feels fresh while behaving identically in terms of conversion.

# PRODUCT CONTEXT
${productContext}

# ORIGINAL WINNING SCRIPT
Hooks:
${originalHooks}

Body:
${parsedScript.body || '(no body)'}

# DEEP ANALYSIS
${analysisContext}

# ITERATION DIRECTION
${direction.description}
- What changes: ${direction.what_changes}
- What stays: ${direction.what_stays}
- Hook direction: ${direction.hook_direction}
- Body direction: ${direction.body_direction}
- Emotional shift: ${direction.emotional_shift}

# ITERATION RULES

## STRUCTURAL SKELETON PRESERVATION (MOST IMPORTANT RULE)
- The STRUCTURAL SKELETON section above describes the exact rhetorical framework of the original.
- Your iteration MUST follow the SAME section-by-section flow as the original.
- If the original uses a confession/apology hook framework, your hooks MUST also use confession/apology.
- If the original uses repetition patterns (e.g. "Yes, it's true that..."), your iteration MUST use an equivalent repetition pattern — different words, SAME device.
- If the original has a twist/reveal moment, your iteration MUST have a twist/reveal at the same structural point.
- If the original uses competitor callouts, your iteration MUST include competitor callouts.
- Every rhetorical device listed in the skeleton must appear in your iteration. You can rephrase it, but you CANNOT remove it.
- The section flow must match: if the original goes Apology → Validation → Proof → Twist → Urgency, your iteration must go through those same stages in that order.

## Angle & Narrative Preservation
- Keep the exact same core angle
- Do NOT introduce new selling points or mechanisms
- Do NOT change the story structure
- Do NOT remove any persuasive step
- Maintain the same emotional progression
- AWARENESS LEVEL LOCK: Target the same market awareness stage as the original

## Hook Generation — REPHRASE the original hooks, don't invent new ones
- Generate 3 hooks that are VARIATIONS of the original hooks — same framework, same emotional trigger, different words
- Look at the original hooks above. Your 3 hooks must achieve the EXACT SAME THING those hooks achieve.
- If the original hooks use confession/apology ("I need to apologize", "I lied"), your hooks MUST also use confession/apology. Not curiosity. Not pain. Not contrarian. Confession/apology.
- Each hook is a REPHRASING of the original hook concept — not a new concept
- H1 = closest to original hook energy, strongest version
- H2 = same framework, slightly different angle
- H3 = same framework, different entry point but same emotional trigger
- Each hook must BLEND PERFECTLY with the body — reading hook + body must feel like one continuous script
- Do NOT reuse exact phrases from original hooks
- The hook framework is NON-NEGOTIABLE. If the original says "I apologize because I lied", your hooks must also be about apologizing/confessing/admitting something — NOT about lottery comparisons, NOT about product features, NOT about warnings.
- HOOKS MUST BE PRODUCT-SPECIFIC: Reference specific product details (name, price points, unique mechanism, key benefits) from the PRODUCT CONTEXT above. A hook like "This changed everything" is BANNED — it must be specific like referencing the actual product, its price, a specific benefit, or a concrete claim. Generic hooks fail. Specific hooks convert.

## Body Generation — SECTION-BY-SECTION REPHRASING (NOT rewriting)
- Go through the original body paragraph by paragraph, section by section
- For EACH section of the original, write the EQUIVALENT section in your iteration
- Same point. Same purpose. Same position in the script. Different words.
- If the original body has 8 paragraphs, your iteration must have ~8 paragraphs making the same points in the same order
- Do NOT add new sections that aren't in the original
- Do NOT remove sections that are in the original
- Do NOT rearrange the order of sections
- Do NOT introduce new angles, comparisons, or narratives that weren't in the original
- The iteration body should feel like the SAME PERSON saying the SAME THINGS in a SLIGHTLY DIFFERENT WAY — not a different person writing a different script
- Think of it like re-recording the same speech with different word choices, not writing a new speech

## Style & Tone
- Match the tone of the original (direct, conversational, persuasive)
- Avoid robotic or "clean marketing" language
- Write like a human speaking to one person
- Keep rhythm natural and engaging

# HARD CONSTRAINTS
- Do NOT introduce new claims not supported by the product profile
- Do NOT change product positioning
- Do NOT simplify to the point of losing persuasion
- Do NOT generate generic or bland copy
- Be aggressive and direct to consumer — the goal is to convert cold traffic
- If iteration rules specify "must stay fixed" items, treat them as absolute constraints
- If iteration rules specify "high-risk changes", treat them as forbidden
- If compliance restrictions exist, respect them absolutely

Return ONLY valid JSON:
{
  "hooks": [
    {
      "id": "H1",
      "text": "the hook text",
      "mechanism": "curiosity/pain/contrarian",
      "scroll_stop_reason": "why someone stops"
    },
    {
      "id": "H2",
      "text": "...",
      "mechanism": "...",
      "scroll_stop_reason": "..."
    },
    {
      "id": "H3",
      "text": "...",
      "mechanism": "...",
      "scroll_stop_reason": "..."
    }
  ],
  "body": "the full body script with natural paragraph breaks",
  "cta": "the call-to-action text",
  "word_count": number,
  "estimated_seconds": number,
  "key_changes_from_original": "2-3 sentence summary of what changed and why",
  "emotional_arc": "hook_emotion → middle_emotion → close_emotion"
}`;

  // Check for custom prompt overrides
  try {
    const custom = await getCustomPrompts();
    if (custom?.generator) {
      if (custom.generator.system) system = custom.generator.system;
      if (custom.generator.user) user = custom.generator.user;
    }
  } catch (customErr) {
    console.warn('[BriefPipeline] Custom prompt load error:', customErr.message);
  }

  return { system, user };
}

async function buildBriefScorerPrompt(winner, parsedScript, generatedBrief, directionName, deepAnalysis, productContext) {
  const originalHooks = (parsedScript.hooks || [])
    .map(h => `${h.id}: ${h.text}`)
    .join('\n');

  const generatedHooks = (generatedBrief.hooks || [])
    .map((h, i) => `${h.id || `H${i + 1}`}: ${h.text || '(empty)'}`)
    .join('\n');

  // Build iteration rules context for scoring
  const rules = deepAnalysis?.iterationRules;
  const rulesContext = rules ? `
ITERATION RULES TO EVALUATE AGAINST:
- Must stay fixed: ${(rules.must_stay_fixed || []).join('; ')}
- High-risk changes (should NOT have been made): ${(rules.high_risk_changes || []).join('; ')}
- Tone boundary: ${rules.tone_boundaries?.current_register || 'N/A'} (acceptable range: ${rules.tone_boundaries?.acceptable_range || 'N/A'})
- Compliance: ${rules.compliance_notes || 'None'}` : '';

  let system = `You are a performance media buyer who has spent $50M+ on paid social. You evaluate ad scripts purely on their likelihood to convert cold traffic. You are ruthlessly honest — most scripts are mediocre.`;

  let user = `PRODUCT CONTEXT:
${productContext}

ORIGINAL WINNING SCRIPT (baseline):
Hooks:
${originalHooks}

Body:
${parsedScript.body || '(no body)'}

ORIGINAL PERFORMANCE:
- ROAS: ${winner.roas}x
- CPA: $${winner.cpa}
- CTR: ${winner.ctr}%
${rulesContext}

GENERATED BRIEF:
Hooks:
${generatedHooks}

Body:
${generatedBrief.body || '(no body)'}

ITERATION DIRECTION: ${directionName}

Score this brief on 5 dimensions (1-10 scale):

1. NOVELTY (1-10): How different is this from the original?
   - 1 = basically the same script / synonym swaps
   - 5 = recognizably related but distinct
   - 10 = completely fresh take

2. AGGRESSION (1-10): How bold are the claims and hooks?
   - 1 = timid, corporate
   - 5 = standard DTC aggressive
   - 10 = maximum scroll-stop, borderline shocking

3. COHERENCE (1-10): Does the script flow? Is the logic chain tight?
   - 1 = disjointed, confusing
   - 5 = acceptable flow
   - 10 = seamless, every sentence earns the next

4. HOOK-BODY BLEND (1-10): Do ALL 3 hooks flow naturally into the body?
   - Read each hook followed immediately by the body's first sentence.
   - 1 = jarring disconnect, different voice/topic
   - 5 = acceptable transition
   - 10 = perfectly seamless, sounds like one person talking

5. CONVERSION POTENTIAL (1-10): Will this actually convert cold traffic?
   - 1 = waste of ad spend
   - 5 = will perform equal to original
   - 10 = likely to significantly outperform

Also check:
- Did the iteration respect the "must stay fixed" elements? Flag any violations.
- Did it make any "high-risk changes"? Flag them.
- Are all product claims accurate per the product context?
- Does it maintain the same market awareness level as the original?

Return ONLY valid JSON:
{
  "novelty": { "score": 7, "reason": "one sentence" },
  "aggression": { "score": 8, "reason": "one sentence" },
  "coherence": { "score": 6, "reason": "one sentence" },
  "hook_body_blend": { "score": 8, "reason": "one sentence" },
  "conversion_potential": { "score": 7, "reason": "one sentence" },
  "overall": 7.0,
  "verdict": "SHIP" | "MAYBE" | "KILL",
  "rule_violations": ["list any iteration rule violations, or empty array if none"],
  "one_line_feedback": "what's strong and what's weak in one sentence",
  "suggested_improvement": "optional one-sentence fix if verdict is MAYBE"
}`;

  // Check for custom prompt overrides
  try {
    const custom = await getCustomPrompts();
    if (custom?.scorer) {
      if (custom.scorer.system) system = custom.scorer.system;
      if (custom.scorer.user) user = custom.scorer.user;
    }
  } catch (customErr) {
    console.warn('[BriefPipeline] Custom prompt load error:', customErr.message);
  }

  return { system, user };
}

// ── Hook-Body Blend Validation Agent ─────────────────────────────────
async function buildBlendValidationPrompt(generatedBrief) {
  const hooks = (generatedBrief.hooks || []).map(h => h.text).filter(Boolean);
  const body = generatedBrief.body || '';
  const bodyFirstLine = body.split('\n').find(l => l.trim().length > 10) || body.slice(0, 200);

  let system = `You are a continuity editor for direct response ad scripts. Your ONLY job is to check if hooks flow naturally into the body.`;

  let user = `Read each hook below, then immediately read the body's opening. Judge if they sound like one continuous script written by the same person.

${hooks.map((h, i) => `HOOK ${i + 1}: "${h}"
→ BODY STARTS: "${bodyFirstLine}"`).join('\n\n')}

For each hook, return:
- blend_score (1-10): 1 = jarring disconnect, 10 = perfectly seamless
- issue: null if score >= 7, otherwise describe the disconnect in one sentence
- fix_suggestion: null if score >= 7, otherwise suggest a one-sentence fix

Return ONLY valid JSON:
{
  "hooks": [
    { "id": 1, "blend_score": 8, "issue": null, "fix_suggestion": null },
    { "id": 2, "blend_score": 5, "issue": "Hook uses casual UGC tone but body opens with authoritative data", "fix_suggestion": "Soften the body's opening to match the casual hook tone" },
    { "id": 3, "blend_score": 9, "issue": null, "fix_suggestion": null }
  ],
  "overall_blend": 7.3,
  "pass": true
}

A brief PASSES if overall_blend >= 6.5.`;

  // Check for custom prompt overrides
  try {
    const custom = await getCustomPrompts();
    if (custom?.blendValidator) {
      if (custom.blendValidator.system) system = custom.blendValidator.system;
      if (custom.blendValidator.user) user = custom.blendValidator.user;
    }
  } catch (customErr) {
    console.warn('[BriefPipeline] Custom prompt load error:', customErr.message);
  }

  return { system, user };
}

// ── Push to ClickUp ───────────────────────────────────────────────────

async function pushBriefToClickUp(generatedBrief, parentClickupTaskId) {
  const {
    brief_number, product_code, angle, format, avatar,
    editor, strategist, creator, parent_creative_id, hooks, body, naming_convention, iteration_direction,
  } = generatedBrief;

  const weekLabel = getCurrentWeekLabel();
  const namingConvention = naming_convention || buildNamingConvention({
    product_code, brief_number, parent_creative_id, avatar, angle, format,
    strategist, creator, editor, week: weekLabel,
  });

  // Fetch parent ad's Frame.io link from ClickUp
  let referenceLink = '';
  if (parentClickupTaskId) {
    try {
      const parentTask = await clickupFetch(`/task/${parentClickupTaskId}`);
      const frameField = parentTask.custom_fields?.find(f => f.id === FIELD_IDS.adsFrameLink);
      if (frameField?.value) {
        referenceLink = frameField.value;
      }
    } catch (err) {
      console.warn(`[BriefPipeline] Could not fetch parent Frame link from ${parentClickupTaskId}:`, err.message);
    }
  }

  // Build description with script
  const parsedHooks = (() => {
    if (Array.isArray(hooks)) return hooks;
    if (typeof hooks === 'string') { try { return JSON.parse(hooks); } catch { return []; } }
    return [];
  })();
  const hooksFormatted = parsedHooks
    .map((h, i) => `Hook ${i + 1}:\n${h.text || ''}`.trim())
    .join('\n');

  const referenceLine = referenceLink ? `Reference: ${referenceLink}\n\n` : '';
  const description = `${referenceLine}--- Hooks ---\n\n${hooksFormatted}\n\n--- Body ---\n\n${body || ''}\n\n[brief-pipeline]`;

  // Resolve dropdown option IDs
  const angleUuid = ANGLE_OPTIONS[angle] || ANGLE_OPTIONS.NA;
  const briefTypeUuid = BRIEF_TYPE_OPTIONS.IT;
  const creativeTypeUuid = CREATIVE_TYPE_OPTIONS[format] || CREATIVE_TYPE_OPTIONS.Mashup;

  const editorUserId = USER_IDS[editor] || USER_IDS.Ludovico;

  const customFields = [
    { id: FIELD_IDS.briefNumber, value: brief_number },
    { id: FIELD_IDS.briefType, value: briefTypeUuid },
    { id: FIELD_IDS.parentBriefId, value: parent_creative_id },
    { id: FIELD_IDS.idea, value: iteration_direction || '-' },
    { id: FIELD_IDS.angle, value: angleUuid },
    { id: FIELD_IDS.creativeType, value: creativeTypeUuid },
    { id: FIELD_IDS.namingConvention, value: namingConvention },
    { id: FIELD_IDS.creationWeek, value: weekLabel },
    { id: FIELD_IDS.creativeStrategist, value: { add: [USER_IDS.Ludovico], rem: [] } },
    { id: FIELD_IDS.copywriter, value: { add: [USER_IDS.Ludovico], rem: [] } },
    { id: FIELD_IDS.editor, value: { add: [editorUserId], rem: [] } },
  ].filter(f => f.value != null);

  const taskPayload = {
    name: namingConvention,
    description,
    status: 'edit queue',
    assignees: [editorUserId],
    custom_fields: customFields,
  };

  let createdTask;
  try {
    createdTask = await clickupFetch(
      `/list/${VIDEO_ADS_LIST}/task`,
      { method: 'POST', body: JSON.stringify(taskPayload) }
    );
  } catch (err) {
    // If editor user doesn't have workspace access, retry without user fields
    if (err.message.includes('FIELD_129') || err.message.includes('must have access')) {
      console.warn(`[BriefPipeline] Editor ${editor} (${editorUserId}) not accessible, falling back to Ludovico`);
      const fallbackFields = customFields.map(f => {
        if (f.id === FIELD_IDS.editor) return { ...f, value: { add: [USER_IDS.Ludovico], rem: [] } };
        return f;
      });
      const fallbackPayload = { ...taskPayload, assignees: [USER_IDS.Ludovico], custom_fields: fallbackFields };
      createdTask = await clickupFetch(
        `/list/${VIDEO_ADS_LIST}/task`,
        { method: 'POST', body: JSON.stringify(fallbackPayload) }
      );
    } else {
      throw err;
    }
  }

  const taskId = createdTask.id;

  // Set relationship fields (Product, Avatar, Creator)
  const relationshipPromises = [];

  const productTaskId = PRODUCT_TASK_IDS[product_code] || PRODUCT_TASK_IDS.MR;
  if (productTaskId) {
    relationshipPromises.push(
      clickupFetch(`/task/${taskId}/field/${FIELD_IDS.product}`, {
        method: 'POST',
        body: JSON.stringify({ value: { add: [{ id: productTaskId }], rem: [] } }),
      }).catch(err => console.error('[BriefPipeline] Product relationship error:', err.message))
    );
  }

  const avatarTaskId = AVATAR_TASK_IDS[avatar];
  if (avatarTaskId) {
    relationshipPromises.push(
      clickupFetch(`/task/${taskId}/field/${FIELD_IDS.avatar}`, {
        method: 'POST',
        body: JSON.stringify({ value: { add: [{ id: avatarTaskId }], rem: [] } }),
      }).catch(err => console.error('[BriefPipeline] Avatar relationship error:', err.message))
    );
  }

  relationshipPromises.push(
    clickupFetch(`/task/${taskId}/field/${FIELD_IDS.creator}`, {
      method: 'POST',
      body: JSON.stringify({ value: { add: [{ id: CREATOR_NA_TASK_ID }], rem: [] } }),
    }).catch(err => console.error('[BriefPipeline] Creator relationship error:', err.message))
  );

  await Promise.all(relationshipPromises);

  return {
    taskId,
    taskUrl: createdTask.url || `https://app.clickup.com/t/${taskId}`,
    namingConvention,
  };
}

// ── On-demand Meta thumbnail refresh ──────────────────────────────────
/**
 * Fetch a fresh thumbnail_url from Meta API for a given creative_id (e.g. "B0071").
 * Returns { thumbnail_url, video_url } or null if not found.
 */
async function refreshMetaThumbnail(creativeId) {
  if (!META_ACCESS_TOKEN || META_AD_ACCOUNT_IDS.length === 0) return null;

  for (const accountId of META_AD_ACCOUNT_IDS) {
    try {
      const searchUrl = `${META_GRAPH_URL}/${accountId}/ads?fields=name,creative.fields(thumbnail_url,image_url,video_id).thumbnail_width(720).thumbnail_height(720)&filtering=[{"field":"name","operator":"CONTAIN","value":"${creativeId}"}]&limit=10&access_token=${META_ACCESS_TOKEN}`;
      const resp = await fetch(searchUrl);
      const data = await resp.json();
      if (data.error || !data.data?.length) continue;

      for (const ad of data.data) {
        const thumbUrl = ad.creative?.image_url || ad.creative?.thumbnail_url || null;
        if (!thumbUrl) continue;

        // Also fetch permanent video source if there's a video_id
        let videoUrl = null;
        const videoId = ad.creative?.video_id;
        if (videoId) {
          try {
            const vidResp = await fetch(`${META_GRAPH_URL}/${videoId}?fields=source&access_token=${META_ACCESS_TOKEN}`);
            const vidData = await vidResp.json();
            if (vidData.source) videoUrl = vidData.source;
          } catch (_) { /* ignore */ }
        }

        // Update creative_analysis so other endpoints benefit
        await pgQuery(
          `UPDATE creative_analysis SET thumbnail_url = $1, video_url = COALESCE($2, video_url)
           WHERE creative_id = $3`,
          [thumbUrl, videoUrl, creativeId]
        ).catch(() => {});

        return { thumbnail_url: thumbUrl, video_url: videoUrl };
      }
    } catch (err) {
      console.warn(`[BriefPipeline] Meta thumbnail refresh error for ${accountId}:`, err.message);
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════════

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validateUuid(req, res) {
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ success: false, error: { message: 'Invalid ID format' } });
    return false;
  }
  return true;
}

// GET /winners — list all detected winners
router.get('/winners', authenticate, async (_req, res) => {
  try {
    await ensureTables();
    const rows = await pgQuery(
      `SELECT * FROM brief_pipeline_winners ORDER BY roas DESC, detected_at DESC`
    );

    // Refresh stale thumbnail/video URLs from creative_analysis (Meta CDN URLs expire)
    if (rows.length) {
      const creativeIds = rows.map(r => r.creative_id);
      const freshUrls = await pgQuery(`
        SELECT DISTINCT ON (creative_id) creative_id, thumbnail_url, video_url
        FROM creative_analysis
        WHERE creative_id = ANY($1)
          AND (thumbnail_url IS NOT NULL OR video_url IS NOT NULL)
        ORDER BY creative_id, synced_at DESC
      `, [creativeIds]);

      const urlMap = {};
      for (const r of freshUrls) urlMap[r.creative_id] = r;

      for (const row of rows) {
        const fresh = urlMap[row.creative_id];
        if (fresh) {
          if (fresh.thumbnail_url) row.thumbnail_url = fresh.thumbnail_url;
          if (fresh.video_url) row.video_url = fresh.video_url;
        }
      }

      // On-demand Meta refresh for winners with missing or stale thumbnails
      const staleRows = rows.filter(r =>
        !r.thumbnail_url ||
        (r.thumbnail_url && r.thumbnail_url.includes('fbcdn.net')) ||
        (r.video_url && !r.video_url.includes('.mp4'))
      );
      if (staleRows.length > 0 && META_ACCESS_TOKEN) {
        // Limit concurrent refreshes to avoid rate limiting
        const toRefresh = staleRows.slice(0, 10);
        const refreshPromises = toRefresh.map(async (row) => {
          try {
            const fresh = await refreshMetaThumbnail(row.creative_id);
            if (fresh) {
              if (fresh.thumbnail_url) row.thumbnail_url = fresh.thumbnail_url;
              if (fresh.video_url) row.video_url = fresh.video_url;
              await pgQuery(
                `UPDATE brief_pipeline_winners SET thumbnail_url = COALESCE($1, thumbnail_url), video_url = COALESCE($2, video_url) WHERE id = $3`,
                [fresh.thumbnail_url, fresh.video_url, row.id]
              ).catch(() => {});
            }
          } catch (_) { /* ignore individual refresh failures */ }
        });
        await Promise.all(refreshPromises);
      }
    }
    res.json({ success: true, winners: rows });
  } catch (err) {
    console.error('[BriefPipeline] GET /winners error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /detect — run winner detection from creative_analysis table
router.post('/detect', authenticate, async (_req, res) => {
  try {
    await ensureTables();

    // Step 1: Query creative_analysis for winners
    const winners = await pgQuery(`
      SELECT creative_id,
             SUM(spend) as total_spend,
             SUM(revenue) as total_revenue,
             CASE WHEN SUM(spend) > 0 THEN SUM(revenue) / SUM(spend) ELSE 0 END as roas,
             SUM(purchases) as purchases,
             CASE WHEN SUM(purchases) > 0 THEN SUM(spend) / SUM(purchases) ELSE 0 END as cpa,
             CASE WHEN SUM(impressions) > 0 THEN (SUM(clicks)::float / SUM(impressions)) * 100 ELSE 0 END as ctr,
             SUM(impressions) as impressions,
             SUM(clicks) as clicks,
             MAX(ad_name) as ad_name,
             MAX(angle) as angle,
             MAX(format) as format,
             MAX(avatar) as avatar,
             MAX(editor) as editor,
             MAX(hook_id) as hook_type,
             MAX(week) as week,
             MAX(thumbnail_url) as thumbnail_url,
             MAX(video_url) as video_url
      FROM creative_analysis
      WHERE synced_at >= NOW() - INTERVAL '7 days'
        AND type = 'video'
      GROUP BY creative_id
      HAVING SUM(spend) >= 100
         AND CASE WHEN SUM(spend) > 0 THEN SUM(revenue) / SUM(spend) ELSE 0 END >= 1.5
      ORDER BY roas DESC
      LIMIT 20
    `, [], { timeout: 15000 });

    console.log(`[BriefPipeline] Detected ${winners.length} potential winners`);

    const results = [];

    for (const w of winners) {
      // Step 2: Count existing iterations in ClickUp
      let iterations = [];
      try {
        iterations = await countIterations(w.creative_id);
      } catch (err) {
        console.error(`[BriefPipeline] countIterations error for ${w.creative_id}:`, err.message);
      }

      const winnerReason = classifyWinner(w);
      const readiness = classifyReadiness(w, iterations.length);

      // Find ClickUp task ID for this creative
      let clickupTaskId = null;
      try {
        clickupTaskId = await findClickUpTaskByBriefCode(w.creative_id);
      } catch (err) {
        console.error(`[BriefPipeline] findClickUpTask error for ${w.creative_id}:`, err.message);
      }

      // Upsert into brief_pipeline_winners
      const upserted = await pgQuery(`
        INSERT INTO brief_pipeline_winners (
          creative_id, ad_name, product_code, angle, format, avatar, editor,
          hook_type, week, spend, revenue, roas, purchases, cpa, ctr,
          impressions, clicks, clickup_task_id, existing_iterations,
          iteration_codes, winner_reason, iteration_readiness, thumbnail_url, video_url, status, detected_at
        ) VALUES (
          $1, $2, 'MR', $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14, $15, $16,
          $17, $18, $19, $20, $21, $22, $23, 'detected', NOW()
        )
        ON CONFLICT (creative_id) DO UPDATE SET
          ad_name = EXCLUDED.ad_name,
          angle = EXCLUDED.angle,
          format = EXCLUDED.format,
          avatar = EXCLUDED.avatar,
          editor = EXCLUDED.editor,
          hook_type = EXCLUDED.hook_type,
          week = EXCLUDED.week,
          spend = EXCLUDED.spend,
          revenue = EXCLUDED.revenue,
          roas = EXCLUDED.roas,
          purchases = EXCLUDED.purchases,
          cpa = EXCLUDED.cpa,
          ctr = EXCLUDED.ctr,
          impressions = EXCLUDED.impressions,
          clicks = EXCLUDED.clicks,
          clickup_task_id = EXCLUDED.clickup_task_id,
          existing_iterations = EXCLUDED.existing_iterations,
          iteration_codes = EXCLUDED.iteration_codes,
          winner_reason = EXCLUDED.winner_reason,
          iteration_readiness = EXCLUDED.iteration_readiness,
          thumbnail_url = EXCLUDED.thumbnail_url,
          video_url = EXCLUDED.video_url
        WHERE brief_pipeline_winners.status = 'detected'
        RETURNING *
      `, [
        w.creative_id, w.ad_name, w.angle, w.format, w.avatar, w.editor,
        w.hook_type, w.week, w.total_spend, w.total_revenue, w.roas,
        w.purchases, w.cpa, w.ctr, w.impressions, w.clicks,
        clickupTaskId, iterations.length,
        JSON.stringify(iterations.map(i => i.code)),
        winnerReason, readiness,
        w.thumbnail_url || null, w.video_url || null,
      ], { timeout: 10000 });

      if (upserted && upserted[0]) {
        results.push(upserted[0]);
      }
    }

    res.json({ success: true, detected: results.length, winners: results });
  } catch (err) {
    console.error('[BriefPipeline] POST /detect error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /winners/:id — get winner detail including ClickUp script
router.get('/winners/:id', authenticate, async (req, res) => {
  if (!validateUuid(req, res)) return;
  try {
    await ensureTables();
    const rows = await pgQuery(
      `SELECT * FROM brief_pipeline_winners WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, error: { message: 'Winner not found' } });
    }

    // Refresh thumbnail/video from creative_analysis (Meta CDN URLs expire)
    const freshUrls = await pgQuery(`
      SELECT thumbnail_url, video_url FROM creative_analysis
      WHERE creative_id = $1 AND (thumbnail_url IS NOT NULL OR video_url IS NOT NULL)
      ORDER BY synced_at DESC LIMIT 1
    `, [rows[0].creative_id]);
    if (freshUrls.length) {
      if (freshUrls[0].thumbnail_url) rows[0].thumbnail_url = freshUrls[0].thumbnail_url;
      if (freshUrls[0].video_url) rows[0].video_url = freshUrls[0].video_url;
    }

    const winner = rows[0];

    // Pull script from ClickUp if we have a task ID and don't have it cached
    if (winner.clickup_task_id && !winner.raw_script) {
      try {
        const scriptData = await extractScript(winner.clickup_task_id);
        await pgQuery(
          `UPDATE brief_pipeline_winners SET raw_script = $1 WHERE id = $2`,
          [scriptData.raw, winner.id]
        );
        winner.raw_script = scriptData.raw;
      } catch (err) {
        console.error(`[BriefPipeline] Script extraction error for ${winner.creative_id}:`, err.message);
      }
    }

    // Respond immediately — don't block on Meta API
    res.json({ success: true, winner });

    // Background: refresh Meta URLs if missing or expired CDN (not permanent .mp4), for next time
    const needsRefresh = !winner.thumbnail_url || !winner.video_url
      || (winner.thumbnail_url && winner.thumbnail_url.includes('fbcdn.net'))
      || (winner.video_url && !winner.video_url.includes('.mp4'));
    if (META_ACCESS_TOKEN && needsRefresh) {
      refreshMetaThumbnail(winner.creative_id).then(fresh => {
        if (!fresh) return;
        const updates = [];
        const params = [];
        if (fresh.thumbnail_url) { updates.push(`thumbnail_url = $${params.length + 1}`); params.push(fresh.thumbnail_url); }
        if (fresh.video_url) { updates.push(`video_url = $${params.length + 1}`); params.push(fresh.video_url); }
        if (updates.length) {
          params.push(winner.id);
          pgQuery(`UPDATE brief_pipeline_winners SET ${updates.join(', ')} WHERE id = $${params.length}`, params).catch(() => {});
        }
      }).catch(err => console.warn(`[BriefPipeline] Background Meta refresh error:`, err.message));
    }
  } catch (err) {
    console.error('[BriefPipeline] GET /winners/:id error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /winners/:id/select — update status to 'selected', save iteration config
router.post('/winners/:id/select', authenticate, async (req, res) => {
  if (!validateUuid(req, res)) return;
  try {
    await ensureTables();
    const body = req.body || {};
    const { iteration_mode, mode: modeAlt, aggressiveness, num_variations, fixed_elements, editor } = body;
    const mode = iteration_mode || modeAlt || 'hook_body';

    const rows = await pgQuery(
      `UPDATE brief_pipeline_winners
       SET status = 'selected',
           selected_at = NOW(),
           iteration_mode = $2,
           iteration_config = $3
       WHERE id = $1
       RETURNING *`,
      [req.params.id, mode, JSON.stringify({ mode, aggressiveness, num_variations, fixed_elements, editor })]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, error: { message: 'Winner not found' } });
    }

    res.json({ success: true, winner: rows[0] });
  } catch (err) {
    console.error('[BriefPipeline] POST /winners/:id/select error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /generate/:id — the MAIN generation pipeline (Steps 4-8)
router.post('/generate/:id', authenticate, async (req, res) => {
  if (!validateUuid(req, res)) return;
  try {
    await ensureTables();
    // Fetch the winner
    const winnerRows = await pgQuery(
      `SELECT * FROM brief_pipeline_winners WHERE id = $1`,
      [req.params.id]
    );
    if (!winnerRows.length) {
      return res.status(404).json({ success: false, error: { message: 'Winner not found' } });
    }
    const winner = winnerRows[0];

    // Read config from request body, or fall back to saved iteration_config from select step
    const savedConfig = winner.iteration_config || {};
    const body = req.body || {};
    const mode = body.mode || body.iteration_mode || savedConfig.mode || 'hook_body';
    const aggressiveness = body.aggressiveness || savedConfig.aggressiveness || 'medium';
    const num_variations = body.num_variations || savedConfig.num_variations || 3;
    const fixed_elements = body.fixed_elements || savedConfig.fixed_elements || [];
    const configEditor = body.editor || savedConfig.editor || null;

    // Guard: only allow generation from 'detected' or 'selected' status
    if (winner.status === 'generating') {
      return res.status(409).json({ success: false, error: { message: 'Generation already in progress for this winner.' } });
    }
    if (!['detected', 'selected'].includes(winner.status)) {
      return res.status(400).json({ success: false, error: { message: `Winner must be in "detected" or "selected" status to generate. Current status: "${winner.status}".` } });
    }

    // Update status to generating (atomic check — only from 'detected' or 'selected')
    const updated = await pgQuery(
      `UPDATE brief_pipeline_winners SET status = 'generating' WHERE id = $1 AND status IN ('detected', 'selected') RETURNING id`,
      [winner.id]
    );
    if (!updated.length) {
      return res.status(409).json({ success: false, error: { message: 'Generation already in progress for this winner.' } });
    }

    console.log(`[BriefPipeline] Starting generation pipeline for ${winner.creative_id}`);

    // Step 3: Extract script from ClickUp if needed
    if (!winner.raw_script && winner.clickup_task_id) {
      try {
        const scriptData = await extractScript(winner.clickup_task_id);
        winner.raw_script = scriptData.raw;
        await pgQuery(
          `UPDATE brief_pipeline_winners SET raw_script = $1 WHERE id = $2`,
          [scriptData.raw, winner.id]
        );
      } catch (scriptErr) {
        console.error(`[BriefPipeline] Script extraction failed:`, scriptErr.message);
      }
    }

    if (!winner.raw_script) {
      await pgQuery(`UPDATE brief_pipeline_winners SET status = 'detected' WHERE id = $1`, [winner.id]);
      return res.status(400).json({
        success: false,
        error: { message: 'No script available. Ensure the winner has a ClickUp task with a script in the description.' },
      });
    }

    // Step 4: Parse script with Claude
    console.log(`[BriefPipeline] Step 4: Parsing script for ${winner.creative_id}`);
    let parsedScript = winner.parsed_script;
    if (typeof parsedScript === 'string') { try { parsedScript = JSON.parse(parsedScript); } catch { parsedScript = null; } }
    if (!parsedScript) {
      const { system, user } = await buildScriptParserPrompt(winner.raw_script, winner.ad_name || winner.creative_id);
      parsedScript = await callClaude(system, user, 2000, { fast: true });
      if (!parsedScript || (!parsedScript.hooks?.length && !parsedScript.body?.trim())) {
        throw new Error('Claude failed to parse the script into a valid structure (missing hooks/body).');
      }
      await pgQuery(
        `UPDATE brief_pipeline_winners SET parsed_script = $1 WHERE id = $2`,
        [JSON.stringify(parsedScript), winner.id]
      );
    }

    // Step 5: Fetch product profile from library
    console.log(`[BriefPipeline] Step 5a: Fetching product profile for ${winner.product_code || 'MR'}`);
    const productProfile = await fetchProductProfile(winner.product_code || 'MR');
    if (!productProfile) {
      console.warn(`[BriefPipeline] WARNING: No product profile found for ${winner.product_code || 'MR'} — generation will proceed with limited context`);
    }
    const productContext = buildProductContextForBrief(productProfile);
    console.log(`[BriefPipeline] Product context: ${productContext === 'No product profile available.' ? 'EMPTY (no profile)' : `${productContext.split('\n').length} fields loaded`}`);

    // Step 5b: Deep 3-agent analysis (check cache first)
    console.log(`[BriefPipeline] Step 5b: Running deep analysis for ${winner.creative_id}`);
    const scriptHash = crypto.createHash('md5').update(winner.raw_script).digest('hex');
    let winAnalysis = null;

    const cacheRows = await pgQuery(
      `SELECT * FROM brief_pipeline_analysis_cache WHERE creative_id = $1 AND script_hash = $2`,
      [winner.creative_id, scriptHash]
    );

    const cachedAnalysis = cacheRows.length ? cacheRows[0].win_analysis : null;
    // Validate cache has new 3-agent format (scriptDna/psychology/iterationRules)
    // Old format had flat keys like hookMechanism — invalidate those
    if (cachedAnalysis?.scriptDna && cachedAnalysis?.psychology && cachedAnalysis?.iterationRules) {
      winAnalysis = cachedAnalysis;
      console.log(`[BriefPipeline] Using cached deep analysis for ${winner.creative_id}`);
    } else {
      if (cachedAnalysis) console.log(`[BriefPipeline] Stale analysis cache for ${winner.creative_id} — re-analyzing with 3-agent pipeline`);
      const { dnaPrompt, psychologyPrompt, rulesPrompt } = await buildDeepAnalysisPrompts(winner, parsedScript, productContext);

      // Run all 3 agents in parallel (iteration rules uses Haiku for speed — simpler output)
      const [scriptDna, psychology, iterationRules] = await Promise.all([
        callClaude(dnaPrompt.system, dnaPrompt.user, 2500),
        callClaude(psychologyPrompt.system, psychologyPrompt.user, 2500),
        callClaude(rulesPrompt.system, rulesPrompt.user, 2000, { fast: true }),
      ]);

      winAnalysis = { scriptDna, psychology, iterationRules };

      await pgQuery(
        `INSERT INTO brief_pipeline_analysis_cache (creative_id, script_hash, win_analysis)
         VALUES ($1, $2, $3)
         ON CONFLICT (creative_id) DO UPDATE SET script_hash = $2, win_analysis = $3, analyzed_at = NOW()`,
        [winner.creative_id, scriptHash, JSON.stringify(winAnalysis)]
      );
    }

    // Step 6: Build directions from analysis (skip separate strategy call)
    console.log(`[BriefPipeline] Step 6: Building ${num_variations} directions from analysis`);
    const config = { mode, aggressiveness, num_variations, fixed_elements };
    const safeDirections = winAnalysis.iterationRules?.safe_iteration_directions || [];
    const directions = [];
    for (let i = 0; i < num_variations; i++) {
      const dirText = safeDirections[i] || `Variation ${i + 1}: Fresh creative approach with different hook framing and tone`;
      directions.push({
        id: i + 1,
        name: `Direction ${i + 1}`,
        description: dirText,
        what_changes: dirText,
        what_stays: (winAnalysis.iterationRules?.must_stay_fixed || []).slice(0, 3).join('; ') || 'Core angle and mechanism',
        hook_direction: `Use a completely different hook approach than the original — variation ${i + 1} of ${num_variations}`,
        body_direction: dirText,
        emotional_shift: winAnalysis.psychology?.emotional_arc
          ? `${winAnalysis.psychology.emotional_arc?.at_hook || '?'} → ${winAnalysis.psychology.emotional_arc?.final_state || '?'}`
          : 'Maintain original emotional arc',
      });
    }

    // Step 7: Generate ALL briefs in parallel
    console.log(`[BriefPipeline] Step 7: Generating ${directions.length} briefs in parallel`);

    // Extract proven scripts from product profile as style reference
    const provenScripts = productProfile?.scripts;
    const styleRef = Array.isArray(provenScripts) && provenScripts.length
      ? provenScripts.slice(0, 2).map((s, i) => `STYLE REF ${i + 1}: ${typeof s === 'string' ? s.slice(0, 300) : (s.text || s.body || JSON.stringify(s)).slice(0, 300)}`).join('\n\n')
      : '';

    let nextBriefNum = await getNextBriefNumber();

    // Generate all variations in parallel — each direction is naturally different
    const generationResults = await Promise.all(directions.map(async (direction) => {
      try {
        const { system: genSystem, user: genUser } = await buildBriefGeneratorPrompt(parsedScript, winAnalysis, direction, config, productContext);
        let enhancedUser = genUser;
        if (styleRef) {
          enhancedUser += `\n\n# STYLE REFERENCE (proven scripts for this product — match this voice/tone)\n${styleRef}`;
        }
        // Add dedup instruction without needing previous outputs
        enhancedUser += `\n\n# VARIATION IDENTITY\nThis is variation ${direction.id} of ${directions.length}. Each variation follows a DIFFERENT iteration direction. Your creative approach must be COMPLETELY UNIQUE — different hook angles, different phrasing, different emotional entry point. Do NOT produce generic or safe copy.`;

        const generated = await callClaude(genSystem, enhancedUser, 3000);

        // Validate generated response has required fields
        if (!generated || (!generated.hooks && !generated.body)) {
          throw new Error('Claude returned invalid brief structure (missing hooks/body)');
        }
        if (!Array.isArray(generated.hooks)) generated.hooks = [];
        if (!generated.body) generated.body = '';

        // Step 8: Score only (blend validation removed for speed — saves 1 API call per variant)
        const { system: scoreSystem, user: scoreUser } = await buildBriefScorerPrompt(winner, parsedScript, generated, direction.name, winAnalysis, productContext);

        let scores = { novelty: { score: 5 }, aggression: { score: 5 }, coherence: { score: 5 }, hook_body_blend: { score: 5 }, conversion_potential: { score: 5 } };
        try {
          const sc = await callClaude(scoreSystem, scoreUser, 1500, { fast: true });
          if (sc) scores = sc;
        } catch (evalErr) {
          console.warn(`[BriefPipeline] Scoring error for direction #${direction.id}:`, evalErr.message);
          scores._scoring_failed = true;
        }

        const overall = scores.overall ?? (
          ((scores.novelty?.score ?? 5) * 0.15) +
          ((scores.aggression?.score ?? 5) * 0.15) +
          ((scores.coherence?.score ?? 5) * 0.25) +
          ((scores.hook_body_blend?.score ?? 5) * 0.15) +
          ((scores.conversion_potential?.score ?? 5) * 0.30)
        );

        return { generated, scores, overall, direction, success: true };
      } catch (dirErr) {
        console.error(`[BriefPipeline] Error generating direction #${direction.id}:`, dirErr.message);
        return { direction, success: false, error: dirErr.message };
      }
    }));

    // Step 9: Save all successful briefs to DB
    const generatedBriefs = [];
    for (const result of generationResults) {
      if (!result.success) continue;
      const { generated, scores, overall, direction } = result;

      const briefNumber = nextBriefNum++;
      const weekLabel = getCurrentWeekLabel();
      const namingConvention = buildNamingConvention({
        product_code: winner.product_code || 'MR',
        brief_number: briefNumber,
        parent_creative_id: winner.creative_id,
        avatar: winner.avatar,
        angle: winner.angle,
        format: winner.format,
        strategist: 'Ludovico',
        creator: 'NA',
        editor: configEditor || winner.editor || 'Antoni',
        week: weekLabel,
      });

      try {
        const inserted = await pgQuery(`
          INSERT INTO brief_pipeline_generated (
            winner_id, parent_creative_id, iteration_mode, aggressiveness,
            win_analysis, hooks, body, iteration_direction,
            novelty_score, aggression_score, coherence_score, overall_score,
            verdict, scores_json,
            brief_number, product_code, angle, format, avatar, editor,
            strategist, creator, naming_convention, status
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8,
            $9, $10, $11, $12, $13, $14,
            $15, $16, $17, $18, $19, $20,
            $21, $22, $23, 'generated'
          )
          RETURNING *
        `, [
          winner.id, winner.creative_id, mode, aggressiveness,
          JSON.stringify(winAnalysis), JSON.stringify(generated.hooks), generated.body,
          `${direction.name}: ${direction.description}`,
          scores.novelty?.score || 5, scores.aggression?.score || 5,
          scores.coherence?.score || 5, overall,
          scores.verdict || 'MAYBE', JSON.stringify(scores),
          briefNumber, winner.product_code || 'MR', winner.angle, winner.format,
          winner.avatar, configEditor || winner.editor || 'Antoni',
          'Ludovico', 'NA', namingConvention,
        ], { timeout: 10000 });

        generatedBriefs.push({
          ...inserted[0],
          scores,
          direction,
        });
      } catch (dbErr) {
        console.error(`[BriefPipeline] DB insert error for direction #${direction.id}:`, dbErr.message);
      }
    }

    if (!generatedBriefs.length) {
      await pgQuery(`UPDATE brief_pipeline_winners SET status = 'detected' WHERE id = $1`, [winner.id]);
      return res.status(500).json({
        success: false,
        error: { message: 'All brief generations failed. Check server logs for details.' },
      });
    }

    // Assign ranks based on overall score (parallel updates)
    generatedBriefs.sort((a, b) => (b.overall_score || 0) - (a.overall_score || 0));
    await Promise.all(generatedBriefs.map((brief, i) => {
      const rank = i + 1;
      brief.rank = rank;
      return pgQuery(`UPDATE brief_pipeline_generated SET rank = $1 WHERE id = $2`, [rank, brief.id]);
    }));

    // Reset winner status back to detected so it stays in Winning Ads column
    await pgQuery(
      `UPDATE brief_pipeline_winners SET status = 'detected' WHERE id = $1`,
      [winner.id]
    );

    console.log(`[BriefPipeline] Generation complete: ${generatedBriefs.length} briefs for ${winner.creative_id}`);

    res.json({
      success: true,
      winner_id: winner.id,
      creative_id: winner.creative_id,
      briefs_generated: generatedBriefs.length,
      briefs: generatedBriefs,
    });
  } catch (err) {
    console.error('[BriefPipeline] POST /generate/:id error:', err.message);
    // Reset status on failure
    await pgQuery(
      `UPDATE brief_pipeline_winners SET status = 'detected' WHERE id = $1`,
      [req.params.id]
    ).catch(() => {});
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /generate-from-script — Generate briefs from manually pasted/URL script
router.post('/generate-from-script', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const { script, url, productId, productCode, angle, mode, numVariations = 3 } = req.body;

    let rawScript = script || '';

    // URL mode: smart multi-strategy extraction
    if (url && !rawScript) {
      try {
        rawScript = await extractScriptFromUrl(url);
      } catch (urlErr) {
        return res.status(400).json({ success: false, error: { message: urlErr.message || 'Failed to process URL' } });
      }
    }

    if (!rawScript || rawScript.length < 20) {
      return res.status(400).json({ success: false, error: { message: 'Script text is required (minimum 20 characters).' } });
    }

    console.log(`[BriefPipeline] generate-from-script: ${rawScript.length} chars, ${numVariations} variants`);

    // Create a virtual winner record
    const creativeId = `MANUAL-${Date.now().toString(36).toUpperCase()}`;
    const insertedWinner = await pgQuery(`
      INSERT INTO brief_pipeline_winners (
        creative_id, ad_name, product_code, angle, format, raw_script,
        status, spend, roas, cpa, ctr, purchases, winner_reason
      ) VALUES ($1, $2, $3, $4, $5, $6, 'generating', 0, 0, 0, 0, 0, 'manual')
      RETURNING *
    `, [
      creativeId,
      `Manual script — ${rawScript.slice(0, 50)}...`,
      productCode || 'MR',
      angle || 'NA',
      'Mashup',
      rawScript,
    ]);
    const winner = insertedWinner[0];

    // Step 4: Parse script
    console.log(`[BriefPipeline] Parsing manual script`);
    const { system: parseSystem, user: parseUser } = await buildScriptParserPrompt(rawScript, creativeId);
    // Parse script + fetch product in parallel (they're independent)
    const [parsedScriptRaw, productProfile] = await Promise.all([
      callClaude(parseSystem, parseUser, 2000, { fast: true }),
      fetchProductProfile(productCode || 'MR'),
    ]);
    let parsedScript = parsedScriptRaw;
    if (!parsedScript || (!parsedScript.hooks?.length && !parsedScript.body?.trim())) {
      parsedScript = { hooks: [], body: rawScript, cta: '', format_notes: '' };
    }
    pgQuery(`UPDATE brief_pipeline_winners SET parsed_script = $1 WHERE id = $2`, [JSON.stringify(parsedScript), winner.id]).catch(() => {});

    // Step 5: Deep analysis
    if (!productProfile) {
      console.warn(`[BriefPipeline] WARNING: No product profile found for ${productCode || 'MR'} — generation will proceed with limited context`);
    }
    const productContext = buildProductContextForBrief(productProfile);
    console.log(`[BriefPipeline] Product context: ${productContext === 'No product profile available.' ? 'EMPTY (no profile)' : `${productContext.split('\n').length} fields loaded`}`);

    const { dnaPrompt, psychologyPrompt, rulesPrompt } = await buildDeepAnalysisPrompts(winner, parsedScript, productContext);
    const [scriptDna, psychology, iterationRules] = await Promise.all([
      callClaude(dnaPrompt.system, dnaPrompt.user, 2500),
      callClaude(psychologyPrompt.system, psychologyPrompt.user, 2500),
      callClaude(rulesPrompt.system, rulesPrompt.user, 2000, { fast: true }),
    ]);
    const winAnalysis = { scriptDna, psychology, iterationRules };

    // Cache analysis
    const scriptHash = crypto.createHash('md5').update(rawScript).digest('hex');
    await pgQuery(
      `INSERT INTO brief_pipeline_analysis_cache (creative_id, script_hash, win_analysis)
       VALUES ($1, $2, $3) ON CONFLICT (creative_id) DO UPDATE SET script_hash = $2, win_analysis = $3, analyzed_at = NOW()`,
      [creativeId, scriptHash, JSON.stringify(winAnalysis)]
    );

    // Step 6: Build directions + generate
    const safeDirections = iterationRules?.safe_iteration_directions || [];
    const isCloneMode = mode === 'clone';

    let nextBriefNum = await getNextBriefNumber();
    let generationResults;
    const config = { mode: isCloneMode ? 'clone' : 'hook_body', aggressiveness: 'medium', num_variations: numVariations, fixed_elements: [] };

    if (isCloneMode) {
      // ═══════════════════════════════════════════════════
      // CLONE MODE — Single 1:1 clone with dedicated prompt
      // ═══════════════════════════════════════════════════
      console.log(`[BriefPipeline] Clone mode — generating 1:1 script clone`);
      const { system: cloneSystem, user: cloneUser } = await buildScriptClonePrompt(parsedScript, winAnalysis, productContext);

      generationResults = [await (async () => {
        try {
          const generated = await callClaude(cloneSystem, cloneUser, 4096);
          if (!generated || (!generated.hooks && !generated.body)) throw new Error('Invalid clone response');
          if (!Array.isArray(generated.hooks)) generated.hooks = [];
          if (!generated.body) generated.body = '';

          // Normalize clone output to match standard format
          if (generated.clone_fidelity) {
            generated.key_changes_from_original = generated.key_adaptations || generated.key_changes_from_original || '';
          }

          // Score only (blend validation removed for speed)
          const { system: scoreSystem, user: scoreUser } = await buildBriefScorerPrompt(winner, parsedScript, generated, '1:1 Clone', winAnalysis, productContext);

          let scores = { novelty: { score: 3 }, aggression: { score: 5 }, coherence: { score: 5 }, hook_body_blend: { score: 5 }, conversion_potential: { score: 5 } };
          try {
            const sc = await callClaude(scoreSystem, scoreUser, 1500, { fast: true });
            if (sc) scores = sc;
          } catch (evalErr) {
            console.warn(`[BriefPipeline] Clone scoring failed:`, evalErr.message);
            scores._scoring_failed = true;
            scores.verdict = scores.verdict || 'MAYBE';
          }

          const overall = scores.overall ?? (
            ((scores.novelty?.score ?? 3) * 0.05) +
            ((scores.aggression?.score ?? 5) * 0.15) +
            ((scores.coherence?.score ?? 5) * 0.30) +
            ((scores.hook_body_blend?.score ?? 5) * 0.20) +
            ((scores.conversion_potential?.score ?? 5) * 0.30)
          );

          return {
            generated,
            scores,
            overall,
            direction: { id: 1, name: '1:1 Clone', description: 'Structural clone with product swap' },
            success: true,
          };
        } catch (err) {
          console.error(`[BriefPipeline] clone generation failed:`, err.message);
          return { direction: { id: 1, name: '1:1 Clone' }, success: false };
        }
      })()];

    } else {
      // ═══════════════════════════════════════════════════
      // VARIANT MODE — Multiple creative variations
      // ═══════════════════════════════════════════════════
      const directions = [];
      for (let i = 0; i < numVariations; i++) {
        const dirText = safeDirections[i] || `Variation ${i + 1}: Fresh creative approach`;
        directions.push({
          id: i + 1,
          name: `Direction ${i + 1}`,
          description: dirText,
          what_changes: dirText,
          what_stays: (iterationRules?.must_stay_fixed || []).slice(0, 3).join('; ') || 'Core angle and mechanism',
          hook_direction: `Variation ${i + 1} of ${numVariations}`,
          body_direction: dirText,
          emotional_shift: psychology?.emotional_arc
            ? `${psychology.emotional_arc?.at_hook || '?'} → ${psychology.emotional_arc?.final_state || '?'}`
            : 'Maintain original arc',
        });
      }

      const provenScripts = productProfile?.scripts;
      const styleRef = Array.isArray(provenScripts) && provenScripts.length
        ? provenScripts.slice(0, 2).map((s, i) => `STYLE REF ${i + 1}: ${typeof s === 'string' ? s.slice(0, 300) : (s.text || s.body || JSON.stringify(s)).slice(0, 300)}`).join('\n\n')
        : '';

      generationResults = await Promise.all(directions.map(async (direction) => {
        try {
          const { system: genSystem, user: genUser } = await buildBriefGeneratorPrompt(parsedScript, winAnalysis, direction, config, productContext);
          let enhancedUser = genUser;
          if (styleRef) enhancedUser += `\n\n# STYLE REFERENCE\n${styleRef}`;
          enhancedUser += `\n\n# VARIATION IDENTITY\nThis is variation ${direction.id} of ${directions.length}. Be COMPLETELY UNIQUE.`;

          const generated = await callClaude(genSystem, enhancedUser, 3000);
          if (!generated || (!generated.hooks && !generated.body)) throw new Error('Invalid response');
          if (!Array.isArray(generated.hooks)) generated.hooks = [];
          if (!generated.body) generated.body = '';

          // Score only (blend validation removed for speed)
          const { system: scoreSystem, user: scoreUser } = await buildBriefScorerPrompt(winner, parsedScript, generated, direction.name, winAnalysis, productContext);

          let scores = { novelty: { score: 5 }, aggression: { score: 5 }, coherence: { score: 5 }, hook_body_blend: { score: 5 }, conversion_potential: { score: 5 } };
          try {
            const sc = await callClaude(scoreSystem, scoreUser, 1500, { fast: true });
            if (sc) scores = sc;
          } catch (evalErr) {
            console.warn(`[BriefPipeline] generate-from-script scoring error for direction #${direction.id}:`, evalErr.message);
            scores._scoring_failed = true;
          }

          const overall = scores.overall ?? (
            ((scores.novelty?.score ?? 5) * 0.15) +
            ((scores.aggression?.score ?? 5) * 0.15) +
            ((scores.coherence?.score ?? 5) * 0.25) +
            ((scores.hook_body_blend?.score ?? 5) * 0.15) +
            ((scores.conversion_potential?.score ?? 5) * 0.30)
          );

          return { generated, scores, overall, direction, success: true };
        } catch (err) {
          console.error(`[BriefPipeline] generate-from-script direction #${direction.id}:`, err.message);
          return { direction, success: false };
        }
      }));
    }

    // Save results
    const generatedBriefs = [];
    for (const result of generationResults) {
      if (!result.success) continue;
      const { generated, scores, overall, direction } = result;
      const briefNumber = nextBriefNum++;
      const weekLabel = getCurrentWeekLabel();
      const namingConvention = buildNamingConvention({
        product_code: productCode || 'MR', brief_number: briefNumber,
        parent_creative_id: creativeId, avatar: 'NA', angle: angle || 'NA',
        format: 'Mashup', strategist: 'Ludovico', creator: 'NA', editor: 'Antoni', week: weekLabel,
      });

      try {
        const inserted = await pgQuery(`
          INSERT INTO brief_pipeline_generated (
            winner_id, parent_creative_id, iteration_mode, aggressiveness,
            win_analysis, hooks, body, iteration_direction,
            novelty_score, aggression_score, coherence_score, overall_score,
            verdict, scores_json,
            brief_number, product_code, angle, format, avatar, editor,
            strategist, creator, naming_convention, status
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8,
            $9, $10, $11, $12, $13, $14,
            $15, $16, $17, $18, $19, $20,
            $21, $22, $23, 'generated'
          ) RETURNING *
        `, [
          winner.id, creativeId, config.mode, 'medium',
          JSON.stringify(winAnalysis), JSON.stringify(generated.hooks), generated.body,
          `${direction.name}: ${direction.description}`,
          scores.novelty?.score || 5, scores.aggression?.score || 5,
          scores.coherence?.score || 5, overall,
          scores.verdict || 'MAYBE', JSON.stringify(scores),
          briefNumber, productCode || 'MR', angle || 'NA', 'Mashup',
          'NA', 'Antoni', 'Ludovico', 'NA', namingConvention,
        ], { timeout: 10000 });
        generatedBriefs.push({ ...inserted[0], scores, direction });
      } catch (dbErr) {
        console.error(`[BriefPipeline] DB insert error for direction #${direction.id}:`, dbErr.message);
      }
    }

    if (!generatedBriefs.length) {
      // All DB inserts failed or all generations failed
      await pgQuery(`UPDATE brief_pipeline_winners SET status = 'detected' WHERE id = $1`, [winner.id]);
      return res.status(500).json({
        success: false,
        error: { message: 'All brief generations failed. Check server logs for details.' },
      });
    }

    // Rank (parallel updates)
    generatedBriefs.sort((a, b) => (b.overall_score || 0) - (a.overall_score || 0));
    await Promise.all(generatedBriefs.map((brief, i) => {
      brief.rank = i + 1;
      return pgQuery(`UPDATE brief_pipeline_generated SET rank = $1 WHERE id = $2`, [i + 1, brief.id]);
    }));

    // Mark virtual winner as detected (keeps it in the winning ads column)
    await pgQuery(`UPDATE brief_pipeline_winners SET status = 'detected' WHERE id = $1`, [winner.id]);

    console.log(`[BriefPipeline] generate-from-script complete: ${generatedBriefs.length} briefs`);
    res.json({ success: true, creative_id: creativeId, briefs_generated: generatedBriefs.length, briefs: generatedBriefs });
  } catch (err) {
    console.error('[BriefPipeline] generate-from-script error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /generated — list all generated briefs
router.get('/generated', authenticate, async (_req, res) => {
  try {
    await ensureTables();
    const rows = await pgQuery(
      `SELECT g.*, w.parsed_script AS original_script, w.raw_script AS original_raw_script
       FROM brief_pipeline_generated g
       LEFT JOIN brief_pipeline_winners w ON g.winner_id = w.id
       WHERE g.status != 'rejected'
       ORDER BY g.overall_score DESC, g.created_at DESC`
    );
    res.json({ success: true, briefs: rows });
  } catch (err) {
    console.error('[BriefPipeline] GET /generated error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /generated/:id — get generated brief detail
router.get('/generated/:id', authenticate, async (req, res) => {
  if (!validateUuid(req, res)) return;
  try {
    await ensureTables();
    const rows = await pgQuery(
      `SELECT g.*, w.parsed_script AS original_script, w.raw_script AS original_raw_script
       FROM brief_pipeline_generated g
       LEFT JOIN brief_pipeline_winners w ON g.winner_id = w.id
       WHERE g.id = $1`,
      [req.params.id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, error: { message: 'Brief not found' } });
    }
    res.json({ success: true, brief: rows[0] });
  } catch (err) {
    console.error('[BriefPipeline] GET /generated/:id error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// PATCH /generated/:id — update status (approve/reject)
router.patch('/generated/:id', authenticate, async (req, res) => {
  if (!validateUuid(req, res)) return;
  try {
    await ensureTables();
    const reqBody = req.body || {};
    const { status: newStatus, hooks, body: briefBody } = reqBody;

    let contentUpdated = false;
    let contentResult = null;

    // If content edit (hooks/body) - handle this BEFORE status change
    if (hooks !== undefined || briefBody !== undefined) {
      const setClauses = [];
      const params = [];
      let idx = 1;
      if (hooks !== undefined) { setClauses.push(`hooks = $${idx++}`); params.push(JSON.stringify(hooks)); }
      if (briefBody !== undefined) { setClauses.push(`body = $${idx++}`); params.push(briefBody); }
      params.push(req.params.id);
      const rows = await pgQuery(
        `UPDATE brief_pipeline_generated SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
        params
      );
      if (!rows.length) return res.status(404).json({ success: false, error: { message: 'Brief not found' } });
      contentUpdated = true;
      contentResult = rows[0];
      if (!newStatus) return res.json({ success: true, brief: rows[0] });
    }

    const validStatuses = ['approved', 'rejected', 'ready_to_launch', 'launched', 'launch_failed', 'generated', 'pushed'];
    if (!validStatuses.includes(newStatus)) {
      return res.status(400).json({ success: false, error: { message: `Status must be one of: ${validStatuses.join(', ')}` } });
    }

    // Allow specific transitions
    const allowedFrom = {
      approved: ['generated'],
      rejected: ['generated'],
      ready_to_launch: ['approved'],
      launched: ['ready_to_launch', 'launching'],
      launch_failed: ['ready_to_launch', 'launching'],
      pushed: ['approved'],
      generated: ['approved', 'rejected'], // allow un-approve
    };
    const fromStatuses = allowedFrom[newStatus] || [];
    const extra = newStatus === 'approved' ? ', approved_at = NOW()' : newStatus === 'launched' ? ', launched_at = NOW()' : '';
    const placeholders = fromStatuses.map((_, i) => `$${i + 3}`).join(',');
    const rows = await pgQuery(
      `UPDATE brief_pipeline_generated SET status = $1${extra} WHERE id = $2 AND status IN (${placeholders}) RETURNING *`,
      [newStatus, req.params.id, ...fromStatuses]
    );

    if (!rows.length) {
      // Check if brief exists but is in wrong status
      const existing = await pgQuery(`SELECT id, status FROM brief_pipeline_generated WHERE id = $1`, [req.params.id]);
      if (existing.length) {
        // If content was already saved, return 200 with a warning instead of 409
        if (contentUpdated) {
          return res.json({
            success: true,
            brief: contentResult,
            warning: `Content was saved, but status could not be changed — brief is already "${existing[0].status}".`
          });
        }
        return res.status(409).json({ success: false, error: { message: `Brief is already "${existing[0].status}" and cannot be changed.` } });
      }
    }

    if (!rows.length) {
      return res.status(404).json({ success: false, error: { message: 'Brief not found' } });
    }

    res.json({ success: true, brief: rows[0] });
  } catch (err) {
    console.error('[BriefPipeline] PATCH /generated/:id error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// DELETE /generated/:id — permanently delete a generated brief
router.delete('/generated/:id', authenticate, async (req, res) => {
  if (!validateUuid(req, res)) return;
  try {
    await ensureTables();
    const rows = await pgQuery(
      `DELETE FROM brief_pipeline_generated WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, error: { message: 'Brief not found' } });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[BriefPipeline] DELETE /generated/:id error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /generated/:id/enhance — AI enhancement endpoint
router.post('/generated/:id/enhance', authenticate, async (req, res) => {
  if (!validateUuid(req, res)) return;
  try {
    const { instruction, currentHooks, currentBody } = req.body || {};

    if (!instruction?.trim()) {
      return res.status(400).json({ success: false, error: { message: 'Instruction is required' } });
    }

    // Verify brief exists and get product context
    const rows = await pgQuery(`SELECT * FROM brief_pipeline_generated WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, error: { message: 'Brief not found' } });

    const brief = rows[0];

    // Fetch product profile for context
    let productContextStr = '';
    try {
      const productProfile = await fetchProductProfile(brief.product_code || 'MR');
      if (productProfile) {
        productContextStr = buildProductContextForBrief(productProfile);
      }
    } catch (profileErr) {
      console.warn('[BriefPipeline] Could not fetch product profile for enhance:', profileErr.message);
    }

    const hooksFormatted = (currentHooks || []).map((h, i) => `Hook ${i+1}: ${h.text}${h.mechanism ? ` [${h.mechanism}]` : ''}`).join('\n');

    const enhanceSystem = `You are an expert direct-response copywriter and creative strategist specializing in Facebook UGC-style video ad scripts. You make precise, surgical edits to existing scripts and hooks without touching anything outside the scope of the edit request. You never use em dashes or hyphens inside any copy. You use periods, line breaks, or rewrite sentence structure instead.${productContextStr ? ' You have access to the product brief and compliance rules. Never invent claims not present in the product profile.' : ''}`;

    const enhanceUser = `You are enhancing an existing piece of ad copy. Your job is to make only the change requested. Do not rewrite, improve, or touch anything outside the scope of the edit instruction.

Read the full existing copy first. Understand its structure, tone, perspective, avatar, and emotional flow before making any change. Then apply only the edit requested.

${productContextStr ? `PRODUCT CONTEXT:\n${productContextStr}\n\n` : ''}EXISTING COPY:
--- Hooks ---
${hooksFormatted}

--- Body ---
${currentBody || '(no body)'}

---

EDIT INSTRUCTION: ${instruction}

---

EDIT RULES:

1. SCOPE LOCK: Only change what the edit instruction targets. If the instruction says change hook 1, only hook 1 changes. If it says change a specific phrase, only that phrase changes. Everything else must remain word for word identical.

2. CONTINUITY: The edited element must match the tone, register, perspective, pronouns, and emotional flow of the surrounding copy. Read the line before and the line after the edit target. The new version must feel like it was always there.

3. PERSPECTIVE LOCK: Maintain the exact same speaker frame and pronoun structure as the existing copy. If the existing copy speaks to a gift buyer about a third person, the edit must do the same. Never shift perspective during an edit.

4. COMPLIANCE: Never directly promise the viewer will win or earn money. Never use em dashes or hyphens. All pricing in USD. Never invent product claims not present in the product profile.

5. HOOK SPECIFIC RULES: If the edit target is a hook, the new version must still pass: perspective matches the body opener, tension created by the hook is resolved by the first line of the body, no bridge line is needed between hook and body. If any check fails, rewrite before outputting.

6. VARIANT LOGIC: If the edit instruction asks for a new variant or alternative rather than a replacement, include both the original and the new variant in the output.

7. SELF CHECK: Before outputting, read the full copy with the edit applied from start to finish. Confirm it reads as one seamless piece. Confirm no rules were broken.

Return ONLY valid JSON, no markdown fences:
{
  "hooks": [
    { "id": "H1", "text": "...", "mechanism": "..." },
    { "id": "H2", "text": "...", "mechanism": "..." },
    { "id": "H3", "text": "...", "mechanism": "..." }
  ],
  "body": "the complete body text with edit applied",
  "edit_summary": "one sentence describing what was changed and why it fits"
}`;

    const enhanced = await callClaude(enhanceSystem, enhanceUser, 3000);

    if (!enhanced || (!enhanced.hooks && !enhanced.body)) {
      return res.status(500).json({ success: false, error: { message: 'AI returned invalid response structure' } });
    }

    res.json({
      success: true,
      hooks: enhanced.hooks || currentHooks,
      body: enhanced.body || currentBody,
      edit_summary: enhanced.edit_summary || null,
    });
  } catch (err) {
    console.error('[BriefPipeline] POST /generated/:id/enhance error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /generated/:id/push — push approved brief to ClickUp
router.post('/generated/:id/push', authenticate, async (req, res) => {
  if (!validateUuid(req, res)) return;
  try {
    await ensureTables();
    const rows = await pgQuery(
      `SELECT * FROM brief_pipeline_generated WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, error: { message: 'Brief not found' } });
    }

    const brief = rows[0];
    if (brief.status !== 'approved') {
      return res.status(400).json({ success: false, error: { message: 'Brief must be approved before pushing to ClickUp' } });
    }

    if (brief.clickup_task_id) {
      return res.status(400).json({ success: false, error: { message: 'Brief already pushed to ClickUp' } });
    }

    // Look up parent winner's ClickUp task ID for the Frame.io reference link
    let parentClickupTaskId = null;
    if (brief.winner_id) {
      const winnerRows = await pgQuery(`SELECT clickup_task_id FROM brief_pipeline_winners WHERE id = $1`, [brief.winner_id]);
      parentClickupTaskId = winnerRows[0]?.clickup_task_id || null;
    }

    const result = await pushBriefToClickUp(brief, parentClickupTaskId);

    await pgQuery(
      `UPDATE brief_pipeline_generated
       SET status = 'pushed', clickup_task_id = $1, clickup_task_url = $2, pushed_at = NOW()
       WHERE id = $3`,
      [result.taskId, result.taskUrl, brief.id]
    );

    res.json({
      success: true,
      brief_id: brief.id,
      clickup_task_id: result.taskId,
      clickup_task_url: result.taskUrl,
      naming_convention: result.namingConvention,
    });
  } catch (err) {
    console.error('[BriefPipeline] POST /generated/:id/push error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /batch-push — push all approved briefs to ClickUp
router.post('/batch-push', authenticate, async (_req, res) => {
  try {
    await ensureTables();
    const approvedRows = await pgQuery(
      `SELECT g.*, w.clickup_task_id AS parent_clickup_task_id
       FROM brief_pipeline_generated g
       LEFT JOIN brief_pipeline_winners w ON g.winner_id = w.id
       WHERE g.status = 'approved' AND g.clickup_task_id IS NULL
       ORDER BY g.rank ASC`
    );

    if (!approvedRows.length) {
      return res.json({ success: true, pushed: 0, message: 'No approved briefs to push' });
    }

    const results = [];
    const errors = [];

    for (const brief of approvedRows) {
      try {
        const result = await pushBriefToClickUp(brief, brief.parent_clickup_task_id);

        await pgQuery(
          `UPDATE brief_pipeline_generated
           SET status = 'pushed', clickup_task_id = $1, clickup_task_url = $2, pushed_at = NOW()
           WHERE id = $3`,
          [result.taskId, result.taskUrl, brief.id]
        );

        results.push({
          brief_id: brief.id,
          clickup_task_id: result.taskId,
          clickup_task_url: result.taskUrl,
          naming_convention: result.namingConvention,
        });
      } catch (pushErr) {
        console.error(`[BriefPipeline] Batch push error for ${brief.id}:`, pushErr.message);
        errors.push({ brief_id: brief.id, error: pushErr.message });
      }
    }

    res.json({
      success: true,
      pushed: results.length,
      failed: errors.length,
      results,
      errors: errors.length ? errors : undefined,
    });
  } catch (err) {
    console.error('[BriefPipeline] POST /batch-push error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /stats — pipeline stats (counts per column)
router.get('/stats', authenticate, async (_req, res) => {
  try {
    await ensureTables();

    const winnerStats = await pgQuery(`
      SELECT status, COUNT(*)::int as count
      FROM brief_pipeline_winners
      GROUP BY status
    `);

    const briefStats = await pgQuery(`
      SELECT status, COUNT(*)::int as count
      FROM brief_pipeline_generated
      GROUP BY status
    `);

    const stats = {
      detected: 0,
      selected: 0,
      generating: 0,
      generated: 0,
      approved: 0,
      rejected: 0,
      pushed: 0,
    };

    for (const row of winnerStats) {
      if (row.status in stats) stats[row.status] = row.count;
    }
    for (const row of briefStats) {
      if (row.status in stats) stats[row.status] += row.count;
      else stats[row.status] = row.count;
    }

    res.json({ success: true, stats });
  } catch (err) {
    console.error('[BriefPipeline] GET /stats error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Settings: Prompt management ──────────────────────────────────────

// Default prompt descriptions for the UI
const PROMPT_TYPES = [
  { key: 'scriptParser', label: 'Script Parser', description: 'Extracts hooks, body, and CTA from raw script text', icon: 'FileSearch' },
  { key: 'scriptDna', label: 'Script DNA', description: 'Analyzes core angle, mechanism, narrative structure, and what makes the ad convert', icon: 'Dna' },
  { key: 'psychology', label: 'Psychology', description: 'Maps emotional arc, analyzes hooks, and profiles target audience', icon: 'Brain' },
  { key: 'iterationRules', label: 'Iteration Rules', description: 'Defines what must stay fixed, what can vary, and what is high-risk to change', icon: 'Shield' },
  { key: 'scriptClone', label: '1:1 Script Clone', description: 'Clones a competitor script for our product — paragraph-by-paragraph mapping with product swap', icon: 'Layers' },
  { key: 'generator', label: 'Brief Generator', description: 'Generates 1 body + 3 hooks per iteration direction, preserving structural skeleton', icon: 'Sparkles' },
  { key: 'scorer', label: 'Scorer', description: 'Rates briefs on novelty, aggression, coherence, hook-body blend, and conversion potential', icon: 'BarChart3' },
  { key: 'blendValidator', label: 'Blend Validator', description: 'Checks if each hook flows naturally into the body', icon: 'Link' },
];

// Cache for custom prompts from DB
let customPromptsCache = { data: null, timestamp: 0 };
const PROMPT_CACHE_TTL = 5 * 60 * 1000; // 5 min

async function getCustomPrompts() {
  if (customPromptsCache.data && Date.now() - customPromptsCache.timestamp < PROMPT_CACHE_TTL) {
    return customPromptsCache.data;
  }
  try {
    const rows = await pgQuery(`SELECT value FROM system_settings WHERE key = 'brief_pipeline_prompts'`);
    const prompts = rows.length ? (typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value) : null;
    customPromptsCache = { data: prompts, timestamp: Date.now() };
    return prompts;
  } catch {
    return null;
  }
}

// Extract default prompts for the settings UI — full actual prompts used in production
function getDefaultPrompts() {
  return {
    scriptParser: {
      system: 'You are a script parser for video ad briefs. Extract the structured components from the raw script text below.',
      user: `RAW SCRIPT:
{{rawScript}}

TASK NAME: {{taskName}}

Extract and return ONLY valid JSON:
{
  "hooks": [
    {
      "id": "H1",
      "text": "the full hook text",
      "mechanism": "fear" | "curiosity" | "social_proof" | "authority" | "controversy" | "shock" | "question" | "statistic" | "story" | "challenge",
      "length": "short" | "medium" | "long"
    }
  ],
  "body": "the full body script text, preserving paragraphs",
  "cta": "the call-to-action text if present",
  "format_notes": "any production notes, visual directions, or format instructions",
  "estimated_length_seconds": number,
  "villains": ["list of enemies/villains mentioned"],
  "proof_elements": ["list of proof mechanisms used"],
  "offer_mentioned": true/false,
  "discount_code_used": "code" or null
}

RULES:
- Hooks are usually labeled H1, H2, H3 or Hook 1, Hook 2, Hook 3 or numbered
- If hooks aren't explicitly labeled, the first 1-3 sentences before the body are hooks
- The body is everything after the hooks until the CTA
- Preserve the exact wording — do NOT paraphrase or rewrite
- If the script has multiple sections (e.g. "Body:", "CTA:"), respect those boundaries`,
    },
    scriptDna: {
      system: 'You are a senior direct-response strategist and copy analyst.',
      user: `# TASK
Deconstruct this winning ad into its core conversion components AND map its narrative structure step-by-step. Identify the logical engine — WHY this ad converts, not just what it says.

# AD CONTEXT
{{adContext}}

# PRODUCT CONTEXT
{{productContext}}

# WINNING AD SCRIPT
{{scriptText}}

# OUTPUT (JSON only, no markdown, no backticks, no explanation)
{
  "core_angle": "the central persuasion angle driving the ad",
  "primary_emotion": "the dominant emotion leveraged",
  "secondary_emotions": ["list", "of", "supporting", "emotions"],
  "target_desire": "what the viewer wants that this ad promises",
  "target_fear": "what the viewer is afraid of that this ad addresses",
  "belief_shift": "what belief must change for the viewer to buy",
  "problem_presented": "the specific problem framed in the ad",
  "solution_presented": "how the product/offer is positioned as the answer",
  "mechanism": "the unique mechanism or reason WHY the solution works",
  "proof_type": "how credibility is established",
  "cta_type": "how the call to action is structured",
  "audience_awareness_level": "unaware / problem-aware / solution-aware / product-aware / most-aware",
  "narrative_structure": {
    "hook_type": "the hook technique used",
    "opening_tension": "what tension or open loop is created immediately",
    "problem_escalation": "how the problem is intensified after the hook",
    "explanation": "how the solution/mechanism is introduced and explained",
    "proof_moment": "where and how proof or credibility is delivered",
    "contrast": "any before/after or us-vs-them comparison (or null if absent)",
    "resolution": "how tension is resolved and the viewer is moved toward action",
    "cta_structure": "exact CTA approach"
  },
  "why_it_works": "1-2 sentences on WHY this ad converts",
  "core_argument": "the central argument in one sentence",
  "undeniable_truth": "the fact or truth used to make the argument believable",
  "what_makes_it_believable": "the credibility mechanism",
  "what_would_break_it": "the single change that would destroy this ad's effectiveness",
  "structural_skeleton": {
    "hook_framework": "the exact hook technique/framework used",
    "rhetorical_devices": ["list every distinct rhetorical device or pattern used"],
    "section_by_section": ["list each section of the script in order"],
    "signature_phrases": ["list any distinctive phrases or patterns that define this script's identity"],
    "pacing_rhythm": "describe the sentence rhythm pattern"
  }
}

# RULES
- Be precise, not generic. Every field must be specific to THIS ad.
- Do NOT rewrite the ad. Extract what makes it convert.
- Focus on reasoning, not wording.
- The structural_skeleton is CRITICAL — it must capture the exact rhetorical framework so iterations can replicate the same skeleton with different words.`,
    },
    psychology: {
      system: 'You are a consumer psychology expert and hook specialist for paid social ads.',
      user: `# TASK
Perform three analyses on this winning ad:
1. Map the emotional journey of the viewer at each stage
2. Deep-analyze every hook in the ad
3. Infer and validate the target audience against the product profile

# PRODUCT CONTEXT
{{productContext}}

# WINNING AD SCRIPT
{{scriptText}}

# OUTPUT (JSON only, no markdown, no backticks, no explanation)
{
  "emotional_arc": {
    "at_hook": "what the viewer feels in the first 1-3 seconds",
    "after_problem": "emotional state once the problem is presented",
    "during_explanation": "how the viewer feels as the mechanism/solution unfolds",
    "at_proof": "emotional response to the credibility moment",
    "before_cta": "emotional state right before the call to action",
    "final_state": "the emotion the viewer is left with"
  },
  "hooks": [
    {
      "text": "exact hook text from the ad",
      "hook_type": "curiosity / warning / contrarian / shock / story / authority / social proof / pattern interrupt",
      "scroll_stop_mechanism": "what specifically makes someone stop scrolling",
      "emotional_trigger": "the emotion activated by this hook",
      "why_it_works": "1 sentence on why this hook is effective",
      "strength": 8
    }
  ],
  "hook_patterns": {
    "shared_patterns": "what patterns all hooks share",
    "must_not_change": "what must stay fixed in any new hook variation"
  },
  "audience": {
    "who_is_this_for": "specific description of the target viewer",
    "what_they_already_believe": "existing beliefs the ad leverages",
    "what_they_are_skeptical_about": "doubts or objections they carry",
    "awareness_stage": "unaware / problem-aware / solution-aware / product-aware / most-aware",
    "implicit_objection_handled": "the objection the ad addresses without stating it directly",
    "product_alignment": "how well the ad matches the product profile's target customer"
  }
}

# RULES
- Describe FEELINGS, not content.
- Extract EXACT hook text. List every hook present.
- Cross-reference audience against the product profile.`,
    },
    iterationRules: {
      system: 'You are a senior creative director specializing in direct-response ad iteration for a media buying team.',
      user: `# TASK
Define the precise boundaries for iteration — what MUST stay fixed, what CAN be varied, and what is HIGH-RISK to change. This output directly constrains the script generator.

# PRODUCT CONTEXT
{{productContext}}

# WINNING AD SCRIPT
{{scriptText}}

# OUTPUT (JSON only, no markdown, no backticks, no explanation)
{
  "must_stay_fixed": ["list of elements that must NOT change in any iteration"],
  "can_be_varied": ["list of elements safe to change"],
  "high_risk_changes": ["list of changes that could break the ad"],
  "safe_iteration_directions": ["specific creative directions that would produce strong variations"],
  "hook_rules": {
    "must_preserve": "what every new hook must achieve",
    "safe_variations": "specific hook reframing ideas that maintain the core mechanism",
    "avoid": "hook approaches that would disconnect from the body"
  },
  "tone_boundaries": {
    "current_register": "the tone of the original",
    "acceptable_range": "how far the tone can shift",
    "never_do": "tone shifts that would break the ad"
  },
  "compliance_notes": "any claims that must stay within product profile compliance restrictions"
}

# RULES
- Be specific to THIS ad. Generic advice is useless.
- Think like a creative director briefing a copywriter.
- Keep each array item to ONE SHORT sentence (under 20 words). Be concise.
- If the product profile has compliance restrictions, flag any original claims that are borderline.`,
    },
    scriptClone: {
      system: `You are a world-class direct-response copywriter who specializes in script adaptation.

Your job is NOT to write new ads. Your job is to CLONE a competitor's proven ad script and adapt it for a different product — preserving every structural and psychological element that makes the original convert.

You think like a performance creative strategist: you understand that winning ads work because of their STRUCTURE, PACING, EMOTIONAL FLOW, and FRAMEWORK — not because of the specific product they sell. A winning format can be transplanted to any product if the adaptation is done with surgical precision.

HOW YOU WRITE:
- You write like a real human media buyer talks — raw, direct, conversational
- You NEVER sound like ChatGPT or a marketing agency. No filler phrases, no corporate jargon, no "imagine a world where", no "in today's fast-paced world"
- You match the voice and energy of the original script exactly
- Short punchy sentences when the original uses them. Long flowing paragraphs when the original uses those
- You use the same level of aggression, the same register, the same "feel" as the original
- If the original sounds like a guy on TikTok ranting, your clone sounds like a guy on TikTok ranting
- If the original sounds like a calm authority figure, your clone sounds like a calm authority figure
- You NEVER add disclaimers, hedging language, or soften the copy unless the original does the same`,
      user: `# YOUR MISSION

You are cloning a competitor's winning ad script for a DIFFERENT product. The original script sells a competitor's product. Your job is to create an adapted version that sells OUR product while keeping EVERYTHING that makes the original script convert.

Think of this like a movie remake: same plot structure, same emotional beats, same pacing, same twist — but with a different cast and setting.

# WHAT "1:1 CLONE" MEANS

A 1:1 clone is NOT:
- A summary of the original
- An "inspired by" rewrite
- A generic ad using similar themes
- A script that "captures the spirit" of the original

A 1:1 clone IS:
- The SAME number of sections in the SAME order
- The SAME rhetorical devices at the SAME structural points
- The SAME emotional beats hitting at the SAME moments
- The SAME pacing and rhythm (short/long sentence patterns match)
- The SAME hook framework (if they apologize, you apologize; if they confess, you confess; if they challenge, you challenge)
- The SAME word count (±10% tolerance)
- Every sentence in the original maps to a sentence in the clone that serves the IDENTICAL PURPOSE

The ONLY things that change:
- Product name, features, and specific claims → swapped to OUR product
- Competitor-specific details → replaced with equivalent details for our product
- Exact phrasing → rephrased to avoid plagiarism (but same point, same energy, same purpose)

# OUR PRODUCT — USE THIS CONTEXT TO ADAPT ALL PRODUCT REFERENCES
{{productContext}}

# ORIGINAL COMPETITOR SCRIPT (THIS IS WHAT YOU ARE CLONING)
Hooks: {{originalHooks}}
Body: {{originalBody}}
CTA: {{originalCta}}

# DEEP ANALYSIS OF THE ORIGINAL
{{analysisContext}}

# CLONE EXECUTION RULES

## RULE 1: PARAGRAPH-BY-PARAGRAPH MAPPING
- Read the original body. Count the paragraphs/sections.
- Your clone MUST have the same number of paragraphs/sections.
- For each paragraph in the original, write a corresponding paragraph that:
  → Makes the SAME point
  → Uses the SAME rhetorical device (if any)
  → Hits the SAME emotional note
  → Is roughly the SAME length (±15% words)
  → Sits in the SAME position in the script

## RULE 2: HOOK CLONING
- Generate exactly 3 hooks.
- All 3 hooks MUST use the SAME FRAMEWORK as the original hooks.
- If original hooks are confession/apology → your hooks are confession/apology about OUR product
- If original hooks are shocking stat → your hooks are shocking stat about OUR product
- If original hooks are contrarian claim → your hooks are contrarian claim about OUR product
- H1: Closest energy match to the original's strongest hook. Tightest clone.
- H2: Same framework, slightly different angle of entry. Still a clone.
- H3: Same framework, different emotional texture. Still recognizably the same format.
- Every hook MUST read naturally into the body. Hook + first body paragraph = seamless flow.

## RULE 3: PRODUCT SWAP PROTOCOL
- Every mention of the competitor's product → replace with our product name and details
- Every competitor benefit claim → find the EQUIVALENT benefit from our product profile and swap
- Every competitor-specific proof point → replace with equivalent proof from our product
- Every competitor price/offer → replace with our price/offer
- If the original mentions a specific ingredient/feature → find our closest equivalent
- If no equivalent exists, use the closest relevant feature that serves the same persuasive purpose
- NEVER leave competitor references in the final script
- NEVER invent claims not supported by the product profile

## RULE 4: TONE LOCK
- Read the original script out loud in your mind. Note the energy.
- Is it angry? Excited? Calm? Conspiratorial? Friendly? Aggressive?
- Your clone MUST match that exact energy.
- If the original uses slang → use slang
- If the original uses data → use data
- If the original is raw and emotional → be raw and emotional
- If the original is measured and authoritative → be measured and authoritative
- NEVER default to "marketing copy" voice. NEVER.

## RULE 5: LENGTH CONTROL
- Count the words in the original body.
- Your clone body must be within ±10% of that word count.
- If original is 400 words, your clone is 360-440 words.
- This is a HARD CONSTRAINT. Do not write a 200-word clone of a 500-word script.

## RULE 6: ANTI-AI DETECTION
- No sentences starting with "Imagine...", "Picture this...", "In a world where...", "What if I told you..."
- No filler transitions: "But here's the thing", "Now here's where it gets interesting", "And that's not all"
- No listicle formatting unless the original uses it
- No over-explaining. If the original makes a bold claim and moves on, you make a bold claim and move on.
- Use contractions: "don't", "can't", "won't", "it's", "that's", "here's"
- Use sentence fragments where the original does
- Vary sentence length naturally — mix 4-word punches with 20-word flowing sentences
- Include verbal tics and natural speech patterns: "Look,", "Listen,", "I mean,", "Honestly,", "The truth is,", "Here's the deal"
- Write like you're talking to ONE person, not an audience

## RULE 7: CTA CLONING
- Match the CTA structure of the original
- If the original CTA is urgent → your CTA is urgent
- If the original CTA includes a specific offer → include our equivalent offer
- If the original CTA is soft/curiosity-based → keep yours soft/curiosity-based
- Swap product/link references to ours

Return ONLY valid JSON, no markdown fences, no explanation:
{
  "hooks": [
    { "id": "H1", "text": "closest clone of original's strongest hook", "framework_used": "must match original", "maps_to_original": "which hook this clones" },
    { "id": "H2", "text": "same framework, different entry angle", "framework_used": "same", "maps_to_original": "which hook" },
    { "id": "H3", "text": "same framework, different emotional texture", "framework_used": "same", "maps_to_original": "which hook" }
  ],
  "body": "full cloned body, same paragraph count as original, 1:1 mapping",
  "cta": "cloned call-to-action",
  "clone_fidelity": { "original_word_count": 0, "clone_word_count": 0, "original_sections": 0, "clone_sections": 0, "framework_match": "what was preserved", "product_swaps_made": "what changed" },
  "key_adaptations": "2-3 sentences on product-specific changes",
  "emotional_arc": "hook → middle → close (must match original)"
}`,
    },
    generator: {
      system: `You are a senior direct-response copywriter specialized in Facebook and TikTok ad iteration.

You understand that the goal is NOT to create new ads, but to generate variations of a proven winner while preserving its psychological mechanism, persuasive structure, and conversion logic.

You write like a human performance marketer — not like an AI, not like a brand copywriter.`,
      user: `# OBJECTIVE
Generate a high-quality iteration of a winning ad script.

This iteration must:
- Preserve the original angle and mechanism
- Follow the same narrative flow
- Maintain the same emotional journey
- Use completely new wording, phrasing, and sentence structures
- The 3 hooks must blend PERFECTLY with the body

# PRODUCT CONTEXT
{{productContext}}

# ORIGINAL WINNING SCRIPT
{{originalScript}}

# DEEP ANALYSIS
{{analysisContext}}

# ITERATION DIRECTION
{{iterationDirection}}

# ITERATION RULES

## STRUCTURAL SKELETON PRESERVATION (MOST IMPORTANT RULE)
- Your iteration MUST follow the SAME section-by-section flow as the original.
- If the original uses a confession/apology hook framework, your hooks MUST also use confession/apology.
- If the original uses repetition patterns, your iteration MUST use an equivalent repetition pattern — different words, SAME device.
- If the original has a twist/reveal moment, your iteration MUST have a twist/reveal at the same structural point.
- Every rhetorical device listed in the skeleton must appear in your iteration.

## Hook Generation — REPHRASE the original hooks, don't invent new ones
- Generate 3 hooks that are VARIATIONS of the original hooks — same framework, same emotional trigger, different words
- Each hook must BLEND PERFECTLY with the body
- The hook framework is NON-NEGOTIABLE. Only the specific words change.

## Body Generation — SECTION-BY-SECTION REPHRASING (NOT rewriting)
- Go through the original body paragraph by paragraph, section by section
- For EACH section of the original, write the EQUIVALENT section in your iteration
- Same point. Same purpose. Same position in the script. Different words.
- Do NOT add new sections or remove existing ones
- Think of it like re-recording the same speech with different word choices

## HARD CONSTRAINTS
- Do NOT introduce new claims not supported by the product profile
- Do NOT change product positioning
- Do NOT simplify to the point of losing persuasion
- Be aggressive and direct to consumer — the goal is to convert cold traffic
- AWARENESS LEVEL LOCK: Target the same market awareness stage as the original

Return ONLY valid JSON:
{
  "hooks": [
    { "id": "H1", "text": "hook text", "mechanism": "curiosity/pain/contrarian", "scroll_stop_reason": "why someone stops" },
    { "id": "H2", "text": "...", "mechanism": "...", "scroll_stop_reason": "..." },
    { "id": "H3", "text": "...", "mechanism": "...", "scroll_stop_reason": "..." }
  ],
  "body": "the full body script with natural paragraph breaks",
  "cta": "the call-to-action text",
  "word_count": number,
  "estimated_seconds": number,
  "key_changes_from_original": "2-3 sentence summary",
  "emotional_arc": "hook_emotion → middle_emotion → close_emotion"
}`,
    },
    scorer: {
      system: 'You are a performance media buyer who has spent $50M+ on paid social. You evaluate ad scripts purely on their likelihood to convert cold traffic. You are ruthlessly honest — most scripts are mediocre.',
      user: `PRODUCT CONTEXT:
{{productContext}}

ORIGINAL WINNING SCRIPT (baseline):
{{originalScript}}

ORIGINAL PERFORMANCE:
{{performanceData}}

{{iterationRules}}

GENERATED BRIEF:
{{generatedBrief}}

ITERATION DIRECTION: {{directionName}}

Score this brief on 5 dimensions (1-10 scale):

1. NOVELTY (1-10): How different is this from the original?
2. AGGRESSION (1-10): How bold are the claims and hooks?
3. COHERENCE (1-10): Does the script flow? Is the logic chain tight?
4. HOOK-BODY BLEND (1-10): Do ALL 3 hooks flow naturally into the body?
5. CONVERSION POTENTIAL (1-10): Will this actually convert cold traffic?

Also check:
- Did the iteration respect the "must stay fixed" elements? Flag any violations.
- Did it make any "high-risk changes"? Flag them.
- Are all product claims accurate per the product context?
- Does it maintain the same market awareness level as the original?

Return ONLY valid JSON:
{
  "novelty": { "score": 7, "reason": "one sentence" },
  "aggression": { "score": 8, "reason": "one sentence" },
  "coherence": { "score": 6, "reason": "one sentence" },
  "hook_body_blend": { "score": 8, "reason": "one sentence" },
  "conversion_potential": { "score": 7, "reason": "one sentence" },
  "overall": 7.0,
  "verdict": "SHIP" | "MAYBE" | "KILL",
  "rule_violations": [],
  "one_line_feedback": "what's strong and what's weak",
  "suggested_improvement": "optional fix if verdict is MAYBE"
}`,
    },
    blendValidator: {
      system: 'You are a continuity editor for direct response ad scripts. Your ONLY job is to check if hooks flow naturally into the body.',
      user: `Read each hook below, then immediately read the body's opening. Judge if they sound like one continuous script written by the same person.

{{hookBodyPairs}}

For each hook, return:
- blend_score (1-10): 1 = jarring disconnect, 10 = perfectly seamless
- issue: null if score >= 7, otherwise describe the disconnect
- fix_suggestion: null if score >= 7, otherwise suggest a fix

Return ONLY valid JSON:
{
  "hooks": [
    { "id": 1, "blend_score": 8, "issue": null, "fix_suggestion": null }
  ],
  "overall_blend": 7.3,
  "pass": true
}

A brief PASSES if overall_blend >= 6.5.`,
    },
  };
}

// GET /settings/prompts — return custom prompts or defaults
router.get('/settings/prompts', authenticate, async (_req, res) => {
  try {
    const custom = await getCustomPrompts();
    const defaults = getDefaultPrompts();
    res.json({
      success: true,
      promptTypes: PROMPT_TYPES,
      defaults,
      custom: custom || {},
      hasCustom: !!custom,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// PUT /settings/prompts — save custom prompts
router.put('/settings/prompts', authenticate, async (req, res) => {
  try {
    const { prompts } = req.body;
    if (!prompts || typeof prompts !== 'object') {
      return res.status(400).json({ success: false, error: { message: 'prompts object is required' } });
    }
    await pgQuery(
      `INSERT INTO system_settings (key, value, description)
       VALUES ('brief_pipeline_prompts', $1, 'Custom prompts for the Brief Pipeline agents')
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [JSON.stringify(prompts)]
    );
    // Invalidate cache
    customPromptsCache = { data: prompts, timestamp: Date.now() };
    res.json({ success: true, message: 'Prompts saved' });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /settings/prompts/reset — delete custom prompts, restore defaults
router.post('/settings/prompts/reset', authenticate, async (_req, res) => {
  try {
    await pgQuery(`DELETE FROM system_settings WHERE key = 'brief_pipeline_prompts'`);
    customPromptsCache = { data: null, timestamp: 0 };
    res.json({ success: true, message: 'Prompts reset to defaults' });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// LAUNCH TEMPLATES & COPY SETS
// ═══════════════════════════════════════════════════════════════════════

let launchTablesPromise = null;
async function ensureLaunchTables() {
  if (launchTablesPromise) return launchTablesPromise;
  launchTablesPromise = _initLaunchTables().catch(err => {
    launchTablesPromise = null;
    throw err;
  });
  return launchTablesPromise;
}
async function _initLaunchTables() {
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS launch_templates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      ad_account_id TEXT NOT NULL,
      ad_account_name TEXT,
      page_mode TEXT DEFAULT 'single',
      page_ids JSONB DEFAULT '[]',
      pixel_id TEXT,
      pixel_name TEXT,
      campaign_id TEXT,
      campaign_name TEXT,
      adset_name_pattern TEXT DEFAULT '{date} - {angle} - Batch {batch}',
      ad_name_pattern TEXT DEFAULT '{date} - {angle} {num}',
      conversion_location TEXT DEFAULT 'WEBSITE',
      conversion_event TEXT DEFAULT 'PURCHASE',
      daily_budget NUMERIC(10,2) DEFAULT 150,
      performance_goal TEXT DEFAULT 'OFFSITE_CONVERSIONS',
      optimization_goal TEXT DEFAULT 'OFFSITE_CONVERSIONS',
      bid_strategy TEXT DEFAULT 'LOWEST_COST_WITHOUT_CAP',
      target_roas NUMERIC(6,2),
      attribution_window TEXT DEFAULT '7d_click',
      include_audiences JSONB DEFAULT '[]',
      exclude_audiences JSONB DEFAULT '[]',
      countries JSONB DEFAULT '["US"]',
      age_min INTEGER DEFAULT 18,
      age_max INTEGER DEFAULT 65,
      gender TEXT DEFAULT 'all',
      ad_format TEXT DEFAULT 'FLEXIBLE',
      utm_parameters TEXT DEFAULT 'tw_source={{site_source_name}}&tw_adid={{ad.id}}',
      landing_page_url TEXT,
      translation_languages JSONB DEFAULT '[]',
      product_id INTEGER,
      is_default BOOLEAN DEFAULT false,
      created_by UUID,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Migration for existing tables
  await pgQuery(`ALTER TABLE launch_templates ADD COLUMN IF NOT EXISTS landing_page_url TEXT`).catch(() => {});
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS brief_copy_sets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id INTEGER,
      angle TEXT NOT NULL,
      primary_texts JSONB DEFAULT '[]',
      headlines JSONB DEFAULT '[]',
      descriptions JSONB DEFAULT '[]',
      cta_button TEXT DEFAULT 'SHOP_NOW',
      landing_page_url TEXT,
      utm_parameters TEXT DEFAULT 'tw_source={{site_source_name}}&tw_adid={{ad.id}}',
      created_by UUID,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS brief_launches (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      brief_id UUID,
      template_id UUID,
      copy_set_id UUID,
      ad_account_id TEXT,
      meta_campaign_id TEXT,
      meta_adset_id TEXT,
      meta_ad_id TEXT,
      meta_creative_id TEXT,
      ad_name TEXT,
      adset_name TEXT,
      page_id TEXT,
      page_name TEXT,
      batch_number INTEGER,
      status TEXT DEFAULT 'pending',
      error_message TEXT,
      launched_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgQuery(`CREATE UNIQUE INDEX IF NOT EXISTS idx_copy_sets_product_angle ON brief_copy_sets(product_id, angle)`).catch(() => {});
  // Add launch columns to generated table
  await pgQuery(`ALTER TABLE brief_pipeline_generated ADD COLUMN IF NOT EXISTS launched_at TIMESTAMPTZ`).catch(() => {});
  await pgQuery(`ALTER TABLE brief_pipeline_generated ADD COLUMN IF NOT EXISTS launch_error TEXT`).catch(() => {});
  await pgQuery(`ALTER TABLE brief_pipeline_generated ADD COLUMN IF NOT EXISTS meta_ad_ids JSONB DEFAULT '[]'`).catch(() => {});
}

// ── Meta API Proxy Endpoints ───────────────────────────────────────────

router.get('/meta/accounts', authenticate, async (_req, res) => {
  try {
    if (!isMetaAdsConfigured()) return res.json({ success: true, data: [] });
    const accounts = await getAdAccounts();
    res.json({ success: true, data: accounts });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.get('/meta/pages/:accountId', authenticate, async (req, res) => {
  try {
    const pages = await getPages(req.params.accountId);
    res.json({ success: true, data: pages });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.get('/meta/pixels/:accountId', authenticate, async (req, res) => {
  try {
    const pixels = await getPixels(req.params.accountId);
    res.json({ success: true, data: pixels });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.get('/meta/campaigns/:accountId', authenticate, async (req, res) => {
  try {
    const campaigns = await getCampaigns(req.params.accountId);
    res.json({ success: true, data: campaigns });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.get('/meta/adsets/:campaignId', authenticate, async (req, res) => {
  try {
    const adsets = await getAdSets(req.params.campaignId);
    res.json({ success: true, data: adsets });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.get('/meta/audiences/:accountId', authenticate, async (req, res) => {
  try {
    const audiences = await getCustomAudiences(req.params.accountId);
    res.json({ success: true, data: audiences });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// Sync all Meta data for an ad account at once (used by template editor)
router.get('/meta/sync/:accountId', authenticate, async (req, res) => {
  try {
    const accountId = req.params.accountId;
    const [pages, pixels, campaigns, audiences] = await Promise.all([
      getPages(accountId).catch(e => { console.error('Sync pages error:', e.message); return []; }),
      getPixels(accountId).catch(e => { console.error('Sync pixels error:', e.message); return []; }),
      getCampaigns(accountId).catch(e => { console.error('Sync campaigns error:', e.message); return []; }),
      getCustomAudiences(accountId).catch(e => { console.error('Sync audiences error:', e.message); return []; }),
    ]);
    console.log(`Sync ${accountId}: ${pages.length} pages, ${pixels.length} pixels, ${campaigns.length} campaigns, ${audiences.length} audiences`);
    res.json({ success: true, data: { pages, pixels, campaigns, audiences } });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Launch Template CRUD ───────────────────────────────────────────────

router.get('/launch-templates', authenticate, async (req, res) => {
  try {
    await ensureLaunchTables();
    const { product_id } = req.query;
    let query = 'SELECT * FROM launch_templates';
    const params = [];
    if (product_id) {
      query += ' WHERE product_id = $1';
      params.push(product_id);
    }
    query += ' ORDER BY is_default DESC, updated_at DESC';
    const rows = await pgQuery(query, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.get('/launch-templates/:id', authenticate, async (req, res) => {
  try {
    await ensureLaunchTables();
    const rows = await pgQuery('SELECT * FROM launch_templates WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, error: { message: 'Template not found' } });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.post('/launch-templates', authenticate, async (req, res) => {
  try {
    await ensureLaunchTables();
    const t = req.body;
    // Helper: ensure value is a proper JS array (not a string) for JSONB columns
    const ensureArr = (v, fallback = []) => {
      if (Array.isArray(v)) return v;
      if (typeof v === 'string') { try { let p = JSON.parse(v); if (typeof p === 'string') p = JSON.parse(p); return Array.isArray(p) ? p : fallback; } catch { return fallback; } }
      return fallback;
    };
    const rows = await pgQuery(
      `INSERT INTO launch_templates (
        name, ad_account_id, ad_account_name, page_mode, page_ids,
        pixel_id, pixel_name, campaign_id, campaign_name,
        adset_name_pattern, ad_name_pattern,
        conversion_location, conversion_event,
        daily_budget, performance_goal, optimization_goal, bid_strategy, target_roas,
        attribution_window, include_audiences, exclude_audiences,
        countries, age_min, age_max, gender, ad_format, utm_parameters,
        landing_page_url, translation_languages, product_id, is_default, created_by
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32
      ) RETURNING *`,
      [
        t.name, t.ad_account_id, t.ad_account_name, t.page_mode || 'single',
        JSON.stringify(ensureArr(t.page_ids)),
        t.pixel_id, t.pixel_name, t.campaign_id, t.campaign_name,
        t.adset_name_pattern || '{date} - {angle} - Batch {batch}',
        t.ad_name_pattern || '{date} - {angle} {num}',
        t.conversion_location || 'WEBSITE', t.conversion_event || 'PURCHASE',
        t.daily_budget || 150, t.performance_goal || 'OFFSITE_CONVERSIONS',
        t.optimization_goal || 'OFFSITE_CONVERSIONS',
        t.bid_strategy || 'LOWEST_COST_WITHOUT_CAP', t.target_roas || null,
        t.attribution_window || '7d_click',
        JSON.stringify(ensureArr(t.include_audiences)), JSON.stringify(ensureArr(t.exclude_audiences)),
        JSON.stringify(ensureArr(t.countries, ['US'])), t.age_min || 18, t.age_max || 65,
        t.gender || 'all', t.ad_format || 'FLEXIBLE', t.utm_parameters || '',
        t.landing_page_url || null,
        JSON.stringify(ensureArr(t.translation_languages)),
        t.product_id || null, t.is_default || false, req.user?.id || null
      ]
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.put('/launch-templates/:id', authenticate, async (req, res) => {
  try {
    await ensureLaunchTables();
    const t = req.body;
    const ensureArr = (v, fallback = []) => {
      if (Array.isArray(v)) return v;
      if (typeof v === 'string') { try { let p = JSON.parse(v); if (typeof p === 'string') p = JSON.parse(p); return Array.isArray(p) ? p : fallback; } catch { return fallback; } }
      return fallback;
    };
    const rows = await pgQuery(
      `UPDATE launch_templates SET
        name=$1, ad_account_id=$2, ad_account_name=$3, page_mode=$4, page_ids=$5,
        pixel_id=$6, pixel_name=$7, campaign_id=$8, campaign_name=$9,
        adset_name_pattern=$10, ad_name_pattern=$11,
        conversion_location=$12, conversion_event=$13,
        daily_budget=$14, performance_goal=$15, optimization_goal=$16, bid_strategy=$17, target_roas=$18,
        attribution_window=$19, include_audiences=$20, exclude_audiences=$21,
        countries=$22, age_min=$23, age_max=$24, gender=$25, ad_format=$26, utm_parameters=$27,
        landing_page_url=$28, translation_languages=$29, product_id=$30, is_default=$31, updated_at=NOW()
      WHERE id=$32 RETURNING *`,
      [
        t.name, t.ad_account_id, t.ad_account_name, t.page_mode || 'single',
        JSON.stringify(ensureArr(t.page_ids)),
        t.pixel_id, t.pixel_name, t.campaign_id, t.campaign_name,
        t.adset_name_pattern, t.ad_name_pattern,
        t.conversion_location, t.conversion_event,
        t.daily_budget, t.performance_goal, t.optimization_goal,
        t.bid_strategy, t.target_roas || null,
        t.attribution_window,
        JSON.stringify(ensureArr(t.include_audiences)), JSON.stringify(ensureArr(t.exclude_audiences)),
        JSON.stringify(ensureArr(t.countries, ['US'])), t.age_min, t.age_max,
        t.gender, t.ad_format, t.utm_parameters,
        t.landing_page_url || null,
        JSON.stringify(ensureArr(t.translation_languages)),
        t.product_id || null, t.is_default || false, req.params.id
      ]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: { message: 'Template not found' } });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.delete('/launch-templates/:id', authenticate, async (req, res) => {
  try {
    await ensureLaunchTables();
    const rows = await pgQuery('DELETE FROM launch_templates WHERE id = $1 RETURNING id', [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, error: { message: 'Template not found' } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Copy Sets CRUD ─────────────────────────────────────────────────────

router.get('/copy-sets', authenticate, async (req, res) => {
  try {
    await ensureLaunchTables();
    const { product_id } = req.query;
    let query = 'SELECT * FROM brief_copy_sets';
    const params = [];
    if (product_id) {
      query += ' WHERE product_id = $1';
      params.push(product_id);
    }
    query += ' ORDER BY angle ASC';
    const rows = await pgQuery(query, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.post('/copy-sets', authenticate, async (req, res) => {
  try {
    await ensureLaunchTables();
    const c = req.body;
    const rows = await pgQuery(
      `INSERT INTO brief_copy_sets (product_id, angle, primary_texts, headlines, descriptions, cta_button, landing_page_url, utm_parameters, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        c.product_id, c.angle,
        JSON.stringify(c.primary_texts || []),
        JSON.stringify(c.headlines || []),
        JSON.stringify(c.descriptions || []),
        c.cta_button || 'SHOP_NOW',
        c.landing_page_url || '',
        c.utm_parameters || 'tw_source={{site_source_name}}&tw_adid={{ad.id}}',
        req.user?.id || null
      ]
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    if (err.message.includes('idx_copy_sets_product_angle')) {
      return res.status(409).json({ success: false, error: { message: `A copy set for angle "${req.body.angle}" already exists` } });
    }
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.put('/copy-sets/:id', authenticate, async (req, res) => {
  try {
    await ensureLaunchTables();
    const c = req.body;
    const rows = await pgQuery(
      `UPDATE brief_copy_sets SET angle=$1, primary_texts=$2, headlines=$3, descriptions=$4, cta_button=$5, landing_page_url=$6, utm_parameters=$7, updated_at=NOW()
       WHERE id=$8 RETURNING *`,
      [
        c.angle,
        JSON.stringify(c.primary_texts || []),
        JSON.stringify(c.headlines || []),
        JSON.stringify(c.descriptions || []),
        c.cta_button || 'SHOP_NOW',
        c.landing_page_url || '',
        c.utm_parameters || '',
        req.params.id
      ]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: { message: 'Copy set not found' } });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.delete('/copy-sets/:id', authenticate, async (req, res) => {
  try {
    await ensureLaunchTables();
    const rows = await pgQuery('DELETE FROM brief_copy_sets WHERE id = $1 RETURNING id', [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, error: { message: 'Copy set not found' } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Launch Briefs to Meta ──────────────────────────────────────────────

function buildLaunchName(pattern, vars) {
  let result = pattern;
  for (const [key, val] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), val || '');
  }
  return result.trim();
}

router.post('/launch', authenticate, async (req, res) => {
  try {
    await ensureLaunchTables();
    if (!isMetaAdsConfigured()) {
      return res.status(400).json({ success: false, error: { message: 'Meta Ads API not configured' } });
    }

    const { brief_ids, template_id, copy_set_id } = req.body;
    if (!brief_ids?.length || !template_id) {
      return res.status(400).json({ success: false, error: { message: 'brief_ids and template_id are required' } });
    }

    // Load template
    const templates = await pgQuery('SELECT * FROM launch_templates WHERE id = $1', [template_id]);
    if (!templates.length) return res.status(404).json({ success: false, error: { message: 'Template not found' } });
    const template = templates[0];

    if (!template.campaign_id) {
      return res.status(400).json({ success: false, error: { message: 'Template has no campaign configured. Please edit the template and select a campaign.' } });
    }

    // Load copy set if provided
    let copySet = null;
    if (copy_set_id) {
      const cs = await pgQuery('SELECT * FROM brief_copy_sets WHERE id = $1', [copy_set_id]);
      if (!cs.length) return res.status(404).json({ success: false, error: { message: 'Copy set not found' } });
      copySet = cs[0];
    }

    // Load briefs
    const briefs = await pgQuery(
      `SELECT * FROM brief_pipeline_generated WHERE id = ANY($1) AND status IN ('approved', 'ready_to_launch')`,
      [brief_ids]
    );
    if (!briefs.length) {
      return res.status(400).json({ success: false, error: { message: 'No launchable briefs found' } });
    }

    // Mark briefs as launching
    await pgQuery(
      `UPDATE brief_pipeline_generated SET status = 'launching' WHERE id = ANY($1)`,
      [brief_ids]
    );

    const dateStr = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' }).replace('/', '');
    const batchNum = Math.floor(Date.now() / 1000) % 10000;
    const results = [];

    // Round-robin page selection
    const selectedPages = (template.page_ids || []).filter(p => p.selected !== false);
    let pageIdx = 0;

    // Create ad set for this batch
    let adsetId = null;
    let adsetName = '';
    {
      adsetName = buildLaunchName(template.adset_name_pattern, {
        date: dateStr,
        angle: briefs[0]?.angle || 'General',
        batch: batchNum,
        product: briefs[0]?.product_code || '',
      });

      try {
        adsetId = await createAdSet(template.ad_account_id, {
          name: adsetName,
          campaignId: template.campaign_id,
          dailyBudget: template.daily_budget,
          optimizationGoal: template.optimization_goal,
          bidStrategy: template.bid_strategy,
          targetRoas: template.target_roas,
          pixelId: template.pixel_id,
          conversionEvent: template.conversion_event,
          conversionLocation: template.conversion_location,
          targeting: {
            countries: template.countries || ['US'],
            age_min: template.age_min,
            age_max: template.age_max,
            gender: template.gender,
            include_audiences: template.include_audiences || [],
            exclude_audiences: template.exclude_audiences || [],
          },
          attributionWindow: template.attribution_window,
          pageId: selectedPages[0]?.id,
          status: 'PAUSED',
        });
      } catch (err) {
        await pgQuery(
          `UPDATE brief_pipeline_generated SET status = 'launch_failed', launch_error = $1 WHERE id = ANY($2)`,
          [`Ad set creation failed: ${err.message}`, brief_ids]
        );
        return res.status(500).json({ success: false, error: { message: `Ad set creation failed: ${err.message}` } });
      }
    }

    // Launch each brief as an ad
    for (let i = 0; i < briefs.length; i++) {
      const brief = briefs[i];
      const launchId = crypto.randomUUID();

      // Pick page (round-robin)
      const page = selectedPages.length ? selectedPages[pageIdx % selectedPages.length] : null;
      pageIdx++;

      const adName = buildLaunchName(template.ad_name_pattern, {
        date: dateStr,
        angle: brief.angle || 'General',
        num: i + 1,
        batch: batchNum,
        product: brief.product_code || '',
      });

      try {
        await pgQuery(
          `INSERT INTO brief_launches (id, brief_id, template_id, copy_set_id, ad_account_id, meta_campaign_id, meta_adset_id, ad_name, adset_name, page_id, page_name, batch_number, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'uploading')`,
          [launchId, brief.id, template_id, copy_set_id || null, template.ad_account_id, template.campaign_id, adsetId, adName, adsetName, page?.id, page?.name, batchNum]
        );

        // Determine ad copy
        const primaryTexts = copySet?.primary_texts?.length
          ? copySet.primary_texts
          : [brief.body || brief.hooks?.[0]?.text || 'Check this out'];
        const headlines = copySet?.headlines?.length
          ? copySet.headlines
          : (brief.hooks || []).map(h => h.text).slice(0, 3);
        const descriptions = copySet?.descriptions?.length
          ? copySet.descriptions
          : [''];
        const cta = copySet?.cta_button || 'SHOP_NOW';
        const link = copySet?.landing_page_url || template.utm_parameters || '';

        // Create ad creative
        const creativeId = await createFlexibleAdCreative(template.ad_account_id, {
          name: adName,
          primaryTexts,
          headlines: headlines.length ? headlines : ['Shop Now'],
          descriptions,
          cta,
          link: link || 'https://mineblock.com',
          pageId: page?.id || selectedPages[0]?.id,
          utmParameters: template.utm_parameters,
        });

        // Create the ad
        const metaAdId = await createAd(template.ad_account_id, {
          name: adName,
          adsetId,
          creativeId,
          status: 'PAUSED',
        });

        // Update records
        await pgQuery(
          `UPDATE brief_launches SET status='launched', meta_ad_id=$1, meta_creative_id=$2, launched_at=NOW() WHERE id=$3`,
          [metaAdId, creativeId, launchId]
        );
        await pgQuery(
          `UPDATE brief_pipeline_generated SET status='launched', launched_at=NOW(),
           meta_ad_ids = COALESCE(meta_ad_ids, '[]'::jsonb) || $1::jsonb
           WHERE id=$2`,
          [JSON.stringify([metaAdId]), brief.id]
        );

        results.push({ brief_id: brief.id, status: 'launched', meta_ad_id: metaAdId, ad_name: adName });
      } catch (err) {
        await pgQuery(`UPDATE brief_launches SET status='failed', error_message=$1 WHERE id=$2`, [err.message, launchId]);
        await pgQuery(`UPDATE brief_pipeline_generated SET status='launch_failed', launch_error=$1 WHERE id=$2`, [err.message, brief.id]);
        results.push({ brief_id: brief.id, status: 'failed', error: err.message });
      }
    }

    res.json({ success: true, data: { results, adset_id: adsetId } });
  } catch (err) {
    console.error('[BriefPipeline] Launch error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /launch-history — launch history for briefs
router.get('/launch-history', authenticate, async (req, res) => {
  try {
    await ensureLaunchTables();
    const { brief_id } = req.query;
    let query = `SELECT bl.*, bg.angle, bg.body, bg.hooks, lt.name as template_name
                 FROM brief_launches bl
                 LEFT JOIN brief_pipeline_generated bg ON bg.id = bl.brief_id
                 LEFT JOIN launch_templates lt ON lt.id = bl.template_id`;
    const params = [];
    if (brief_id) {
      query += ' WHERE bl.brief_id = $1';
      params.push(brief_id);
    }
    query += ' ORDER BY bl.created_at DESC LIMIT 100';
    const rows = await pgQuery(query, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// PATCH /generated/:id — update status (extended for launch statuses)
// Already exists above, but we add ready_to_launch support

// ── Admin: Reset all winners back to detected ────────────────────────
router.post('/admin/reset-winners', authenticate, async (_req, res) => {
  try {
    await pgQuery(`UPDATE brief_pipeline_winners SET status = 'detected' WHERE status IN ('selected', 'generating', 'generated')`);
    await pgQuery(`DELETE FROM brief_pipeline_generated WHERE status = 'pushed'`);
    const rows = await pgQuery(`SELECT id, creative_id, status FROM brief_pipeline_winners ORDER BY detected_at DESC`);
    res.json({ success: true, message: 'All winners reset to detected', winners: rows });
  } catch (err) {
    console.error('[BriefPipeline] Reset error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

export default router;
