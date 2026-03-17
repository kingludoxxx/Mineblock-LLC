import { Router } from 'express';
import logger from '../utils/logger.js';

const router = Router();

// ClickUp API config
const CLICKUP_TOKEN = 'pk_266421907_38TVGF16690R1U9EZOZLBK9BJ6J0YPRD';
const CLICKUP_API = 'https://api.clickup.com/api/v2';
const TEAM_ID = '90152075024';

// Frame.io config
const FRAMEIO_TOKEN = process.env.FRAMEIO_TOKEN || '';
const FRAMEIO_PROJECT_ID = '19c0ce1f-f357-4da8-ba1f-bd7eb201e660';
const FRAMEIO_API = 'https://api.frame.io/v2';

// List IDs
const MEDIA_BUYING_LIST = '901518769621';
const VIDEO_ADS_LIST = '901518716584';
const STATIC_ADS_LIST = '901518769479';
const SYNC_LISTS = [MEDIA_BUYING_LIST, VIDEO_ADS_LIST, STATIC_ADS_LIST];
const NAMING_LISTS = [VIDEO_ADS_LIST, STATIC_ADS_LIST];

// Statuses to sync
const SYNC_STATUSES = ['launched', 'ready to launch'];

// Custom field IDs — some differ between Video Ads and Static Ads lists
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
  // Static Ads only
  productStatic: '11a3ee08-50c8-4c19-b8cc-7c50eaabbe65',
  avatarStatic: 'a007dc5d-2422-4fc4-b3ca-e9e53489e76b',
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
  4: 'MiniVSL', 5: 'LongVSL', 6: 'IMG', 7: 'GIF',
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
  const isVideo = listId === VIDEO_ADS_LIST;

  const product = getFieldValue(task, isVideo ? FIELD_IDS.productVideo : FIELD_IDS.productStatic) || 'NA';
  const parentBriefId = getFieldValue(task, FIELD_IDS.parentBriefId) || 'NA';

  // Brief ID always uses B prefix
  const briefId = `B${String(briefNumber).padStart(4, '0')}`;

  const angle = getFieldValue(task, FIELD_IDS.angle) || 'NA';
  const briefType = getFieldValue(task, FIELD_IDS.briefType) || 'NA';
  const creativeType = isVideo ? (getFieldValue(task, FIELD_IDS.creativeType) || 'NA') : 'IMG';
  const avatar = getFieldValue(task, isVideo ? FIELD_IDS.avatarVideo : FIELD_IDS.avatarStatic) || 'NA';
  const creator = isVideo ? (getFieldValue(task, FIELD_IDS.creator) || 'NA') : 'NA';
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

