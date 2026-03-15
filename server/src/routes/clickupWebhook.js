import { Router } from 'express';
import logger from '../utils/logger.js';

const router = Router();

// ClickUp API config
const CLICKUP_TOKEN = 'pk_266421907_38TVGF16690R1U9EZOZLBK9BJ6J0YPRD';
const CLICKUP_API = 'https://api.clickup.com/api/v2';
const TEAM_ID = '90152075024';

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

// Generate naming convention from task custom fields
function generateNamingConvention(task, listId) {
  const isVideo = listId === VIDEO_ADS_LIST;

  const product = getFieldValue(task, isVideo ? FIELD_IDS.productVideo : FIELD_IDS.productStatic) || 'NA';
  const parentBriefId = getFieldValue(task, FIELD_IDS.parentBriefId) || 'NA';

  // HX for Video, VX for Static — use Brief Number field for the numeric part
  const prefix = isVideo ? 'H' : 'V';
  const briefNum = getFieldValue(task, FIELD_IDS.briefNumber);
  const briefId = briefNum ? `${prefix}${String(briefNum).padStart(4, '0')}` : `${prefix}XXXX`;

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

// Handle taskCreated — auto-generate naming convention
async function handleTaskCreated(taskId) {
  // Small delay to let ClickUp populate custom fields
  await new Promise((r) => setTimeout(r, 2000));

  const task = await getTask(taskId);
  const listId = task.list?.id;

  if (!NAMING_LISTS.includes(listId)) return;

  const namingConv = generateNamingConvention(task, listId);

  // Update task name and naming convention custom field
  await updateTask(taskId, { name: namingConv });
  await setCustomField(taskId, FIELD_IDS.namingConvention, namingConv);

  logger.info(`[ClickUp Webhook] Auto-named task ${taskId} → "${namingConv}"`);
}

// Handle custom field changes — regenerate naming convention
async function handleCustomFieldChanged(taskId) {
  const task = await getTask(taskId);
  const listId = task.list?.id;

  if (!NAMING_LISTS.includes(listId)) return;

  // Check if naming convention field already has a value (task was named before)
  const existingName = getFieldValue(task, FIELD_IDS.namingConvention);
  if (!existingName) return; // Only regenerate if it was previously generated

  const namingConv = generateNamingConvention(task, listId);

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
