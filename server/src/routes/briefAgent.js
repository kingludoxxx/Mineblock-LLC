import express from 'express';

const router = express.Router();

const CLICKUP_TOKEN = process.env.CLICKUP_API_TOKEN || '';
const VIDEO_ADS_LIST_ID = '901518716584';
const CLICKUP_API = 'https://api.clickup.com/api/v2';
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';

// Editor Slack channels for Monday reports
const EDITOR_SLACK_CHANNELS = {
  Faiz: 'C0AFCJ4UN9L',
  Antoni: 'C0AEZ6UQANT',
  Uly: 'C0ANNMMPUCC',
};

const headers = {
  Authorization: CLICKUP_TOKEN,
  'Content-Type': 'application/json',
};

// ── Static mappings ──────────────────────────────────────────────────
const CREATIVE_TYPE_CODES = {
  Mashup: 'HX',
  ShortVid: 'VX',
  UGC: 'UX',
  VSL: 'VL',
  'Mini VSL': 'MV',
  'Long VSL': 'LV',
  Cartoon: 'CT',
};

// Custom field IDs
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
  adsFrameLink: 'd90f9f25-d7a0-4eb4-9ded-aca0b4519a3b',
};

// Dropdown option IDs
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

// Relationship task IDs
const PRODUCT_TASK_IDS = {
  MR: '86c75fure',
  TX: '86c7jxxtj',
};

const AVATAR_TASK_IDS = {
  Cryptoaddict: '86c7hf58v',
  MoneySeeker: '86c7m5417',
  'Test Avatar': '86c75fyjh',
  Aware: '86c8jhvfk',
  NA: null, // no NA avatar task exists
};

const CREATOR_NA_TASK_ID = '86c7n9cvr';

// User IDs
const USER_IDS = {
  Ludovico: 266421907,
  Antoni: 94595626,
  Faiz: 170558610,
  Uly: 106674594,
};

// ── Helpers ──────────────────────────────────────────────────────────

