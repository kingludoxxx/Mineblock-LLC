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

// Custom field IDs (without hyphens — ClickUp uses the full UUID)
const FIELD_IDS = {
  product: '7bc3b414-fa7b-43a5-92f6-aacb94b32072',
  parentBriefId: '4f72235e-2ceb-44b4-ab50-8e62bd7e3e65',
  angle: '7e740c52-8d74-4e3b-b0ca-e459c8cdd5f0',
  briefType: '98d04d2d-bac4-4e6e-9b69-46b8e78ee1e1',
  creativeType: 'b7f50dff-9a3f-4e2e-b3be-0b30d1ab6cfb',
  creator: 'be5a2a58-9e1b-4d0a-af16-f72a1c26d1b5',
  avatarVideo: '4ad59f88-b2d6-4f5a-9c2d-d0e2c37f0e1a',
  avatarStatic: 'a007dc5d-2b3e-4f8a-b1c5-e9d0a1f2b3c4',
  editor: 'a9613cd9-1a2b-3c4d-5e6f-7a8b9c0d1e2f',
  namingConvention: 'c97d93bc-ad82-4b90-98e0-092df383d9b8',
  creationWeek: 'a609d8d0-1b2c-3d4e-5f6a-7b8c9d0e1f2a',
  creativeStrategist: '372d59af-4a5b-6c7d-8e9f-0a1b2c3d4e5f',
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
  if (!field) return null;
  // For dropdown fields, return the selected option index
  if (field.type === 'drop_down' && field.type_config?.options) {
    const selectedIndex = field.value;
    if (selectedIndex == null) return null;
    return { index: parseInt(selectedIndex, 10), label: field.type_config.options[selectedIndex]?.name };
  }
  // For labels/text fields
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
  const product = getFieldValue(task, FIELD_IDS.product) || 'NA';
  const parentBriefId = getFieldValue(task, FIELD_IDS.parentBriefId) || 'NA';

  // HX for Video, VX for Static
  const prefix = listId === VIDEO_ADS_LIST ? 'H' : 'V';
  // Brief ID from task name if it starts with B/H/V/IM followed by digits
  const briefIdMatch = task.name?.match(/^[BHVIM]+(\d+)/i);
  const briefNum = briefIdMatch ? briefIdMatch[1] : 'XX';
  const briefId = `${prefix}${briefNum}`;

  const angleField = getFieldValue(task, FIELD_IDS.angle);
  const angle = angleField?.label || ANGLE_MAP[angleField?.index] || 'NA';

  const briefTypeField = getFieldValue(task, FIELD_IDS.briefType);
  const briefType = briefTypeField?.label || BRIEF_TYPE_MAP[briefTypeField?.index] || 'NA';

  const creativeTypeField = getFieldValue(task, FIELD_IDS.creativeType);
  const creativeType = creativeTypeField?.label || CREATIVE_TYPE_MAP[creativeTypeField?.index] || 'NA';

  const avatarFieldId = listId === VIDEO_ADS_LIST ? FIELD_IDS.avatarVideo : FIELD_IDS.avatarStatic;
  const avatarField = getFieldValue(task, avatarFieldId);
  const avatar = avatarField?.label || avatarField || 'NA';

  const creator = getFieldValue(task, FIELD_IDS.creator) || 'NA';
  const editor = getFieldValue(task, FIELD_IDS.editor) || 'NA';
  const strategist = getFieldValue(task, FIELD_IDS.creativeStrategist) || 'NA';

  const week = getWeekLabel();

  // Format: Product - BriefID - HX/VX - BriefType - ParentBriefID - Avatar - Angle - CreativeType - CreativeStrategist - Creator - Editor - WKxx_yyyy
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
