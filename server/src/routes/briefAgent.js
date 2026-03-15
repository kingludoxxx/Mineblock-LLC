import express from 'express';

const router = express.Router();

const CLICKUP_TOKEN = 'pk_266421907_38TVGF16690R1U9EZOZLBK9BJ6J0YPRD';
const VIDEO_ADS_LIST_ID = '901518716584';
const CLICKUP_API = 'https://api.clickup.com/api/v2';

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

    // 3) Build description
    const description = [
      referenceLink ? `Reference: ${referenceLink}` : '',
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
    ].filter((f) => f.value != null);

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

export default router;