async function clickupFetch(url, options = {}) {
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ClickUp API error ${res.status}: ${text}`);
  }
  return res.json();
}

function getCurrentWeek() {
  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const diff = now - startOfYear;
  const oneWeek = 604800000;
  const weekNum = Math.ceil((diff / oneWeek) + startOfYear.getDay() / 7);
  return { weekNum, year: now.getFullYear() };
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

// ── Routes ───────────────────────────────────────────────────────────

// GET /api/v1/brief-agent/next-brief-number
router.get('/next-brief-number', async (_req, res) => {
  try {
    let maxBrief = 0;
    let page = 0;
    let hasMore = true;

    while (hasMore) {
      const data = await clickupFetch(
        `${CLICKUP_API}/list/${VIDEO_ADS_LIST_ID}/task?page=${page}&limit=100&include_closed=true&subtasks=true`,
      );
      const tasks = data.tasks || [];

      for (const task of tasks) {
        // Check custom field value
        const briefField = task.custom_fields?.find(
          (f) => f.id === FIELD_IDS.briefNumber,
        );
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

    res.json({ success: true, nextBriefNumber: maxBrief + 1 });
  } catch (err) {
    console.error('[BriefAgent] next-brief-number error:', err.message);
    res.status(500).json({
      success: false,
      error: { message: 'Failed to fetch next brief number.' },
    });
  }
});

// GET /api/v1/brief-agent/field-options
router.get('/field-options', (_req, res) => {
  res.json({
    success: true,
    options: {
      angles: Object.keys(ANGLE_OPTIONS),
      creativeTypes: Object.keys(CREATIVE_TYPE_OPTIONS),
      briefTypes: Object.keys(BRIEF_TYPE_OPTIONS),
      editors: Object.keys(USER_IDS).filter((n) => n !== 'Ludovico'),
      avatars: Object.keys(AVATAR_TASK_IDS),
      products: Object.keys(PRODUCT_TASK_IDS),
      creativeTypeCodes: CREATIVE_TYPE_CODES,
    },
  });
});

// GET /api/v1/brief-agent/editor-queue — count of edit queue tasks per editor
router.get('/editor-queue', async (_req, res) => {
  try {
    const counts = {};
    // Initialize all editors to 0
    for (const name of Object.keys(USER_IDS)) {
      if (name !== 'Ludovico') counts[name] = 0;
    }

    let page = 0;
    let hasMore = true;
    while (hasMore) {
      const data = await clickupFetch(
        `${CLICKUP_API}/list/${VIDEO_ADS_LIST_ID}/task?page=${page}&limit=100&statuses%5B%5D=edit%20queue&include_closed=false&subtasks=true`,
      );
      const tasks = data.tasks || [];
      for (const task of tasks) {
        for (const assignee of task.assignees || []) {
          // Match assignee by user ID to our editor names
          for (const [name, id] of Object.entries(USER_IDS)) {
            if (name !== 'Ludovico' && assignee.id === id) {
              counts[name] = (counts[name] || 0) + 1;
            }
          }
        }
      }
      hasMore = tasks.length === 100;
      page++;
    }

    res.json({ success: true, counts });
  } catch (err) {
    console.error('[BriefAgent] editor-queue error:', err.message);
    res.status(500).json({ success: false, error: { message: 'Failed to fetch editor queue counts.' } });
  }
});

// GET /api/v1/brief-agent/lookup/:briefId — look up a task by brief ID and return its Frame links
// Accepts ?product=MR|TX to filter by product code (matches the start of the task name)
router.get('/lookup/:briefId', async (req, res) => {
  try {
    const briefId = req.params.briefId.toUpperCase().replace(/^B0*/, '');
    const briefNum = parseInt(briefId, 10);
    if (isNaN(briefNum)) {
      return res.status(400).json({ success: false, error: { message: 'Invalid brief ID.' } });
    }

    const productFilter = (req.query.product || '').toUpperCase();

    // Search through all tasks to find matching brief numbers
    let found = null;
    let page = 0;
    let hasMore = true;

    while (hasMore && !found) {
      const data = await clickupFetch(
        `${CLICKUP_API}/list/${VIDEO_ADS_LIST_ID}/task?page=${page}&limit=100&include_closed=true&subtasks=true`,
      );
      const tasks = data.tasks || [];

      for (const task of tasks) {
        const briefField = task.custom_fields?.find((f) => f.id === FIELD_IDS.briefNumber);
        const taskBriefNum = briefField?.value != null ? parseInt(briefField.value, 10) : null;

        // Match by brief number field or by name pattern
        const nameMatch = task.name?.match(/B0*(\d+)/);
        const nameBriefNum = nameMatch ? parseInt(nameMatch[1], 10) : null;

        if (taskBriefNum === briefNum || nameBriefNum === briefNum) {
          // If product filter is set, only match tasks with the same product prefix
          if (productFilter) {
            const taskProduct = task.name?.split(' - ')[0]?.trim().toUpperCase();
            if (taskProduct === productFilter) {
              found = task;
              break;
            }
          } else {
            found = task;
            break;
          }
        }
      }

      hasMore = tasks.length === 100;
      page++;
    }

    const result = found;

    if (!result) {
      return res.json({ success: true, found: false });
    }

    // Extract Frame links
    const adsFrameLink = result.custom_fields?.find((f) => f.id === 'd90f9f25-d7a0-4eb4-9ded-aca0b4519a3b')?.value || null;
    const rawFrameLink = result.custom_fields?.find((f) => f.id === '55357fec-e285-4e47-b071-926b7dc8a214')?.value || null;

    res.json({
      success: true,
      found: true,
      task: {
        id: result.id,
        name: result.name,
        url: result.url || `https://app.clickup.com/t/${result.id}`,
        adsFrameLink,
        rawFrameLink,
        frameLink: adsFrameLink || rawFrameLink || null,
      },
    });
  } catch (err) {
    console.error('[BriefAgent] lookup error:', err.message);
    res.status(500).json({ success: false, error: { message: 'Failed to look up brief.' } });
  }
});

