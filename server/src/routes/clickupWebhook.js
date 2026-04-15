import { Router } from 'express';
import logger from '../utils/logger.js';
import { pgQuery } from '../db/pg.js';

const router = Router();

// ClickUp API config
const CLICKUP_TOKEN = process.env.CLICKUP_API_TOKEN || '';
const CLICKUP_API = 'https://api.clickup.com/api/v2';
const TEAM_ID = '90152075024';

// Frame.io config
const FRAMEIO_TOKEN = process.env.FRAMEIO_TOKEN || '';
const FRAMEIO_PROJECT_ID = '19c0ce1f-f357-4da8-ba1f-bd7eb201e660';
const FRAMEIO_EDITING_FOLDER = '2eb1701e-fd39-45fa-a981-947a565f9093'; // "Video Ads Pipeline" folder
const FRAMEIO_API = 'https://api.frame.io/v2';

// List IDs
const MEDIA_BUYING_LIST = '901518769621';
const VIDEO_ADS_LIST = '901518716584';
const SYNC_LISTS = [VIDEO_ADS_LIST];
const NAMING_LISTS = [VIDEO_ADS_LIST];

// Statuses to sync
const SYNC_STATUSES = ['launched', 'ready to launch'];

// Custom field IDs for Video Ads list
const FIELD_IDS = {
  // Shared across both lists
  angle: '7e740c52-a05b-4b3b-9798-0801acd84b8a',
  briefType: '98d04d2d-9575-4363-8eee-9bf150b1c319',
  parentBriefId: '4f72235e-0a41-4824-9e67-d27e38ba16d9',
  editor: 'a9613cd9-715a-4a2a-bbbb-fbb7f664980a',
  creativeStrategist: '372d59af-e573-4eb4-be9f-31cb02f3ad5b',
  namingConvention: 'c97d93bc-ad82-4b90-98e0-092df383d9b8',
  creationWeek: 'a609d8d0-661e-400f-87cb-2557bd48857b',
  briefNumber: '62b61cc4-2d35-4dfc-86f4-a3913e2bbca3',
  // Video Ads only
  productVideo: '7bc3b414-363e-421e-9445-473b4b8ccf18',
  avatarVideo: '4ad59f88-89cc-45e5-bc56-0027a4ab8624',
  creativeType: 'b7f50dff-c752-47a7-830d-c3780021a27f',
  creator: 'be5a2a58-f355-4fac-8263-2824725eaa64',
};

// Dropdown index → label mappings
const ANGLE_MAP = {
  0: 'NA', 1: 'Lottery', 2: 'Againstcompetition', 3: 'BTCMadeeasy',
  4: 'GTRS', 5: 'livestream', 6: 'Hiddenopportunity', 7: 'Rebranding',
  8: 'Missedopportunity', 9: 'BTCFARM', 10: 'Sale', 11: 'Scarcity',
  12: 'Breakingnews', 13: 'Offer', 14: 'Reaction',
};

const BRIEF_TYPE_MAP = { 0: 'NN', 1: 'IT' };

const CREATIVE_TYPE_MAP = {
  0: 'Mashup', 1: 'ShortVid', 2: 'UGC', 3: 'VSL',
  4: 'MiniVSL', 5: 'LongVSL', 6: 'IMG', 7: 'GIF', 8: 'Cartoon',
};

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
    throw new Error(`ClickUp API error ${res.status}: ${text}`);
  }
  return res.json();
}

async function getTask(taskId) {
  return clickupFetch(`/task/${taskId}`);
}

async function updateTaskStatus(taskId, status) {
  return clickupFetch(`/task/${taskId}`, {
    method: 'PUT',
    body: JSON.stringify({ status }),
  });
}

