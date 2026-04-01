import { Router } from 'express';
import logger from '../utils/logger.js';
import { pgQuery } from '../db/pg.js';

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
  // Longer delay to let Brief Agent set relationship fields (product, avatar, creator)
  // before we read them back for naming convention generation.
  // Brief Agent creates task → then sets relationships (~3-5s) → webhook must wait.
  await new Promise((r) => setTimeout(r, 10000));

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

    // Use the full task name as folder name (e.g. "MR - B0139 - IT - B0067 - ...")
    const folderName = task.name || `B${String(briefNumber).padStart(4, '0')}`;

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

// ── Create Media Buying task when VA/SA task reaches "ready to launch" ──
async function ensureMediaBuyingTask(task, taskListId) {
  // Only applies to Video Ads and Static Ads lists
  if (taskListId !== VIDEO_ADS_LIST && taskListId !== STATIC_ADS_LIST) return;

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
  const pipelineLabel = taskListId === VIDEO_ADS_LIST ? 'Video' : 'Static';
  logger.info(`[ClickUp Webhook] Creating Media Buying task for ${pipelineLabel} Ads task "${task.name}" (${task.id})`);

  try {
    const mbTask = await clickupFetch(`/list/${MEDIA_BUYING_LIST}/task`, {
      method: 'POST',
      body: JSON.stringify({
        name: task.name,
        status: 'ready to launch',
        description: `Auto-created from ${pipelineLabel} Ads pipeline.\nSource task: https://app.clickup.com/t/${task.id}`,
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

// Handle status sync between linked tasks
async function handleStatusSync(taskId, historyItems) {
  const statusChange = historyItems?.find((h) => h.field === 'status');
  if (!statusChange) return;

  const newStatus = statusChange.after?.status?.toLowerCase();
  if (!newStatus || !SYNC_STATUSES.includes(newStatus)) return;

  const task = await getTask(taskId);
  const taskListId = task.list?.id;

  if (!SYNC_LISTS.includes(taskListId)) return;

  // When a VA/SA task hits "ready to launch", auto-create Media Buying counterpart
  if (newStatus === 'ready to launch') {
    await ensureMediaBuyingTask(task, taskListId);
  }

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

// ── Periodic status reconciliation ──────────────────────────────────────
// Webhooks are unreliable on Render free tier (server sleeps, misses events).
// Every 30 minutes, scan Media Buying "launched" tasks and ensure linked
// Video Ads / Static Ads tasks are also "launched".

async function reconcileStatuses() {
  try {
    let page = 0, hasMore = true, synced = 0;

    while (hasMore) {
      const data = await clickupFetch(
        `/list/${MEDIA_BUYING_LIST}/task?page=${page}&limit=100&statuses[]=launched`
      );
      const tasks = data.tasks || [];

      for (const task of tasks) {
        const linked = task.linked_tasks || [];
        for (const link of linked) {
          try {
            const lt = await getTask(link.task_id);
            const ltList = lt.list?.id;
            if (!SYNC_LISTS.includes(ltList)) continue;
            const ltStatus = lt.status?.status?.toLowerCase();
            if (ltStatus === 'launched') continue;

            await updateTaskStatus(link.task_id, 'launched');
            synced++;
            logger.info(`[StatusReconcile] Synced "${lt.name}" (${ltList}) → launched`);

            // Also sync to DB
            const dbResult = await pgQuery(
              `UPDATE spy_creatives SET status = 'launched', updated_at = NOW()
               WHERE generation_task_id = $1 AND status != 'launched'
               RETURNING id`,
              [link.task_id]
            ).catch(() => []);
            if (dbResult.length > 0) {
              logger.info(`[StatusReconcile] Updated ${dbResult.length} spy_creatives for task ${link.task_id}`);
            }
          } catch (err) {
            // Skip individual task errors, continue reconciling
          }
        }
      }

      hasMore = tasks.length === 100;
      page++;
    }

    if (synced > 0) {
      logger.info(`[StatusReconcile] Reconciled ${synced} task(s)`);
    }
  } catch (err) {
    logger.error(`[StatusReconcile] Error: ${err.message}`);
  }
}

// ── Reconcile "ready to launch" tasks missing Media Buying counterparts ──
async function reconcileReadyToLaunch() {
  try {
    let created = 0;

    for (const listId of [VIDEO_ADS_LIST, STATIC_ADS_LIST]) {
      const label = listId === VIDEO_ADS_LIST ? 'Video Ads' : 'Static Ads';
      let page = 0, hasMore = true;

      while (hasMore) {
        const data = await clickupFetch(
          `/list/${listId}/task?page=${page}&limit=100&statuses[]=ready%20to%20launch`
        );
        const tasks = data.tasks || [];

        for (const task of tasks) {
          // Check if any linked task is in Media Buying
          const linked = task.linked_tasks || [];
          let hasMB = false;

          for (const link of linked) {
            try {
              const lt = await getTask(link.task_id);
              if (lt.list?.id === MEDIA_BUYING_LIST) { hasMB = true; break; }
            } catch (_) { /* skip */ }
          }

          if (!hasMB) {
            try {
              const mbTask = await clickupFetch(`/list/${MEDIA_BUYING_LIST}/task`, {
                method: 'POST',
                body: JSON.stringify({
                  name: task.name,
                  status: 'ready to launch',
                  description: `Auto-created from ${label} pipeline (reconciliation).\nSource task: https://app.clickup.com/t/${task.id}`,
                }),
              });
              await clickupFetch(`/task/${task.id}/link/${mbTask.id}`, { method: 'POST' });
              created++;
              logger.info(`[RTL-Reconcile] Created MB task ${mbTask.id} for ${label} "${task.name}" (${task.id})`);
            } catch (err) {
              logger.error(`[RTL-Reconcile] Failed to create MB task for ${task.id}: ${err.message}`);
            }
          }
        }

        hasMore = tasks.length === 100;
        page++;
      }
    }

    if (created > 0) {
      logger.info(`[RTL-Reconcile] Created ${created} Media Buying task(s)`);
    }
  } catch (err) {
    logger.error(`[RTL-Reconcile] Error: ${err.message}`);
  }
}

// Run reconciliation every 30 minutes (backup for missed webhooks)
setTimeout(() => {
  reconcileStatuses(); // Run once on startup (after 60s delay)
  reconcileReadyToLaunch(); // Also reconcile missing MB tasks on startup
  setInterval(() => reconcileStatuses(), 30 * 60 * 1000);
  setInterval(() => reconcileReadyToLaunch(), 30 * 60 * 1000);
}, 60_000);

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