async function frameioFetch(url, options = {}) {
  if (!FRAMEIO_TOKEN) {
    logger.warn('[ClickUp Webhook] FRAMEIO_TOKEN not set — skipping Frame.io integration');
    return null;
  }
  const res = await fetch(`${FRAMEIO_API}${url}`, {
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
  // Small delay to let ClickUp populate custom fields
  await new Promise((r) => setTimeout(r, 3000));

  const task = await getTask(taskId);
  const listId = task.list?.id;

  if (!NAMING_LISTS.includes(listId)) return;

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

  const namingConv = generateNamingConvention(task, listId, briefNumber);

  // Update task name and naming convention custom field
  await updateTask(taskId, { name: namingConv });
  await setCustomField(taskId, FIELD_IDS.namingConvention, namingConv);

  logger.info(`[ClickUp Webhook] Auto-named task ${taskId} → "${namingConv}"`);

  // ── Frame.io: Create folder and set link on ClickUp task ──
  // Works for both Video Ads and Static Ads (Images) pipelines
  try {
    if (!FRAMEIO_TOKEN) {
      logger.warn('[ClickUp Webhook] Skipping Frame.io folder — no token configured');
      return;
    }

    // Check if frame link already exists (don't overwrite)
    const existingFrameLink = task.custom_fields?.find(
      (f) => f.id === 'd90f9f25-d7a0-4eb4-9ded-aca0b4519a3b'
    )?.value;
    if (existingFrameLink) {
      logger.info(`[ClickUp Webhook] Frame link already set for ${taskId}, skipping`);
      return;
    }

    const rootFolderId = await getProjectRootFolder();
    if (!rootFolderId) {
      logger.error('[ClickUp Webhook] Could not get Frame.io project root folder');
      return;
    }

    // Use the brief ID as folder name (e.g. "B0131")
    const briefId = `B${String(briefNumber).padStart(4, '0')}`;
    const folderName = briefId;

    const result = await createFrameFolder(rootFolderId, folderName);
    if (!result) {
      logger.error(`[ClickUp Webhook] Failed to create Frame.io folder for ${briefId}`);
      return;
    }

    // Set the Ads Frame Link custom field on the ClickUp task
    await setCustomField(taskId, 'd90f9f25-d7a0-4eb4-9ded-aca0b4519a3b', result.folderUrl);

    logger.info(`[ClickUp Webhook] Created Frame.io folder "${folderName}" → ${result.folderUrl} and set on task ${taskId}`);
  } catch (frameErr) {
    // Don't fail the whole webhook if Frame.io fails
    logger.error(`[ClickUp Webhook] Frame.io error for task ${taskId}: ${frameErr.message}`);
  }
}

// Handle custom field changes — regenerate naming convention
async function handleCustomFieldChanged(taskId) {
  const task = await getTask(taskId);
  const listId = task.list?.id;

  if (!NAMING_LISTS.includes(listId)) return;

  // Check if naming convention field already has a value (task was named before)
  const existingName = getFieldValue(task, FIELD_IDS.namingConvention);
  if (!existingName) return; // Only regenerate if it was previously generated

  let briefNumber = getFieldValue(task, FIELD_IDS.briefNumber);
  if (briefNumber != null) {
    briefNumber = Math.round(briefNumber);
  } else {
    return; // Can't regenerate without a brief number
  }

  const namingConv = generateNamingConvention(task, listId, briefNumber);

  if (namingConv !== existingName) {
    await updateTask(taskId, { name: namingConv });
    await setCustomField(taskId, FIELD_IDS.namingConvention, namingConv);
    logger.info(`[ClickUp Webhook] Re-named task ${taskId} → "${namingConv}"`);
  }
}

// Handle status sync between linked tasks
async function handleStatusSync(taskId, historyItems) {
  const statusChange = historyItems?.find((h) => h.field === 'status');
  if (!statusChange) return;

  const newStatus = statusChange.after?.status?.toLowerCase();
  if (!newStatus || !SYNC_STATUSES.includes(newStatus)) return;

  const task = await getTask(taskId);
  const taskListId = task.list?.id;

  if (!SYNC_LISTS.includes(taskListId)) return;

  const linkedTasks = task.linked_tasks || [];
  if (linkedTasks.length === 0) return;

  logger.info(
    `[ClickUp Webhook] Task "${task.name}" in list ${taskListId} changed to "${newStatus}". Syncing ${linkedTasks.length} linked task(s).`
  );

  for (const link of linkedTasks) {
    const linkedTaskId = link.task_id;
    try {
      const linkedTask = await getTask(linkedTaskId);
      const linkedListId = linkedTask.list?.id;

      if (!SYNC_LISTS.includes(linkedListId)) continue;
      if (linkedTask.status?.status?.toLowerCase() === newStatus) continue;

      await updateTaskStatus(linkedTaskId, newStatus);
      logger.info(
        `[ClickUp Webhook] Synced "${linkedTask.name}" (${linkedListId}) → "${newStatus}"`
      );
    } catch (err) {
      logger.error(`[ClickUp Webhook] Failed to sync linked task ${linkedTaskId}: ${err.message}`);
    }
  }
}

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

export default router;
