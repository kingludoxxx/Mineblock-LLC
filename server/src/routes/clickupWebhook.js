import { Router } from 'express';
import logger from '../utils/logger.js';

const router = Router();

// ClickUp API config
const CLICKUP_TOKEN = 'pk_266421907_38TVGF16690R1U9EZOZLBK9BJ6J0YPRD';
const CLICKUP_API = 'https://api.clickup.com/api/v2';

// List IDs
const MEDIA_BUYING_LIST = '901518769621';
const VIDEO_ADS_LIST = '901518716584';
const STATIC_ADS_LIST = '901518769479';
const SYNC_LISTS = [MEDIA_BUYING_LIST, VIDEO_ADS_LIST, STATIC_ADS_LIST];

// Statuses to sync (when any of these lists changes to one of these statuses, sync to linked tasks)
const SYNC_STATUSES = ['launched', 'ready to launch'];

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

// POST /api/v1/clickup-webhook — receives ClickUp webhook events
router.post('/', async (req, res) => {
  // Respond immediately so ClickUp doesn't retry
  res.status(200).json({ ok: true });

  try {
    const { event, task_id, history_items } = req.body;

    // Only handle status change events
    if (event !== 'taskStatusUpdated') return;

    // Get the new status from history_items
    const statusChange = history_items?.find((h) => h.field === 'status');
    if (!statusChange) return;

    const newStatus = statusChange.after?.status?.toLowerCase();
    if (!newStatus || !SYNC_STATUSES.includes(newStatus)) return;

    // Fetch the task to check which list it belongs to and get linked tasks
    const task = await getTask(task_id);
    const taskListId = task.list?.id;

    if (!SYNC_LISTS.includes(taskListId)) return;

    const linkedTasks = task.linked_tasks || [];
    if (linkedTasks.length === 0) return;

    logger.info(
      `[ClickUp Webhook] Task "${task.name}" in list ${taskListId} changed to "${newStatus}". Syncing ${linkedTasks.length} linked task(s).`
    );

    // Update all linked tasks in the other sync lists
    for (const link of linkedTasks) {
      const linkedTaskId = link.task_id;
      try {
        const linkedTask = await getTask(linkedTaskId);
        const linkedListId = linkedTask.list?.id;

        // Only sync if the linked task is in one of our sync lists
        if (!SYNC_LISTS.includes(linkedListId)) continue;

        // Skip if already at the target status
        if (linkedTask.status?.status?.toLowerCase() === newStatus) continue;

        await updateTaskStatus(linkedTaskId, newStatus);
        logger.info(
          `[ClickUp Webhook] Synced "${linkedTask.name}" (${linkedListId}) → "${newStatus}"`
        );
      } catch (err) {
        logger.error(`[ClickUp Webhook] Failed to sync linked task ${linkedTaskId}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[ClickUp Webhook] Error processing webhook: ${err.message}`);
  }
});

export default router;