async function updateTask(taskId, data) {
  return clickupFetch(`/task/${taskId}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

async function setCustomField(taskId, fieldId, value) {
  return clickupFetch(`/task/${taskId}/field/${fieldId}`, {
    method: 'POST',
    body: JSON.stringify({ value }),
  });
}

// Helper: get a custom field value from task by field ID
function getFieldValue(task, fieldId) {
  const field = task.custom_fields?.find((f) => f.id === fieldId);
  if (!field || field.value == null) return null;

  if (field.type === 'drop_down' && field.type_config?.options) {
    const idx = parseInt(field.value, 10);
    const opt = field.type_config.options.find((o) => o.orderindex === idx);
    return opt?.name || null;
  }

  // list_relationship: value is an array of linked task objects
  if (field.type === 'list_relationship' && Array.isArray(field.value)) {
    return field.value.map((t) => t.name).join(', ') || null;
  }

  // users: value is an array of user objects
  if (field.type === 'users' && Array.isArray(field.value)) {
    return field.value.map((u) => u.username?.split(' ')[0]).join(', ') || null;
  }

  return field.value;
}

// Get the current ISO week number and year
function getWeekLabel() {
  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const days = Math.floor((now - startOfYear) / 86400000);
  const weekNum = Math.ceil((days + startOfYear.getDay() + 1) / 7);
  const weekStr = String(weekNum).padStart(2, '0');
  return `WK${weekStr}_${now.getFullYear()}`;
}

// Scan all tasks in Video Ads list to find highest brief number
async function getNextBriefNumber() {
  let maxBrief = 0;
  let page = 0;
  let hasMore = true;

  while (hasMore) {
    const data = await clickupFetch(
      `/list/${VIDEO_ADS_LIST}/task?page=${page}&limit=100&include_closed=true&subtasks=true`,
    );
    const tasks = data.tasks || [];

    for (const task of tasks) {
      const briefField = task.custom_fields?.find((f) => f.id === FIELD_IDS.briefNumber);
      if (briefField?.value != null) {
        const num = parseInt(briefField.value, 10);
        if (!isNaN(num) && num > maxBrief) maxBrief = num;
      }
      // Also parse from task name as fallback (B0118 pattern)
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

// Generate naming convention from task custom fields
function generateNamingConvention(task, listId, briefNumber) {
  const product = getFieldValue(task, FIELD_IDS.productVideo) || 'NA';
  const parentBriefId = getFieldValue(task, FIELD_IDS.parentBriefId) || 'NA';

  // Brief ID always uses B prefix
  const briefId = `B${String(briefNumber).padStart(4, '0')}`;

  const angle = getFieldValue(task, FIELD_IDS.angle) || 'NA';
  const briefType = getFieldValue(task, FIELD_IDS.briefType) || 'NA';
  const creativeType = getFieldValue(task, FIELD_IDS.creativeType) || 'NA';
  const avatar = getFieldValue(task, FIELD_IDS.avatarVideo) || 'NA';
  const creator = getFieldValue(task, FIELD_IDS.creator) || 'NA';
  const editor = getFieldValue(task, FIELD_IDS.editor) || 'NA';
  const strategist = getFieldValue(task, FIELD_IDS.creativeStrategist) || 'NA';

  const week = getWeekLabel();

  // Format: Product - BriefID - BriefType - ParentBriefID - Avatar - Angle - CreativeType - CreativeStrategist - Creator - Editor - WKxx_yyyy
  const parts = [
    product, briefId, briefType, parentBriefId,
    avatar, angle, creativeType, strategist, creator, editor, week,
  ];

  return parts.map((p) => String(p).trim() || 'NA').join(' - ');
}

// ── Frame.io helpers ──────────────────────────────────────────────
const FRAMEIO_API_V4 = 'https://api.frame.io/v4';
const FRAMEIO_CLIENT_ID = process.env.FRAMEIO_CLIENT_ID || '';
const FRAMEIO_CLIENT_SECRET = process.env.FRAMEIO_CLIENT_SECRET || '';
const FRAMEIO_REDIRECT_URI = 'https://mineblock-dashboard.onrender.com/api/v1/webhook/frameio-oauth-callback';
const ADOBE_IMS_AUTHORIZE = 'https://ims-na1.adobelogin.com/ims/authorize/v2';
const ADOBE_IMS_TOKEN = 'https://ims-na1.adobelogin.com/ims/token/v3';

// In-memory cache to avoid hitting the DB on every API call
let v4TokenCache = { accessToken: null, expiresAt: 0 };

/**
 * Load the stored OAuth token set from system_settings.
 * Shape: { access_token, refresh_token, expires_at (ms epoch) }
 */
async function loadV4Tokens() {
  const rows = await pgQuery(
    "SELECT value FROM system_settings WHERE key = 'frameio_oauth'"
  );
  const raw = rows?.[0]?.value;
  if (!raw) return null;
  // postgres.js usually auto-parses JSONB but defend against either shape
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
  // Invalidate cache so the next request re-reads
  v4TokenCache = { accessToken: null, expiresAt: 0 };
}

/**
 * Refresh the v4 access token using the stored refresh_token.
 * Returns the new access_token, or throws if refresh failed.
 */
async function refreshV4Token() {
  const stored = await loadV4Tokens();
  if (!stored?.refresh_token) {
    throw new Error('No Frame.io refresh_token stored — visit /api/v1/webhook/frameio-oauth-start to authorize');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: stored.refresh_token,
    client_id: FRAMEIO_CLIENT_ID,
    client_secret: FRAMEIO_CLIENT_SECRET,
  });

  const res = await fetch(ADOBE_IMS_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Adobe IMS refresh failed ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  const newTokens = {
    access_token: json.access_token,
    // Adobe returns a new refresh_token if rotating; fall back to old one otherwise
    refresh_token: json.refresh_token || stored.refresh_token,
    expires_at: Date.now() + (json.expires_in || 86400) * 1000 - 60_000, // 1-min safety margin
    token_type: json.token_type || 'Bearer',
  };
  await saveV4Tokens(newTokens);
  return newTokens.access_token;
}

/**
 * Get a valid v4 access token — refreshes transparently if expired.
 */
async function getV4AccessToken() {
  if (v4TokenCache.accessToken && Date.now() < v4TokenCache.expiresAt) {
    return v4TokenCache.accessToken;
  }
  const stored = await loadV4Tokens();
  if (stored?.access_token && stored.expires_at && Date.now() < stored.expires_at) {
    v4TokenCache = { accessToken: stored.access_token, expiresAt: stored.expires_at };
    return stored.access_token;
  }
  const fresh = await refreshV4Token();
  const latest = await loadV4Tokens();
  v4TokenCache = { accessToken: fresh, expiresAt: latest.expires_at };
  return fresh;
}

async function frameioFetch(url, options = {}, baseUrl = FRAMEIO_API) {
  if (!FRAMEIO_TOKEN) {
    logger.warn('[ClickUp Webhook] FRAMEIO_TOKEN not set — skipping Frame.io integration');
    return null;
  }
  const res = await fetch(`${baseUrl}${url}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${FRAMEIO_TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Frame.io API error ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Fetch against Frame.io v4 using Adobe IMS OAuth (auto-refreshing token).
 * Falls back to the legacy FRAMEIO_TOKEN if no OAuth tokens are stored
 * (keeps the pre-OAuth codepath alive for v2-only endpoints).
 */
async function frameioFetchV4(url, options = {}) {
  const stored = await loadV4Tokens().catch(() => null);
  if (!stored?.refresh_token) {
    // No OAuth yet → fall through to legacy v2 token (will likely 401 on v4, but keeps old behavior)
    return frameioFetch(url, options, FRAMEIO_API_V4);
  }
  const accessToken = await getV4AccessToken();
  const res = await fetch(`${FRAMEIO_API_V4}${url}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (res.status === 401) {
    // Token may have been revoked server-side — force a refresh and retry once
    const refreshed = await refreshV4Token();
    const retry = await fetch(`${FRAMEIO_API_V4}${url}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${refreshed}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    if (!retry.ok) {
      const text = await retry.text();
      throw new Error(`Frame.io v4 API error ${retry.status}: ${text.slice(0, 300)}`);
    }
    return retry.status === 204 ? null : retry.json();
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Frame.io v4 API error ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

/**
 * Get the root folder ID of the Frame.io project.
 * The project's root_asset_id is the top-level folder.
 */
async function getProjectRootFolder() {
  const project = await frameioFetch(`/projects/${FRAMEIO_PROJECT_ID}`);
  return project?.root_asset_id || null;
}

/**
 * Create a subfolder in Frame.io and return its URL.
 * @param {string} parentFolderId — The parent folder asset ID
 * @param {string} folderName — Name for the new folder
 * @returns {{ folderId: string, folderUrl: string } | null}
 */
async function createFrameFolder(parentFolderId, folderName) {
  const folder = await frameioFetch(`/assets/${parentFolderId}/children`, {
    method: 'POST',
    body: JSON.stringify({
      name: folderName,
      type: 'folder',
    }),
  });
  if (!folder?.id) return null;

  // Build the shareable URL
  const folderUrl = `https://next.frame.io/project/${FRAMEIO_PROJECT_ID}/${folder.id}`;
  return { folderId: folder.id, folderUrl };
}

// Handle taskCreated — auto-generate naming convention + create Frame.io folder
async function handleTaskCreated(taskId) {
  // Longer delay to let Brief Agent set relationship fields (product, avatar, creator)
  // before we read them back for naming convention generation.
  // Brief Agent creates task → then sets relationships (~3-5s) → webhook must wait.
  await new Promise((r) => setTimeout(r, 10000));

  const task = await getTask(taskId);
  const listId = task.list?.id;

  if (!NAMING_LISTS.includes(listId)) return;

  const isBriefPipeline = task.description?.includes('[brief-pipeline]');
  const isYtDuplicate = task.description?.includes('[yt-duplicate]');

  if (!isBriefPipeline && !isYtDuplicate) {
    // Get brief number from field, or auto-assign next available
    let briefNumber = getFieldValue(task, FIELD_IDS.briefNumber);
    if (briefNumber != null) {
      briefNumber = Math.round(briefNumber);
    } else {
      briefNumber = await getNextBriefNumber();
      // Save the assigned brief number to the task
      await setCustomField(taskId, FIELD_IDS.briefNumber, briefNumber);
      logger.info(`[ClickUp Webhook] Auto-assigned brief number B${String(briefNumber).padStart(4, '0')} to task ${taskId}`);
    }

    // Check if product relationship is set yet
    let product = getFieldValue(task, FIELD_IDS.productVideo);
    if (!product) {
      // Product not set yet — wait longer and re-fetch
      logger.info(`[ClickUp Webhook] Product not set for ${taskId}, waiting 15s more...`);
      await new Promise((r) => setTimeout(r, 15000));
      const refreshed = await getTask(taskId);
      product = getFieldValue(refreshed, FIELD_IDS.productVideo);
      if (product) {
        // Use refreshed task for naming
        const namingConv = generateNamingConvention(refreshed, listId, briefNumber);
        await updateTask(taskId, { name: namingConv });
        await setCustomField(taskId, FIELD_IDS.namingConvention, namingConv);
        logger.info(`[ClickUp Webhook] Auto-named task ${taskId} → "${namingConv}" (after retry)`);
      } else {
        // Still no product — name with NA, will be fixed when product field changes
        const namingConv = generateNamingConvention(task, listId, briefNumber);
        await updateTask(taskId, { name: namingConv });
        await setCustomField(taskId, FIELD_IDS.namingConvention, namingConv);
        logger.warn(`[ClickUp Webhook] Named task ${taskId} with NA product (not set after 25s): "${namingConv}"`);
      }
    } else {
      const namingConv = generateNamingConvention(task, listId, briefNumber);
      await updateTask(taskId, { name: namingConv });
      await setCustomField(taskId, FIELD_IDS.namingConvention, namingConv);
      logger.info(`[ClickUp Webhook] Auto-named task ${taskId} → "${namingConv}"`);
    }
  } else if (isYtDuplicate) {
    logger.info(`[ClickUp Webhook] Skipping auto-naming for YT duplicate task ${taskId}`);
  } else {
    logger.info(`[ClickUp Webhook] Skipping auto-naming for brief-pipeline task ${taskId}`);
  }

  // Frame.io folder creation is now handled on status change to "editing"
  // (see handleEditingStatusChange below)
}

// Handle custom field changes — regenerate naming convention
async function handleCustomFieldChanged(taskId) {
  const task = await getTask(taskId);
  const listId = task.list?.id;

  if (!NAMING_LISTS.includes(listId)) return;

  // Skip renaming for tasks created by the Brief Pipeline or YT duplicates
  if (task.description?.includes('[brief-pipeline]')) return;
  if (task.description?.includes('[yt-duplicate]')) return;

  // Get or assign brief number
  let briefNumber = getFieldValue(task, FIELD_IDS.briefNumber);
  if (briefNumber != null) {
    briefNumber = Math.round(briefNumber);
  } else {
    // No brief number yet — assign one
    briefNumber = await getNextBriefNumber();
    await setCustomField(taskId, FIELD_IDS.briefNumber, briefNumber);
    logger.info(`[ClickUp Webhook] Auto-assigned brief number B${String(briefNumber).padStart(4, '0')} to task ${taskId} (on field change)`);
  }

  const existingName = getFieldValue(task, FIELD_IDS.namingConvention);
  const namingConv = generateNamingConvention(task, listId, briefNumber);

  if (namingConv !== existingName) {
    await updateTask(taskId, { name: namingConv });
    await setCustomField(taskId, FIELD_IDS.namingConvention, namingConv);
    logger.info(`[ClickUp Webhook] ${existingName ? 'Re-named' : 'Named'} task ${taskId} → "${namingConv}"`);
  }
}

// ── Duplicate task to "yt ready to launch" when VA task reaches "ready to launch" ──
async function ensureYoutubeTask(task, taskListId) {
  if (taskListId !== VIDEO_ADS_LIST) return;

  // Check if a YT duplicate already exists via linked tasks
  const linkedTasks = task.linked_tasks || [];
  for (const link of linkedTasks) {
    try {
      const lt = await getTask(link.task_id);
      if (lt.list?.id === VIDEO_ADS_LIST) {
        const ltStatus = lt.status?.status?.toLowerCase();
        if (ltStatus === 'yt ready to launch' || ltStatus === 'launched youtube') {
          logger.info(`[ClickUp Webhook] Task "${task.name}" already has YT counterpart ${link.task_id}, skipping`);
          return;
        }
      }
    } catch (err) {
      // Continue checking others
    }
  }

  logger.info(`[ClickUp Webhook] Creating YT Ready to Launch duplicate for "${task.name}" (${task.id})`);

  try {
    // Create duplicate task in same list with "yt ready to launch" status
    const ytTask = await clickupFetch(`/list/${VIDEO_ADS_LIST}/task`, {
      method: 'POST',
      body: JSON.stringify({
        name: task.name,
        status: 'yt ready to launch',
        description: (task.description || '') + '\n[yt-duplicate]',
        tags: (task.tags || []).map(t => t.name),
        priority: task.priority?.id || null,
        assignees: (task.assignees || []).map(a => a.id),
      }),
    });

    // Copy custom field values from original task
    for (const field of (task.custom_fields || [])) {
      if (field.value == null) continue;
      try {
        // For drop_down fields, the value is the orderindex
        if (field.type === 'drop_down') {
          await setCustomField(ytTask.id, field.id, field.value);
        } else if (field.type === 'users' && Array.isArray(field.value)) {
          await setCustomField(ytTask.id, field.id, { add: field.value.map(u => u.id) });
        } else if (field.type === 'list_relationship') {
          // Skip relationship fields — can't easily copy
        } else {
          await setCustomField(ytTask.id, field.id, field.value);
        }
      } catch (fieldErr) {
        // Some fields may fail (read-only, etc.) — continue
      }
    }

    // Link the original and YT tasks together
    await clickupFetch(`/task/${task.id}/link/${ytTask.id}`, {
      method: 'POST',
    });

    logger.info(`[ClickUp Webhook] Created YT task ${ytTask.id} ("${task.name}") linked to ${task.id}`);
  } catch (err) {
    logger.error(`[ClickUp Webhook] Failed to create YT task for ${task.id}: ${err.message}`);
  }
}

// ── Create Media Buying task when VA task reaches "ready to launch" ──
async function ensureMediaBuyingTask(task, taskListId) {
  // Only applies to Video Ads list
  if (taskListId !== VIDEO_ADS_LIST) return;

  // Check if a linked Media Buying task already exists
  const linkedTasks = task.linked_tasks || [];
  for (const link of linkedTasks) {
    try {
      const lt = await getTask(link.task_id);
      if (lt.list?.id === MEDIA_BUYING_LIST) {
        logger.info(`[ClickUp Webhook] Task "${task.name}" already has Media Buying counterpart ${link.task_id}, skipping creation`);
        return;
      }
    } catch (err) {
      // If we can't fetch a linked task, continue checking others
    }
  }

  // No Media Buying counterpart — create one
  logger.info(`[ClickUp Webhook] Creating Media Buying task for Video Ads task "${task.name}" (${task.id})`);

  try {
    const mbTask = await clickupFetch(`/list/${MEDIA_BUYING_LIST}/task`, {
      method: 'POST',
      body: JSON.stringify({
        name: task.name,
        status: 'ready to launch',
        description: `Auto-created from Video Ads pipeline.\nSource task: https://app.clickup.com/t/${task.id}`,
      }),
    });

    // Link the two tasks together
    await clickupFetch(`/task/${task.id}/link/${mbTask.id}`, {
      method: 'POST',
    });

    logger.info(`[ClickUp Webhook] Created Media Buying task ${mbTask.id} ("${task.name}") and linked to ${task.id}`);
  } catch (err) {
    logger.error(`[ClickUp Webhook] Failed to create Media Buying task for ${task.id}: ${err.message}`);
  }
}

// NOTE: Frame.io folder creation on "editing" status is handled by Make.com scenario
// Our webhook only handles naming, status sync, YT duplication, and Media Buying tasks

// Handle status sync between linked tasks
async function handleStatusSync(taskId, historyItems) {
  const statusChange = historyItems?.find((h) => h.field === 'status');
  if (!statusChange) return;

  const newStatus = statusChange.after?.status?.toLowerCase();
  if (!newStatus) return;

  const task = await getTask(taskId);
  const taskListId = task.list?.id;

  if (!SYNC_LISTS.includes(taskListId)) return;

  // When a VA task hits "ready to launch", auto-create YT counterpart
  if (newStatus === 'ready to launch') {
    await ensureYoutubeTask(task, taskListId);
  }

  if (!SYNC_STATUSES.includes(newStatus)) return;

  const linkedTasks = task.linked_tasks || [];
  if (linkedTasks.length === 0) return;

  logger.info(
    `[ClickUp Webhook] Task "${task.name}" in list ${taskListId} changed to "${newStatus}". Syncing ${linkedTasks.length} linked task(s).`
  );

  // Collect all ClickUp task IDs to sync back to spy_creatives DB
  const clickupIdsToSync = [taskId];

  for (const link of linkedTasks) {
    const linkedTaskId = link.task_id;
    try {
      const linkedTask = await getTask(linkedTaskId);
      const linkedListId = linkedTask.list?.id;

      if (!SYNC_LISTS.includes(linkedListId)) continue;
      if (linkedTask.status?.status?.toLowerCase() === newStatus) continue;

      await updateTaskStatus(linkedTaskId, newStatus);
      clickupIdsToSync.push(linkedTaskId);
      logger.info(
        `[ClickUp Webhook] Synced "${linkedTask.name}" (${linkedListId}) → "${newStatus}"`
      );
    } catch (err) {
      logger.error(`[ClickUp Webhook] Failed to sync linked task ${linkedTaskId}: ${err.message}`);
    }
  }

  // Sync status back to Mineblock DB (spy_creatives table)
  if (newStatus === 'launched') {
    for (const clickupId of clickupIdsToSync) {
      try {
        const result = await pgQuery(
          `UPDATE spy_creatives SET status = 'launched', updated_at = NOW()
           WHERE generation_task_id = $1 AND status != 'launched'
           RETURNING id, product_name`,
          [clickupId]
        );
        if (result.length > 0) {
          logger.info(
            `[ClickUp Webhook] Synced "launched" to spy_creatives: ${result.map(r => r.product_name || r.id).join(', ')} (ClickUp task ${clickupId})`
          );
        }
      } catch (dbErr) {
        logger.error(`[ClickUp Webhook] DB sync failed for ClickUp task ${clickupId}: ${dbErr.message}`);
      }
    }
  }
}

// Media Buying reconciliation removed — Video Ads is now the single source of truth

// POST /api/v1/clickup-webhook — receives ClickUp webhook events
router.post('/', async (req, res) => {
  // Respond immediately so ClickUp doesn't retry
  res.status(200).json({ ok: true });

  try {
    const { event, task_id, history_items } = req.body;

    logger.info(`[ClickUp Webhook] Received event: ${event} for task ${task_id}`);

    if (event === 'taskStatusUpdated') {
      await handleStatusSync(task_id, history_items);
    } else if (event === 'taskCreated') {
      await handleTaskCreated(task_id);
    } else if (event === 'taskUpdated') {
      // Check if a custom field relevant to naming was changed
      const fieldChange = history_items?.find((h) => h.field === 'custom_field');
      if (fieldChange) {
        await handleCustomFieldChanged(task_id);
      }
    }
  } catch (err) {
    logger.error(`[ClickUp Webhook] Error processing webhook: ${err.message}`);
  }
});

// GET /api/v1/clickup-webhook/fix-naming/:taskId — manually trigger naming for a missed task
router.get('/fix-naming/:taskId', async (req, res) => {
  const { taskId } = req.params;
  try {
    const task = await getTask(taskId);
    const listId = task.list?.id;

    if (!NAMING_LISTS.includes(listId)) {
      return res.status(400).json({ error: `Task ${taskId} is not in a naming-enabled list (list: ${listId})` });
    }

    // Skip brief-pipeline and yt-duplicate tasks
    if (task.description?.includes('[brief-pipeline]')) {
      return res.status(400).json({ error: 'Task is from brief pipeline — naming is handled there' });
    }
    if (task.description?.includes('[yt-duplicate]')) {
      return res.status(400).json({ error: 'Task is a YT duplicate — naming skipped' });
    }

    // Get or assign brief number
    let briefNumber = getFieldValue(task, FIELD_IDS.briefNumber);
    if (briefNumber != null) {
      briefNumber = Math.round(briefNumber);
    } else {
      briefNumber = await getNextBriefNumber();
      await setCustomField(taskId, FIELD_IDS.briefNumber, briefNumber);
    }

    const namingConv = generateNamingConvention(task, listId, briefNumber);
    await updateTask(taskId, { name: namingConv });
    await setCustomField(taskId, FIELD_IDS.namingConvention, namingConv);

    // Also set creation week if empty
    const existingWeek = getFieldValue(task, FIELD_IDS.creationWeek);
    if (!existingWeek) {
      await setCustomField(taskId, FIELD_IDS.creationWeek, getWeekLabel());
    }

    logger.info(`[ClickUp Webhook] Manually fixed naming for task ${taskId} → "${namingConv}"`);
    res.json({ success: true, taskId, namingConvention: namingConv, briefNumber });
  } catch (err) {
    logger.error(`[ClickUp Webhook] Fix naming failed for ${taskId}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/clickup-webhook/status — check webhook health and list active webhooks
router.get('/status', async (req, res) => {
  try {
    const webhooks = await clickupFetch(`/team/${TEAM_ID}/webhook`);
    res.json({
      active_webhooks: webhooks.webhooks?.length || 0,
      webhooks: webhooks.webhooks?.map(w => ({
        id: w.id,
        endpoint: w.endpoint,
        events: w.events,
        health: w.health,
        status: w.status,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/clickup-webhook/register — register a new webhook for the team
router.post('/register', async (req, res) => {
  const endpoint = req.body.endpoint;
  if (!endpoint) {
    return res.status(400).json({ error: 'endpoint is required' });
  }
  try {
    const result = await clickupFetch(`/team/${TEAM_ID}/webhook`, {
      method: 'POST',
      body: JSON.stringify({
        endpoint,
        events: ['taskCreated', 'taskUpdated', 'taskStatusUpdated'],
        space_id: null, // Team-wide
      }),
    });
    logger.info(`[ClickUp Webhook] Registered new webhook: ${result.id} → ${endpoint}`);
    res.json({ success: true, webhook: result });
  } catch (err) {
    logger.error(`[ClickUp Webhook] Failed to register webhook: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/clickup-webhook/frame-diagnose — check Frame.io token and project access
router.get('/frame-diagnose', async (req, res) => {
  const results = { token_set: !!FRAMEIO_TOKEN, project_id: FRAMEIO_PROJECT_ID };

  if (!FRAMEIO_TOKEN) {
    return res.json({ ...results, error: 'FRAMEIO_TOKEN not set' });
  }

  try {
    // Try to get the user/account info first
    const me = await frameioFetch('/me');
    results.user = { id: me?.id, email: me?.email, name: me?.name };
    results.account_id = me?.account_id;

    // Try accessing the project directly
    try {
      const project = await frameioFetch(`/projects/${FRAMEIO_PROJECT_ID}`);
      results.project = { id: project?.id, name: project?.name, root_asset_id: project?.root_asset_id };
    } catch (e) {
      results.project_error = e.message;
    }

    // Try to find all projects through the user's teams
    // v2 API: /me → account_id → /accounts/{id}/teams → /teams/{id}/projects
    try {
      // Method 1: Direct team membership
      const teams = me?.teams || [];
      if (teams.length > 0) {
        results.teams_from_me = teams.map(t => ({ id: t.id, name: t.name }));
      }
    } catch { /* skip */ }

    // Method 2: List all assets at the project root (in case the project ID is actually an asset/folder ID)
    try {
      const asset = await frameioFetch(`/assets/${FRAMEIO_PROJECT_ID}`);
      results.as_asset = { id: asset?.id, name: asset?.name, type: asset?.type, project_id: asset?.project_id };
    } catch (e) {
      results.as_asset_error = e.message;
    }

    // Method 3: Try listing the user's projects directly
    try {
      const searchRes = await fetch(`https://api.frame.io/v2/search/library?account_id=${me?.account_id}&type=project&page_size=20`, {
        headers: { Authorization: `Bearer ${FRAMEIO_TOKEN}` },
      });
      if (searchRes.ok) {
        const searchData = await searchRes.json();
        results.library_projects = (searchData || []).map(p => ({ id: p.id, name: p.name, root_asset_id: p.root_asset_id }));
      } else {
        results.library_search_error = `${searchRes.status}: ${await searchRes.text().then(t => t.slice(0, 200))}`;
      }
    } catch (e) {
      results.library_search_error = e.message;
    }

    // Method 4: Try the v2 /me endpoint which may include project refs
    try {
      const meTeams = await frameioFetch('/me/teams');
      results.me_teams = Array.isArray(meTeams) ? meTeams.map(t => ({ id: t.id, name: t.name })) : meTeams;
    } catch (e) {
      results.me_teams_error = e.message;
    }

    res.json(results);
  } catch (err) {
    results.error = err.message;
    res.status(500).json(results);
  }
});

// GET /api/v1/clickup-webhook/frame-list — list all accessible projects via teams or account
router.get('/frame-list', async (req, res) => {
  try {
    const me = await frameioFetch('/me');
    const accountId = me?.account_id;
    const results = { account_id: accountId, email: me?.email, teams: [], projects: [] };

    // Try v2 teams path
    try {
      const teams = await frameioFetch(`/accounts/${accountId}/teams`);
      const teamList = Array.isArray(teams) ? teams : (teams?.data || []);
      for (const team of teamList.slice(0, 5)) {
        const teamEntry = { id: team.id, name: team.name, projects: [] };
        try {
          const projects = await frameioFetch(`/teams/${team.id}/projects`);
          const projectList = Array.isArray(projects) ? projects : (projects?.data || []);
          for (const p of projectList) {
            teamEntry.projects.push({ id: p.id, name: p.name, root_asset_id: p.root_asset_id });
          }
        } catch (e) {
          teamEntry.projects_error = e.message;
        }
        results.teams.push(teamEntry);
      }
    } catch (e) {
      results.teams_error = e.message;
    }

    // Try additional v2 paths to find projects
    const userId = me?.id;
    try {
      const meProjects = await frameioFetch('/me/projects');
      const pList = Array.isArray(meProjects) ? meProjects : (meProjects?.data || []);
      results.me_projects = pList.map(p => ({ id: p.id, name: p.name, root_asset_id: p.root_asset_id }));
    } catch (e) {
      results.me_projects_error = e.message;
    }
    if (userId) {
      try {
        const userProjects = await frameioFetch(`/users/${userId}/projects`);
        const pList = Array.isArray(userProjects) ? userProjects : (userProjects?.data || []);
        results.user_projects = pList.map(p => ({ id: p.id, name: p.name, root_asset_id: p.root_asset_id }));
      } catch (e) {
        results.user_projects_error = e.message;
      }
      try {
        const userTeams = await frameioFetch(`/users/${userId}/teams`);
        const tList = Array.isArray(userTeams) ? userTeams : (userTeams?.data || []);
        results.user_teams = tList.map(t => ({ id: t.id, name: t.name }));
      } catch (e) {
        results.user_teams_error = e.message;
      }
    }
    // Try v4 API paths
    try {
      const v4me = await frameioFetchV4('/me');
      results.v4_me = { id: v4me?.id, email: v4me?.email, account_id: v4me?.account_id };
    } catch (e) {
      results.v4_error = e.message;
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/clickup-webhook/frame-children/:assetId — list children of a folder (tries v2 then v4)
router.get('/frame-children/:assetId', async (req, res) => {
  const { assetId } = req.params;
  let v2Error;
  try {
    const children = await frameioFetch(`/assets/${assetId}/children`);
    const list = Array.isArray(children) ? children : (children?.data || []);
    return res.json({ api: 'v2', items: list.map(a => ({ id: a.id, name: a.name, type: a.type, item_count: a.item_count })) });
  } catch (err) {
    v2Error = err.message;
  }
  // Fallback: v4
  try {
    const children = await frameioFetchV4(`/assets/${assetId}/children`);
    const list = Array.isArray(children) ? children : (children?.data || []);
    return res.json({ api: 'v4', items: list.map(a => ({ id: a.id, name: a.name, type: a.type, item_count: a.item_count })) });
  } catch (err) {
    res.status(500).json({ v2_error: v2Error, v4_error: err.message });
  }
});

// POST /api/v1/clickup-webhook/frame-move — move an asset to a new parent folder (tries v2 then v4)
router.post('/frame-move', async (req, res) => {
  const { asset_id, new_parent_id } = req.body;
  if (!asset_id || !new_parent_id) return res.status(400).json({ error: 'asset_id and new_parent_id required' });
  let v2Error;
  try {
    const result = await frameioFetch(`/assets/${asset_id}`, {
      method: 'PUT',
      body: JSON.stringify({ parent_id: new_parent_id }),
    });
    return res.json({ success: true, api: 'v2', id: result?.id, name: result?.name, parent_id: result?.parent_id });
  } catch (err) {
    v2Error = err.message;
  }
  // Fallback: v4
  try {
    const result = await frameioFetchV4(`/assets/${asset_id}`, {
      method: 'PUT',
      body: JSON.stringify({ parent_id: new_parent_id }),
    });
    return res.json({ success: true, api: 'v4', id: result?.id, name: result?.name, parent_id: result?.parent_id });
  } catch (err) {
    res.status(500).json({ v2_error: v2Error, v4_error: err.message });
  }
});

// Debug: check a Frame.io asset directly (tries v2 then v4)
router.get('/frame-asset/:assetId', async (req, res) => {
  const { assetId } = req.params;
  let v2Error;
  try {
    const asset = await frameioFetch(`/assets/${assetId}`);
    return res.json({ api: 'v2', id: asset?.id, name: asset?.name, type: asset?.type, project_id: asset?.project_id, parent_id: asset?.parent_id, item_count: asset?.item_count });
  } catch (err) {
    v2Error = err.message;
  }
  // Fallback: v4
  try {
    const asset = await frameioFetchV4(`/assets/${assetId}`);
    return res.json({ api: 'v4', id: asset?.id, name: asset?.name, type: asset?.type, project_id: asset?.project_id, parent_id: asset?.parent_id, item_count: asset?.item_count });
  } catch (err) {
    res.status(500).json({ v2_error: v2Error, v4_error: err.message });
  }
});

// Frame.io folder creation is handled by Make.com scenario
// Use /frame-diagnose to check Frame.io API access if needed

// Manual Frame.io folder creation for tasks missing frame links
router.get('/create-frame-folder/:taskId', async (req, res) => {
  const { taskId } = req.params;
  try {
    if (!FRAMEIO_TOKEN) {
      return res.status(500).json({ error: 'FRAMEIO_TOKEN not set' });
    }

    // Get task info
    const task = await getTask(taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    // Check if already has frame link
    const existingLink = getFieldValue(task, 'd90f9f25-d7a0-4eb4-9ded-aca0b4519a3b');
    if (existingLink) {
      return res.json({ already_exists: true, frame_link: existingLink, task_name: task.name });
    }

    // Always use the full task name for the folder name
    const folderName = task.name;

    // Create the folder directly in the correct editing folder
    const result = await createFrameFolder(FRAMEIO_EDITING_FOLDER, folderName);
    if (!result) {
      return res.status(500).json({ error: 'Frame.io folder creation failed' });
    }

    // Set the frame link on the ClickUp task
    await setCustomField(taskId, 'd90f9f25-d7a0-4eb4-9ded-aca0b4519a3b', result.folderUrl);

    logger.info(`[create-frame-folder] Created folder for ${taskId}: ${result.folderUrl}`);
    res.json({ success: true, frame_link: result.folderUrl, folder_id: result.folderId, task_name: task.name });
  } catch (err) {
    logger.error('[create-frame-folder] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Frame.io v4 OAuth (Adobe IMS) ──────────────────────────────────
// Scopes Adobe requires for Frame.io v4 API calls. `offline_access` is what
// grants us a refresh_token so we don't re-auth every 24h.
// Scopes granted to OAuth Web App credentials for Frame.io. `frame.s2s.all` is
// S2S-only and rejects Web App flows with invalid_scope — don't include it.
// `offline_access` is required to get a refresh_token.
const FRAMEIO_SCOPES = 'openid,AdobeID,email,profile,offline_access,additional_info.roles';

// Step 1: kick off the auth flow. User opens this URL in a browser once.
router.get('/frameio-oauth-start', (req, res) => {
  if (!FRAMEIO_CLIENT_ID || !FRAMEIO_CLIENT_SECRET) {
    return res.status(500).json({ error: 'FRAMEIO_CLIENT_ID / FRAMEIO_CLIENT_SECRET not set on Render' });
  }
  const params = new URLSearchParams({
    client_id: FRAMEIO_CLIENT_ID,
    redirect_uri: FRAMEIO_REDIRECT_URI,
    response_type: 'code',
    scope: FRAMEIO_SCOPES,
    state: 'frameio-v4-init',
  });
  res.redirect(`${ADOBE_IMS_AUTHORIZE}?${params.toString()}`);
});

// Step 2: Adobe redirects back here with ?code=... — exchange for tokens.
router.get('/frameio-oauth-callback', async (req, res) => {
  const { code, error, error_description } = req.query;
  if (error) {
    logger.error(`[frameio-oauth-callback] Adobe returned error: ${error} — ${error_description}`);
    return res.status(400).send(`Adobe OAuth error: ${error} — ${error_description}`);
  }
  if (!code) return res.status(400).send('Missing ?code param');
  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: FRAMEIO_CLIENT_ID,
      client_secret: FRAMEIO_CLIENT_SECRET,
    });
    const r = await fetch(ADOBE_IMS_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`IMS token exchange failed ${r.status}: ${text.slice(0, 400)}`);
    }
    const tok = await r.json();
    if (!tok.refresh_token) {
      throw new Error('IMS did not return refresh_token — check that `offline_access` scope was granted');
    }
    await saveV4Tokens({
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      expires_at: Date.now() + (tok.expires_in || 86400) * 1000 - 60_000,
      token_type: tok.token_type || 'Bearer',
    });
    logger.info('[frameio-oauth-callback] Frame.io v4 OAuth tokens stored — integration unblocked');
    res.send('<h1>Frame.io v4 authorized ✅</h1><p>Tokens stored. You can close this tab.</p>');
  } catch (err) {
    logger.error('[frameio-oauth-callback] Error:', err.message);
    res.status(500).send(`OAuth callback failed: ${err.message}`);
  }
});

// Deep diagnostic — shows raw DB state for debugging "why does status report unauthorized"
router.get('/frameio-v4-debug', async (req, res) => {
  try {
    const rows = await pgQuery(
      "SELECT key, value, updated_at FROM system_settings WHERE key = 'frameio_oauth'"
    );
    const row = rows?.[0];
    const raw = row?.value;
    res.json({
      row_count: rows?.length || 0,
      updated_at: row?.updated_at || null,
      value_type: typeof raw,
      value_is_null: raw === null,
      value_keys: raw && typeof raw === 'object' ? Object.keys(raw) : null,
      has_refresh_token: !!(raw && (typeof raw === 'string'
        ? (() => { try { return JSON.parse(raw)?.refresh_token; } catch { return false; } })()
        : raw.refresh_token)),
      access_token_preview: raw && typeof raw === 'object' && raw.access_token
        ? `${String(raw.access_token).slice(0, 10)}…(${String(raw.access_token).length} chars)`
        : null,
      expires_at: raw && typeof raw === 'object' ? raw.expires_at : null,
      client_id_set: !!FRAMEIO_CLIENT_ID,
      client_secret_set: !!FRAMEIO_CLIENT_SECRET,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Diagnostic: is v4 OAuth set up and currently working?
router.get('/frameio-v4-status', async (req, res) => {
  try {
    const stored = await loadV4Tokens().catch(() => null);
    if (!stored?.refresh_token) {
      return res.json({ authorized: false, hint: 'Visit /api/v1/webhook/frameio-oauth-start to authorize' });
    }
    const me = await frameioFetchV4('/me');
    res.json({
      authorized: true,
      access_token_expires_at: new Date(stored.expires_at).toISOString(),
      v4_me: me,
    });
  } catch (err) {
    res.status(500).json({ authorized: false, error: err.message });
  }
});

// ── Frame.io v4 cleanup: move stray account-level projects into the editing folder ──
// One-shot admin operation. Locked behind CRON_SECRET header.
router.post('/admin-frameio-cleanup', async (req, res) => {
  const secret = req.headers['x-cron-secret'];
  if (!secret || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized — missing/invalid x-cron-secret' });
  }

  const report = { discovered: [], moved: [], skipped_has_content: [], deleted: [], errors: [] };

  try {
    // 1. Identify the v4 account + its workspaces/projects.
    const me = await frameioFetchV4('/me');
    const accountId = me?.account_id || me?.data?.account_id || me?.id;
    report.account_id = accountId;

    // 2. List v4 projects under the account. Frame.io v4 REST shape:
    //    GET /v4/accounts/:accountId/projects?include=workspace
    let projects = [];
    try {
      const r = await frameioFetchV4(`/accounts/${accountId}/projects?page_size=100`);
      projects = r?.data || r?.projects || r || [];
    } catch (err) {
      report.errors.push({ step: 'list_projects', error: err.message });
    }
    report.discovered = projects.map(p => ({ id: p.id, name: p.name, workspace_id: p.workspace_id }));

    // 3. For each project that is NOT the legit one, try to migrate.
    //    KEEP: FRAMEIO_PROJECT_ID (the canonical "Mineblock LLC" v2 project)
    //    The v4 version of that project has a DIFFERENT id — we identify it by name.
    const LEGIT_NAMES = new Set(['Mineblock LLC', 'mineblock llc']);
    const strays = projects.filter(p =>
      !LEGIT_NAMES.has((p.name || '').trim()) &&
      p.id !== FRAMEIO_PROJECT_ID
    );

    for (const proj of strays) {
      try {
        // Check if project has assets
        let children = [];
        try {
          const r = await frameioFetchV4(`/projects/${proj.id}/root?include=children`);
          children = r?.children || r?.data?.children || [];
        } catch { /* empty/new project */ }

        if (children.length > 0) {
          // Don't auto-delete content; let Ludo migrate manually.
          report.skipped_has_content.push({ id: proj.id, name: proj.name, child_count: children.length });
          continue;
        }

        // Empty project → create matching folder inside target editing folder, then delete the project.
        const folder = await createFrameFolder(FRAMEIO_EDITING_FOLDER, proj.name);
        if (!folder) {
          report.errors.push({ step: 'create_folder', project: proj.name, error: 'createFrameFolder returned null' });
          continue;
        }
        report.moved.push({ from_project_id: proj.id, to_folder_id: folder.folderId, name: proj.name, url: folder.folderUrl });

        // Delete the now-redundant empty v4 project.
        try {
          await frameioFetchV4(`/projects/${proj.id}`, { method: 'DELETE' });
          report.deleted.push({ id: proj.id, name: proj.name });
        } catch (err) {
          report.errors.push({ step: 'delete_project', id: proj.id, error: err.message });
        }
      } catch (err) {
        report.errors.push({ step: 'migrate', project: proj.name, error: err.message });
      }
    }

    res.json({ success: true, ...report });
  } catch (err) {
    logger.error('[admin-frameio-cleanup] Fatal:', err.message);
    res.status(500).json({ success: false, error: err.message, partial_report: report });
  }
});

export default router;
