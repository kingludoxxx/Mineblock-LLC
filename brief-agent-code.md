# Brief Agent — Full Source Code

> One-click creative brief creation tool that integrates with ClickUp.
> Built with Express (backend) + React (frontend).

---

## Architecture Overview

```
Frontend (React + Vite)
  └── BriefAgent.jsx — Form UI, calls REST API

Backend (Express)
  └── briefAgent.js — REST routes, ClickUp API integration

Flow:
  1. Frontend loads field options + next brief number from backend
  2. User fills form (product, angle, creative type, editor, avatar, etc.)
  3. On submit → POST /api/v1/brief-agent/create
  4. Backend creates task in ClickUp with all custom fields + relationships
  5. Task goes straight to "edit queue" status, assigned to selected editor
```

---

## File 1: Backend — `server/src/routes/briefAgent.js`

```javascript
import express from 'express';

const router = express.Router();

const CLICKUP_TOKEN = 'YOUR_CLICKUP_API_TOKEN';
const VIDEO_ADS_LIST_ID = 'YOUR_CLICKUP_LIST_ID';
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

// Custom field IDs (from your ClickUp list — get these from ClickUp API)
const FIELD_IDS = {
  briefNumber: 'YOUR_FIELD_ID',
  briefType: 'YOUR_FIELD_ID',
  parentBriefId: 'YOUR_FIELD_ID',
  idea: 'YOUR_FIELD_ID',
  angle: 'YOUR_FIELD_ID',
  creativeType: 'YOUR_FIELD_ID',
  editor: 'YOUR_FIELD_ID',
  creationWeek: 'YOUR_FIELD_ID',
  creativeStrategist: 'YOUR_FIELD_ID',
  copywriter: 'YOUR_FIELD_ID',
  product: 'YOUR_FIELD_ID',
  avatar: 'YOUR_FIELD_ID',
  creator: 'YOUR_FIELD_ID',
  adsFrameLink: 'YOUR_FIELD_ID',
};

// Dropdown option IDs (from ClickUp custom field definitions)
const ANGLE_OPTIONS = {
  // 'AngleName': 'clickup-option-uuid',
};

const BRIEF_TYPE_OPTIONS = {
  NN: 'clickup-option-uuid',  // New
  IT: 'clickup-option-uuid',  // Iteration
};

const CREATIVE_TYPE_OPTIONS = {
  // 'TypeName': 'clickup-option-uuid',
};

// Relationship task IDs (tasks that represent products/avatars in ClickUp)
const PRODUCT_TASK_IDS = {
  // 'MR': 'clickup-task-id',
};

const AVATAR_TASK_IDS = {
  // 'AvatarName': 'clickup-task-id',
};

const CREATOR_NA_TASK_ID = 'YOUR_TASK_ID';

// User IDs (ClickUp user IDs for assignment)
const USER_IDS = {
  // 'EditorName': 12345678,
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
// Scans all tasks in the list to find the highest brief number, returns +1
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
// Returns all dropdown options for the form
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

// GET /api/v1/brief-agent/editor-queue
// Counts how many "edit queue" tasks each editor has
router.get('/editor-queue', async (_req, res) => {
  try {
    const counts = {};
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

// GET /api/v1/brief-agent/lookup/:briefId
// Looks up a parent brief by ID, optionally filtered by product code
router.get('/lookup/:briefId', async (req, res) => {
  try {
    const briefId = req.params.briefId.toUpperCase().replace(/^B0*/, '');
    const briefNum = parseInt(briefId, 10);
    if (isNaN(briefNum)) {
      return res.status(400).json({ success: false, error: { message: 'Invalid brief ID.' } });
    }

    const productFilter = (req.query.product || '').toUpperCase();

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

        const nameMatch = task.name?.match(/B0*(\d+)/);
        const nameBriefNum = nameMatch ? parseInt(nameMatch[1], 10) : null;

        if (taskBriefNum === briefNum || nameBriefNum === briefNum) {
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

    if (!found) {
      return res.json({ success: true, found: false });
    }

    const adsFrameLink = found.custom_fields?.find((f) => f.id === FIELD_IDS.adsFrameLink)?.value || null;
    const rawFrameLink = found.custom_fields?.find((f) => f.id === '55357fec-e285-4e47-b071-926b7dc8a214')?.value || null;

    res.json({
      success: true,
      found: true,
      task: {
        id: found.id,
        name: found.name,
        url: found.url || `https://app.clickup.com/t/${found.id}`,
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
// Creates a new brief task in ClickUp with all fields + relationships
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
      finalReferenceLink ? { id: FIELD_IDS.adsFrameLink, value: finalReferenceLink } : null,
    ].filter((f) => f != null && f.value != null);

    // 5) Create the task
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
        ).catch((err) => console.error('Product relationship error:', err.message)),
      );
    }

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
        ).catch((err) => console.error('Avatar relationship error:', err.message)),
      );
    }

    relationshipPromises.push(
      clickupFetch(
        `${CLICKUP_API}/task/${taskId}/field/${FIELD_IDS.creator}`,
        {
          method: 'POST',
          body: JSON.stringify({
            value: { add: [{ id: CREATOR_NA_TASK_ID }], rem: [] },
          }),
        },
      ).catch((err) => console.error('Creator relationship error:', err.message)),
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
```

---

## File 2: Frontend — `client/src/pages/production/BriefAgent.jsx`

```jsx
import { useState, useEffect, useCallback } from 'react';
import {
  Sparkles,
  Plus,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Copy,
  RotateCcw,
  Zap,
  FileText,
} from 'lucide-react';
import Card from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import Select from '../../components/ui/Select';
import Input from '../../components/ui/Input';

const API_BASE = '/api/v1/brief-agent';

const INITIAL_FORM = {
  angle: '',
  creativeType: '',
  briefType: 'NN',
  editor: '',
  avatar: '',
  product: 'MR',
  parentBriefId: '',
  idea: '',
  briefText: '',
  referenceLink: '',
};

export default function BriefAgent() {
  const [options, setOptions] = useState(null);
  const [nextBrief, setNextBrief] = useState(null);
  const [form, setForm] = useState(INITIAL_FORM);
  const [loading, setLoading] = useState(false);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [recentBriefs, setRecentBriefs] = useState([]);
  const [parentLookup, setParentLookup] = useState(null);
  const [lookupTimer, setLookupTimer] = useState(null);
  const [editorCounts, setEditorCounts] = useState({});

  // Fetch editor queue counts
  const fetchEditorCounts = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/editor-queue`).then((r) => r.json());
      if (res.success) setEditorCounts(res.counts);
    } catch { /* silent */ }
  }, []);

  // Fetch field options and next brief number on mount
  const fetchData = useCallback(async () => {
    setOptionsLoading(true);
    try {
      const [optRes, briefRes] = await Promise.all([
        fetch(`${API_BASE}/field-options`).then((r) => r.json()),
        fetch(`${API_BASE}/next-brief-number`).then((r) => r.json()),
      ]);
      if (optRes.success) setOptions(optRes.options);
      if (briefRes.success) setNextBrief(briefRes.nextBriefNumber);
    } catch {
      setError('Failed to load form options.');
    } finally {
      setOptionsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    fetchEditorCounts();
  }, [fetchData, fetchEditorCounts]);

  const lookupParentBrief = useCallback(async (briefId, product) => {
    const cleanId = briefId.replace(/^B0*/i, '');
    if (!cleanId || isNaN(cleanId)) return;
    setParentLookup({ loading: true, task: null });
    try {
      const res = await fetch(`${API_BASE}/lookup/${briefId}?product=${product}`).then((r) => r.json());
      if (res.success && res.found) {
        setParentLookup({ loading: false, task: res.task });
        if (res.task.frameLink) {
          setForm((prev) => ({ ...prev, referenceLink: res.task.frameLink }));
        }
      } else {
        setParentLookup({ loading: false, task: null });
      }
    } catch {
      setParentLookup({ loading: false, task: null });
    }
  }, []);

  const updateField = (field, value) => {
    setForm((prev) => {
      const next = { ...prev, [field]: value };

      if ((field === 'parentBriefId' || field === 'product') && next.briefType === 'IT' && next.parentBriefId.length >= 2) {
        if (lookupTimer) clearTimeout(lookupTimer);
        const timer = setTimeout(() => lookupParentBrief(next.parentBriefId, next.product), 600);
        setLookupTimer(timer);
      } else if (field === 'parentBriefId' && value.length < 2) {
        setParentLookup(null);
      }

      return next;
    });
    setError(null);
  };

  const generatePreview = () => {
    if (!options || !nextBrief) return '...';
    const code = options.creativeTypeCodes?.[form.creativeType] || 'HX';
    const num = String(nextBrief).padStart(4, '0');
    const parent = form.briefType === 'IT' ? form.parentBriefId || '?' : 'NA';
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 1);
    const diff = now - start;
    const week = Math.ceil(((diff / 86400000) + start.getDay() + 1) / 7);
    const weekStr = `WK${String(week).padStart(2, '0')}_${now.getFullYear()}`;
    return `${form.product || 'MR'} - B${num} - ${code} - ${form.briefType || 'NN'} - ${parent} - ${form.angle || '?'} - ${weekStr}`;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch(`${API_BASE}/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();

      if (data.success) {
        setResult(data.task);
        setRecentBriefs((prev) => [data.task, ...prev].slice(0, 10));
        setForm(INITIAL_FORM);
        fetchEditorCounts();
        setNextBrief((prev) => (prev || data.task.briefNumber) + 1);
      } else {
        setError(data.error?.message || 'Failed to create brief.');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setForm(INITIAL_FORM);
    setResult(null);
    setError(null);
  };

  if (optionsLoading) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[60vh]">
        <div className="flex items-center gap-3 text-text-muted">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span>Loading Brief Agent...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-accent" />
            Brief Agent
          </h1>
          <p className="text-sm text-text-muted mt-1">
            Create creative briefs in ClickUp with one click. Next brief:{' '}
            <span className="text-accent font-mono font-semibold">
              B{nextBrief ? String(nextBrief).padStart(4, '0') : '...'}
            </span>
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={resetForm}>
          <RotateCcw className="w-3.5 h-3.5" />
          Reset
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Form */}
        <div className="lg:col-span-2">
          <Card>
            <form onSubmit={handleSubmit} className="space-y-5">
              {/* Row 1: Core fields */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                <Select
                  label="Product"
                  value={form.product}
                  onChange={(e) => updateField('product', e.target.value)}
                  options={options?.products?.map((p) => ({ value: p, label: p })) || []}
                />
                <Select
                  label="Angle"
                  value={form.angle}
                  onChange={(e) => updateField('angle', e.target.value)}
                  options={options?.angles?.map((a) => ({ value: a, label: a })) || []}
                  placeholder="Select angle..."
                />
                <Select
                  label="Creative Type"
                  value={form.creativeType}
                  onChange={(e) => updateField('creativeType', e.target.value)}
                  options={options?.creativeTypes?.map((c) => ({ value: c, label: c })) || []}
                  placeholder="Select type..."
                />
              </div>

              {/* Row 2: Brief type, editor, avatar */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                <Select
                  label="Brief Type"
                  value={form.briefType}
                  onChange={(e) => updateField('briefType', e.target.value)}
                  options={options?.briefTypes?.map((b) => ({
                    value: b,
                    label: b === 'NN' ? 'NN (New)' : 'IT (Iteration)',
                  })) || []}
                />
                <Select
                  label="Editor"
                  value={form.editor}
                  onChange={(e) => updateField('editor', e.target.value)}
                  options={options?.editors?.map((ed) => ({
                    value: ed,
                    label: editorCounts[ed] != null ? `${ed} (${editorCounts[ed]})` : ed,
                  })) || []}
                  placeholder="Select editor..."
                />
                <Select
                  label="Avatar"
                  value={form.avatar}
                  onChange={(e) => updateField('avatar', e.target.value)}
                  options={options?.avatars?.map((a) => ({ value: a, label: a })) || []}
                  placeholder="Select avatar..."
                />
              </div>

              {/* Parent Brief ID (only for iterations) */}
              {form.briefType === 'IT' && (
                <div className="space-y-2">
                  <Input
                    label="Parent Brief ID"
                    value={form.parentBriefId}
                    onChange={(e) => updateField('parentBriefId', e.target.value)}
                    placeholder="e.g. B0045"
                  />
                  {parentLookup?.loading && (
                    <div className="flex items-center gap-2 text-xs text-text-muted">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Looking up parent brief...
                    </div>
                  )}
                  {parentLookup && !parentLookup.loading && parentLookup.task && (
                    <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">
                      <div className="flex items-center gap-2 text-xs text-emerald-400">
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                        <span className="font-mono truncate">{parentLookup.task.name}</span>
                      </div>
                      {parentLookup.task.frameLink && (
                        <p className="text-[10px] text-emerald-400/70 mt-1 ml-5">
                          Frame link auto-filled in Reference
                        </p>
                      )}
                    </div>
                  )}
                  {parentLookup && !parentLookup.loading && !parentLookup.task && (
                    <div className="flex items-center gap-2 text-xs text-text-faint">
                      <AlertCircle className="w-3 h-3" />
                      No matching {form.product} brief found
                    </div>
                  )}
                </div>
              )}

              {/* Idea */}
              <Input
                label="Idea / Hook"
                value={form.idea}
                onChange={(e) => updateField('idea', e.target.value)}
                placeholder="Quick summary of the creative idea..."
              />

              {/* Brief text */}
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-text-muted">Brief Text</label>
                <textarea
                  value={form.briefText}
                  onChange={(e) => updateField('briefText', e.target.value)}
                  placeholder="Detailed brief instructions for the editor..."
                  rows={4}
                  className="w-full px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg
                    text-text-primary placeholder:text-text-faint
                    focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent
                    disabled:opacity-50 transition-colors resize-y"
                />
              </div>

              {/* Reference link */}
              <Input
                label="Reference Link"
                value={form.referenceLink}
                onChange={(e) => updateField('referenceLink', e.target.value)}
                placeholder="https://..."
              />

              {/* Preview */}
              <div className="bg-bg-main border border-border-subtle rounded-lg p-3">
                <p className="text-xs text-text-faint mb-1">Task name preview</p>
                <p className="text-sm text-text-primary font-mono break-all">{generatePreview()}</p>
              </div>

              {/* Error */}
              {error && (
                <div className="flex items-center gap-2 text-sm text-danger bg-danger/10 border border-danger/20 rounded-lg px-3 py-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  {error}
                </div>
              )}

              {/* Success */}
              {result && (
                <div className="flex items-center justify-between bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">
                  <div className="flex items-center gap-2 text-sm text-emerald-400">
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                    Created <span className="font-mono font-semibold">{result.name}</span>
                  </div>
                  <a
                    href={result.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-accent hover:underline flex items-center gap-1"
                  >
                    Open in ClickUp <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              )}

              {/* Submit */}
              <Button
                type="submit"
                loading={loading}
                disabled={!form.angle || !form.creativeType || !form.editor || !form.avatar}
                className="w-full"
                size="lg"
              >
                <Zap className="w-4 h-4" />
                Create Brief in ClickUp
              </Button>
            </form>
          </Card>
        </div>

        {/* Sidebar: recent briefs */}
        <div className="lg:col-span-1">
          <Card className="sticky top-6">
            <h3 className="text-sm font-medium text-text-muted mb-3 flex items-center gap-2">
              <FileText className="w-4 h-4" />
              Recent Briefs
            </h3>
            {recentBriefs.length === 0 ? (
              <p className="text-xs text-text-faint">No briefs created this session.</p>
            ) : (
              <div className="space-y-2">
                {recentBriefs.map((brief, i) => (
                  <a
                    key={`${brief.id}-${i}`}
                    href={brief.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block p-2.5 bg-bg-elevated rounded-lg hover:bg-bg-hover transition-colors group"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono text-text-primary truncate pr-2">
                        {brief.name}
                      </span>
                      <ExternalLink className="w-3 h-3 text-text-faint group-hover:text-accent shrink-0" />
                    </div>
                    <span className="text-[10px] text-text-faint mt-0.5 block">
                      B{String(brief.briefNumber).padStart(4, '0')} · {brief.status}
                    </span>
                  </a>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
```

---

## File 3: Route Registration — `server/src/routes/index.js` (excerpt)

```javascript
import briefAgentRoutes from './briefAgent.js';

// ... inside your route setup:
router.use('/brief-agent', briefAgentRoutes);
```

---

## File 4: Frontend Route — `client/src/App.jsx` (excerpt)

```jsx
import BriefAgentPage from './pages/production/BriefAgentPage';

// ... inside your routes:
<Route path="/app/brief-agent" element={<BriefAgentPage />} />
```

---

## Setup Instructions

### Prerequisites
- Node.js 18+
- A ClickUp workspace with a list for video ads
- ClickUp API token (Personal token from ClickUp Settings > Apps)

### How to adapt this for your own ClickUp workspace

1. **Get your ClickUp API token**: Settings > Apps > Generate API Token
2. **Get your List ID**: Open the list in ClickUp, the ID is in the URL
3. **Get custom field IDs**: Call `GET https://api.clickup.com/api/v2/list/{LIST_ID}/field` with your token to see all custom fields and their IDs
4. **Get dropdown option IDs**: Each dropdown custom field has `type_config.options` with the option UUIDs
5. **Get user IDs**: Call `GET https://api.clickup.com/api/v2/team/{TEAM_ID}/member` to see all workspace members
6. **Update the constants** in `briefAgent.js`:
   - `CLICKUP_TOKEN` — your API token
   - `VIDEO_ADS_LIST_ID` — your list ID
   - `FIELD_IDS` — your custom field IDs
   - `ANGLE_OPTIONS`, `BRIEF_TYPE_OPTIONS`, `CREATIVE_TYPE_OPTIONS` — your dropdown option UUIDs
   - `USER_IDS` — your team member IDs
   - `PRODUCT_TASK_IDS`, `AVATAR_TASK_IDS` — relationship task IDs

### UI Dependencies (React)
- `lucide-react` — icons
- `react-router-dom` — routing
- Tailwind CSS — styling
- Custom `Card`, `Button`, `Select`, `Input` components (basic wrappers)

### Task Naming Convention
```
{PRODUCT} - B{NUMBER} - {TYPE_CODE} - {BRIEF_TYPE} - {PARENT_ID} - {ANGLE} - WK{WEEK}_{YEAR}
Example: MR - B0125 - HX - NN - NA - Lottery - WK11_2026
```

### Features
- Auto-incrementing brief numbers
- Product-aware parent brief lookup (for iterations)
- Auto-fills reference/frame link from parent brief
- Editor queue counts (shows workload per editor)
- Live task name preview
- Creates task in ClickUp with all custom fields + relationship fields
- Recent briefs sidebar (session-based)
