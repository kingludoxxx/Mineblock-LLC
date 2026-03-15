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
  const [parentLookup, setParentLookup] = useState(null); // { loading, task }
  const [lookupTimer, setLookupTimer] = useState(null);
  const [editorCounts, setEditorCounts] = useState({}); // { Antoni: 5, Faiz: 6 }

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

      // Trigger parent brief lookup when parentBriefId or product changes
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
        fetchEditorCounts(); // refresh queue counts
        // Increment locally — ClickUp API has a delay before the new task is indexed
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
            Create creative briefs in ClickUp with one click. Next brief: <span className="text-accent font-mono font-semibold">B{nextBrief ? String(nextBrief).padStart(4, '0') : '...'}</span>
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
                  options={options?.briefTypes?.map((b) => ({ value: b, label: b === 'NN' ? 'NN (New)' : 'IT (Iteration)' })) || []}
                />
                <div>
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
                  {Object.keys(editorCounts).length > 0 && (
                    <div className="flex gap-2 mt-1">
                      {options?.editors?.map((ed) => (
                        <span key={ed} className="text-[10px] text-text-faint leading-none">
                          {ed} <span className="font-mono text-text-muted">{editorCounts[ed] || 0}</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
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
              <Button type="submit" loading={loading} disabled={!form.angle || !form.creativeType || !form.editor || !form.avatar} className="w-full" size="lg">
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
                      <span className="text-xs font-mono text-text-primary truncate pr-2">{brief.name}</span>
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