// POST /api/v1/brief-agent/create
router.post('/create', async (req, res) => {
  try {
    const {
      angle,
      creativeType,
      briefType,
      editor,
      avatar,
      product = 'MR',
      parentBriefId,
      idea = '-',
      briefText = '',
      referenceLink = '',
    } = req.body;

    // Validation
    if (!angle || !creativeType || !briefType || !editor || !avatar) {
      return res.status(400).json({
        success: false,
        error: { message: 'angle, creativeType, briefType, editor, and avatar are required.' },
      });
    }

    if (briefType === 'IT' && !parentBriefId) {
      return res.status(400).json({
        success: false,
        error: { message: 'parentBriefId is required when briefType is IT.' },
      });
    }

    // 1) Get next brief number
    let maxBrief = 0;
    let page = 0;
    let hasMore = true;

    while (hasMore) {
      const data = await clickupFetch(
        `${CLICKUP_API}/list/${VIDEO_ADS_LIST_ID}/task?page=${page}&limit=100&include_closed=true&subtasks=true`,
      );
      const tasks = data.tasks || [];

      for (const task of tasks) {
        const briefField = task.custom_fields?.find(
          (f) => f.id === FIELD_IDS.briefNumber,
        );
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

    const briefNumber = maxBrief + 1;
    const briefNumberPadded = String(briefNumber).padStart(4, '0');

    // 2) Build task name
    const creativeTypeCode = CREATIVE_TYPE_CODES[creativeType] || 'HX';
    const parentId = briefType === 'IT' ? parentBriefId : 'NA';
    const { weekNum, year } = getISOWeekNumber();
    const weekStr = `WK${String(weekNum).padStart(2, '0')}_${year}`;

    const taskName = `${product} - B${briefNumberPadded} - ${creativeTypeCode} - ${briefType} - ${parentId} - ${angle} - ${weekStr}`;

    // 2b) Auto-lookup parent's frame link for iterations if not already provided
    let finalReferenceLink = referenceLink || '';
    if (briefType === 'IT' && parentBriefId && !finalReferenceLink) {
      try {
        const parentNum = parseInt(parentBriefId.toUpperCase().replace(/^B0*/, ''), 10);
        if (!isNaN(parentNum)) {
          let parentFound = null;
          let pPage = 0;
          let pHasMore = true;
          while (pHasMore && !parentFound) {
            const pData = await clickupFetch(
              `${CLICKUP_API}/list/${VIDEO_ADS_LIST_ID}/task?page=${pPage}&limit=100&include_closed=true&subtasks=true`,
            );
            const pTasks = pData.tasks || [];
            for (const pt of pTasks) {
              const ptBriefField = pt.custom_fields?.find((f) => f.id === FIELD_IDS.briefNumber);
              const ptBriefNum = ptBriefField?.value != null ? parseInt(ptBriefField.value, 10) : null;
              const ptNameMatch = pt.name?.match(/B0*(\d+)/);
              const ptNameNum = ptNameMatch ? parseInt(ptNameMatch[1], 10) : null;
              if (ptBriefNum === parentNum || ptNameNum === parentNum) {
                const ptProduct = pt.name?.split(' - ')[0]?.trim().toUpperCase();
                if (ptProduct === product.toUpperCase()) {
                  parentFound = pt;
                  break;
                }
              }
            }
            pHasMore = pTasks.length === 100;
            pPage++;
          }
          if (parentFound) {
            const parentFrame = parentFound.custom_fields?.find((f) => f.id === FIELD_IDS.adsFrameLink)?.value
              || parentFound.custom_fields?.find((f) => f.id === '55357fec-e285-4e47-b071-926b7dc8a214')?.value
              || null;
            if (parentFrame) {
              finalReferenceLink = parentFrame;
              console.log(`[BriefAgent] Auto-resolved parent ${parentBriefId} frame link: ${parentFrame}`);
            }
          }
        }
      } catch (lookupErr) {
        console.error('[BriefAgent] Parent frame lookup error:', lookupErr.message);
      }
    }

    // 3) Build description
    const description = [
      finalReferenceLink ? `Reference: ${finalReferenceLink}` : '',
      '',
      briefText || '(no brief text provided)',
    ]
      .filter((line, i) => i > 0 || line)
      .join('\n');

    // 4) Build custom fields
    const customFields = [
      { id: FIELD_IDS.briefNumber, value: briefNumber },
      { id: FIELD_IDS.briefType, value: BRIEF_TYPE_OPTIONS[briefType] },
      { id: FIELD_IDS.parentBriefId, value: parentId },
      { id: FIELD_IDS.idea, value: idea || '-' },
      { id: FIELD_IDS.angle, value: ANGLE_OPTIONS[angle] },
      { id: FIELD_IDS.creativeType, value: CREATIVE_TYPE_OPTIONS[creativeType] },
      { id: FIELD_IDS.editor, value: { add: [USER_IDS[editor]], rem: [] } },
      { id: FIELD_IDS.creationWeek, value: weekStr },
      { id: FIELD_IDS.creativeStrategist, value: { add: [USER_IDS.Ludovico], rem: [] } },
      { id: FIELD_IDS.copywriter, value: { add: [USER_IDS.Ludovico], rem: [] } },
      // NOTE: Do NOT set adsFrameLink here — it gets auto-created as a NEW folder
      // by the clickupWebhook handler when the task is created.
      // finalReferenceLink is only used in the task description for reference.
    ].filter((f) => f != null && f.value != null);

    // 5) Create the task — goes straight to edit queue since editor is assigned
    const taskPayload = {
      name: taskName,
      description,
      status: 'edit queue',
      assignees: [USER_IDS[editor]],
      custom_fields: customFields,
    };

    const createdTask = await clickupFetch(
      `${CLICKUP_API}/list/${VIDEO_ADS_LIST_ID}/task`,
      {
        method: 'POST',
        body: JSON.stringify(taskPayload),
      },
    );

    const taskId = createdTask.id;

    // 6) Set relationship fields (Product, Avatar, Creator)
    const relationshipPromises = [];

    // Product relationship
    const productTaskId = PRODUCT_TASK_IDS[product];
    if (productTaskId) {
      relationshipPromises.push(
        clickupFetch(
          `${CLICKUP_API}/task/${taskId}/field/${FIELD_IDS.product}`,
          {
            method: 'POST',
            body: JSON.stringify({
              value: { add: [{ id: productTaskId }], rem: [] },
            }),
          },
        ).catch((err) => console.error('[BriefAgent] Product relationship error:', err.message)),
      );
    }

    // Avatar relationship
    const avatarTaskId = AVATAR_TASK_IDS[avatar];
    if (avatarTaskId) {
      relationshipPromises.push(
        clickupFetch(
          `${CLICKUP_API}/task/${taskId}/field/${FIELD_IDS.avatar}`,
          {
            method: 'POST',
            body: JSON.stringify({
              value: { add: [{ id: avatarTaskId }], rem: [] },
            }),
          },
        ).catch((err) => console.error('[BriefAgent] Avatar relationship error:', err.message)),
      );
    }

    // Creator relationship (always NA)
    relationshipPromises.push(
      clickupFetch(
        `${CLICKUP_API}/task/${taskId}/field/${FIELD_IDS.creator}`,
        {
          method: 'POST',
          body: JSON.stringify({
            value: { add: [{ id: CREATOR_NA_TASK_ID }], rem: [] },
          }),
        },
      ).catch((err) => console.error('[BriefAgent] Creator relationship error:', err.message)),
    );

    await Promise.all(relationshipPromises);

    // Re-set the task name AFTER relationships are set, so the ClickUp webhook
    // (which fires on taskCreated and reads product from the relationship field)
    // doesn't overwrite it with "NA" due to a race condition.
    await clickupFetch(`${CLICKUP_API}/task/${taskId}`, {
      method: 'PUT',
      body: JSON.stringify({ name: taskName }),
    }).catch((err) => console.error('[BriefAgent] Name re-set error:', err.message));

    res.json({
      success: true,
      task: {
        id: taskId,
        name: taskName,
        url: createdTask.url || `https://app.clickup.com/t/${taskId}`,
        briefNumber,
        status: 'edit queue',
      },
    });
  } catch (err) {
    console.error('[BriefAgent] create error:', err.message);
    res.status(500).json({
      success: false,
      error: { message: err.message || 'Failed to create brief task.' },
    });
  }
});

// ── Editor Weekly Report (for Make → Slack) ─────────────────────────

// GET /api/v1/brief-agent/editor-report/slack/:editor
// Returns total "ready to launch" cards this week per editor — Make calls this Monday and posts to Slack
// Slack channels: Faiz → C0AFCJ4UN9L, Antoni → C0AEZ6UQANT
router.get('/editor-report/slack/:editor', async (req, res) => {
  try {
    const editorName = req.params.editor;
    const editorId = USER_IDS[editorName];
    if (!editorId) {
      return res.status(400).json({ success: false, error: { message: `Unknown editor: ${editorName}` } });
    }

    // Get current week boundaries (Monday 00:00 → Sunday 23:59)
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() + mondayOffset);
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    // Fetch "ready to launch" tasks assigned to this editor
    const readyTasks = [];
    let page = 0;
    let hasMore = true;
    while (hasMore) {
      const data = await clickupFetch(
        `${CLICKUP_API}/list/${VIDEO_ADS_LIST_ID}/task?page=${page}&limit=100&statuses%5B%5D=ready%20to%20launch&include_closed=false&subtasks=true`,
      );
      const tasks = data.tasks || [];
      for (const task of tasks) {
        const isAssigned = (task.assignees || []).some((a) => a.id === editorId);
        if (isAssigned) {
          readyTasks.push({
            name: task.name,
            url: task.url || `https://app.clickup.com/t/${task.id}`,
          });
        }
      }
      hasMore = tasks.length === 100;
      page++;
    }

    // Also count "launched" this week (moved to launched within current week)
    const launchedTasks = [];
    page = 0;
    hasMore = true;
    while (hasMore) {
      const data = await clickupFetch(
        `${CLICKUP_API}/list/${VIDEO_ADS_LIST_ID}/task?page=${page}&limit=100&statuses%5B%5D=launched&include_closed=false&subtasks=true&date_updated_gt=${weekStart.getTime()}&date_updated_lt=${weekEnd.getTime()}`,
      );
      const tasks = data.tasks || [];
      for (const task of tasks) {
        const isAssigned = (task.assignees || []).some((a) => a.id === editorId);
        if (isAssigned) {
          launchedTasks.push({
            name: task.name,
            url: task.url || `https://app.clickup.com/t/${task.id}`,
          });
        }
      }
      hasMore = tasks.length === 100;
      page++;
    }

    const { weekNum, year } = getISOWeekNumber();
    const weekLabel = `WK${String(weekNum).padStart(2, '0')} ${year}`;

    const lines = [
      `📊 *Weekly Report — ${editorName}* (${weekLabel})`,
      `📅 ${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`,
      '',
      `🚀 *Ready to Launch: ${readyTasks.length}*`,
    ];

    if (readyTasks.length > 0) {
      for (const t of readyTasks) {
        lines.push(`    • <${t.url}|${t.name}>`);
      }
    } else {
      lines.push('    _No cards ready to launch_');
    }

    lines.push('');
    lines.push(`✅ *Launched this week: ${launchedTasks.length}*`);
    if (launchedTasks.length > 0) {
      for (const t of launchedTasks) {
        lines.push(`    • <${t.url}|${t.name}>`);
      }
    }

    res.json({ success: true, text: lines.join('\n') });
  } catch (err) {
    console.error('[BriefAgent] editor-report/slack error:', err.message);
    res.status(500).json({ success: false, error: { message: 'Failed to generate report.' } });
  }
});

// ── Weekly Recap for Make → Slack (B codes only, filtered by week) ───

// GET /api/v1/brief-agent/weekly-recap/:editor
// Returns just B codes for tasks in "ready to launch" or "launched" status
// that belong to the target week, filtered by editor assignee.
// Make calls this on Monday and posts the response text directly to Slack.
router.get('/weekly-recap/:editor', async (req, res) => {
  try {
    const editorName = req.params.editor; // "Antoni" or "Faiz"
    const editorId = USER_IDS[editorName];
    if (!editorId) {
      return res.status(400).json({ success: false, error: { message: `Unknown editor: ${editorName}` } });
    }

    // Always report on the previous completed week (subtract 7 days)
    // On Monday this shows the week that just ended; on other days it still shows last week
    const now = new Date();
    const targetDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Get ISO week number for the target date
    const d = new Date(Date.UTC(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    const year = d.getUTCFullYear();
    const weekCode = `WK${String(weekNum).padStart(2, '0')}_${year}`;

    // Fetch tasks with "ready to launch" and "launched" statuses
    const allTasks = [];
    for (const status of ['ready%20to%20launch', 'launched']) {
      let page = 0;
      let hasMore = true;
      while (hasMore) {
        const data = await clickupFetch(
          `${CLICKUP_API}/list/${VIDEO_ADS_LIST_ID}/task?page=${page}&limit=100&statuses%5B%5D=${status}&include_closed=false&subtasks=true`,
        );
        const tasks = data.tasks || [];
        allTasks.push(...tasks);
        hasMore = tasks.length === 100;
        page++;
      }
    }

    // Filter tasks:
    // 1. Task status must actually be "ready to launch" or "launched"
    // 2. Task name must contain the week code (e.g., WK11_2026)
    // 3. Task must be assigned to this editor (by assignee ID)
    const validStatuses = ['ready to launch', 'launched'];
    const matchedBCodes = [];
    for (const task of allTasks) {
      const taskStatus = (task.status?.status || '').toLowerCase();
      if (!validStatuses.includes(taskStatus)) continue;

      const name = (task.name || '').toLowerCase();
      const hasWeek = name.includes(weekCode.toLowerCase());
      const isAssigned = (task.assignees || []).some((a) => a.id === editorId);

      if (hasWeek && isAssigned) {
        const bMatch = task.name.match(/B\d{3,5}/);
        if (bMatch && !matchedBCodes.includes(bMatch[0])) {
          matchedBCodes.push(bMatch[0]);
        }
      }
    }

    // Build Slack message
    const weekLabel = `WK${String(weekNum).padStart(2, '0')} ${year}`;
    const displayName = editorName.charAt(0).toUpperCase() + editorName.slice(1);

    const lines = [
      `📊 *Weekly Recap — ${displayName}* (${weekLabel})`,
      '',
      `*Total cards ready to launch: ${matchedBCodes.length}*`,
    ];

    if (matchedBCodes.length > 0) {
      for (const code of matchedBCodes) {
        lines.push(`• ${code}`);
      }
    } else {
      lines.push('_No cards this week_');
    }

    res.json({ success: true, text: lines.join('\n') });
  } catch (err) {
    console.error('[BriefAgent] weekly-recap error:', err.message);
    res.status(500).json({ success: false, error: { message: 'Failed to generate weekly recap.' } });
  }
});

// ── Manual trigger for editor reports ────────────────────────────────
router.post('/send-editor-reports', async (req, res) => {
  try {
    const results = {};
    for (const editorName of Object.keys(EDITOR_SLACK_CHANNELS)) {
      await sendEditorWeeklyReport(editorName);
      results[editorName] = 'sent';
    }
    res.json({ success: true, data: results });
  } catch (err) {
    console.error('[EditorReport] Manual trigger error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Monday Editor Report Scheduler ──────────────────────────────────
// Runs every Monday at 10:03 CET — posts weekly recap to each editor's Slack channel

async function sendEditorWeeklyReport(editorName) {
  const editorId = USER_IDS[editorName];
  const channel = EDITOR_SLACK_CHANNELS[editorName];
  if (!editorId || !channel || !SLACK_BOT_TOKEN) return;

  try {
    // Get current week boundaries (Monday 00:00 → Sunday 23:59)
    const now = new Date();
    const dayOfWeek = now.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() + mondayOffset);
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    // Fetch "ready to launch" tasks assigned to this editor
    const readyTasks = [];
    let page = 0;
    let hasMore = true;
    while (hasMore) {
      const data = await clickupFetch(
        `${CLICKUP_API}/list/${VIDEO_ADS_LIST_ID}/task?page=${page}&limit=100&statuses%5B%5D=ready%20to%20launch&include_closed=false&subtasks=true`,
      );
      const tasks = data.tasks || [];
      for (const task of tasks) {
        if ((task.assignees || []).some((a) => a.id === editorId)) {
          readyTasks.push({ name: task.name, url: task.url || `https://app.clickup.com/t/${task.id}` });
        }
      }
      hasMore = tasks.length === 100;
      page++;
    }

    // Fetch "launched" tasks this week
    const launchedTasks = [];
    page = 0;
    hasMore = true;
    while (hasMore) {
      const data = await clickupFetch(
        `${CLICKUP_API}/list/${VIDEO_ADS_LIST_ID}/task?page=${page}&limit=100&statuses%5B%5D=launched&include_closed=false&subtasks=true&date_updated_gt=${weekStart.getTime()}&date_updated_lt=${weekEnd.getTime()}`,
      );
      const tasks = data.tasks || [];
      for (const task of tasks) {
        if ((task.assignees || []).some((a) => a.id === editorId)) {
          launchedTasks.push({ name: task.name, url: task.url || `https://app.clickup.com/t/${task.id}` });
        }
      }
      hasMore = tasks.length === 100;
      page++;
    }

    const { weekNum, year } = getISOWeekNumber();
    const weekLabel = `WK${String(weekNum).padStart(2, '0')} ${year}`;

    const lines = [
      `📊 *Weekly Report — ${editorName}* (${weekLabel})`,
      `📅 ${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`,
      '',
      `🚀 *Ready to Launch: ${readyTasks.length}*`,
    ];
    if (readyTasks.length > 0) {
      for (const t of readyTasks) lines.push(`    • <${t.url}|${t.name}>`);
    } else {
      lines.push('    _No cards ready to launch_');
    }
    lines.push('');
    lines.push(`✅ *Launched this week: ${launchedTasks.length}*`);
    if (launchedTasks.length > 0) {
      for (const t of launchedTasks) lines.push(`    • <${t.url}|${t.name}>`);
    }

    // Post to Slack
    await fetch('https://slack.com/api/conversations.join', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel }),
    }).catch(() => {});

    const resp = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel,
        text: `Weekly Report for ${editorName} (${weekLabel})`,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
        ],
        username: 'Mineblock Bot',
        icon_url: 'https://i.imgur.com/PJCRE4g.png',
      }),
    });

    const result = await resp.json();
    if (!result.ok) {
      console.error(`[EditorReport] Slack error for ${editorName}:`, result.error);
    } else {
      console.log(`[EditorReport] Sent weekly report for ${editorName} to ${channel}`);
    }
  } catch (err) {
    console.error(`[EditorReport] Error for ${editorName}:`, err.message);
  }
}

function scheduleMondayEditorReports() {
  const checkInterval = 30_000;
  let lastSentDate = null;

  setInterval(() => {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now);
    const get = (type) => parts.find(p => p.type === type)?.value;
    const hour = parseInt(get('hour'));
    const minute = parseInt(get('minute'));
    const berlinDate = `${get('year')}-${get('month')}-${get('day')}`;

    // Check if it's Monday (day of week in Berlin timezone)
    const berlinDay = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', weekday: 'long' }).format(now);
    const isMonday = berlinDay === 'Monday';

    // Fire at 10:03 CET on Mondays
    if (isMonday && hour === 10 && minute >= 3 && minute < 5 && lastSentDate !== berlinDate) {
      lastSentDate = berlinDate;
      console.log(`[EditorReport] Triggering Monday reports for ${berlinDate}`);
      for (const editorName of Object.keys(EDITOR_SLACK_CHANNELS)) {
        sendEditorWeeklyReport(editorName).catch(err =>
          console.error(`[EditorReport] Failed for ${editorName}:`, err.message)
        );
      }
    }
  }, checkInterval);

  console.log('[EditorReport] Monday scheduler active — will fire at 10:03 CET every Monday');
}

// Start the scheduler
scheduleMondayEditorReports();

export default router;
