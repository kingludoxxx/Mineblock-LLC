import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Check } from 'lucide-react';
import api from '../../services/api';
import Button from '../../components/ui/Button';

// Slice-3 page editor: the slice-1 form fields (title/slug/type/status/is_home)
// plus the JSON blocks textarea, promoted from FunnelDetailPage into its own
// route (/app/funnels/:id/pages/:pageId), reachable from a canvas node's edit.
// The full drag-drop block builder is a LATER slice — this stays form + JSON.

const PAGE_TYPES = ['generic', 'listicle', 'lead', 'quiz', 'checkout', 'upsell', 'downsell', 'thankyou'];

const inputCls =
  'w-full px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-md text-text-primary placeholder:text-text-faint focus:outline-none focus:border-border-strong';
const labelCls = 'block text-xs uppercase tracking-wider text-text-faint mb-1.5';

export default function FunnelPageEditorPage() {
  const { id, pageId } = useParams();
  const navigate = useNavigate();

  const [funnel, setFunnel] = useState(null);
  const [page, setPage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [type, setType] = useState('generic');
  const [status, setStatus] = useState('draft');
  const [isHome, setIsHome] = useState(false);
  const [blocksText, setBlocksText] = useState('[]');
  const [jsonError, setJsonError] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await api.get(`/funnels/${id}`);
      const d = res.data?.data || {};
      const p = (d.pages || []).find((x) => x.id === pageId);
      setFunnel(d.funnel || null);
      if (!p) {
        setLoadError('Page not found');
      } else {
        setPage(p);
        setTitle(p.title || '');
        setSlug(p.slug || '');
        setType(p.type || 'generic');
        setStatus(p.status || 'draft');
        setIsHome(!!p.is_home);
        setBlocksText(JSON.stringify(p.blocks ?? [], null, 2));
      }
    } catch (err) {
      setLoadError(err.response?.data?.error || 'Failed to load page');
    } finally {
      setLoading(false);
    }
  }, [id, pageId]);

  useEffect(() => {
    load();
  }, [load]);

  const onBlocksChange = (text) => {
    setBlocksText(text);
    try {
      const parsed = JSON.parse(text);
      setJsonError(Array.isArray(parsed) ? null : 'Blocks must be a JSON array');
    } catch (err) {
      setJsonError(`Invalid JSON: ${err.message}`);
    }
  };

  const save = async () => {
    if (saving || jsonError) return;
    let blocks;
    try {
      blocks = JSON.parse(blocksText);
    } catch (err) {
      setJsonError(`Invalid JSON: ${err.message}`);
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await api.patch(`/funnels/${id}/pages/${pageId}`, {
        title,
        slug,
        type,
        status,
        is_home: isHome,
        blocks,
      });
      setPage(res.data?.data || page);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save page');
    } finally {
      setSaving(false);
    }
  };

  const preview = async () => {
    try {
      const res = await api.get(`/funnels/${id}/pages/${pageId}/preview-url`);
      const { path, preview: isPreview } = res.data?.data || {};
      if (path) window.open(isPreview ? `${path}?preview=1` : path, '_blank', 'noopener');
    } catch {
      setError('Failed to build preview URL');
    }
  };

  if (loading) return <div className="p-6 text-text-muted">Loading page…</div>;
  if (loadError || !page) {
    return (
      <div className="p-6 space-y-4">
        <div className="text-danger">{loadError || 'Page not found'}</div>
        <Button variant="secondary" onClick={() => navigate(`/app/funnels/${id}`)}>
          <ArrowLeft className="w-4 h-4" /> Back to canvas
        </Button>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => navigate(`/app/funnels/${id}`)}
            className="text-text-muted hover:text-text-primary cursor-pointer"
            title="Back to canvas"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-text-primary truncate">Edit page</h1>
            <p className="text-xs text-text-faint font-mono truncate">
              {funnel?.name} · /f/{funnel?.slug}
              {page.slug === '/' ? '' : page.slug}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={preview}>
            <ExternalLink className="w-4 h-4" /> Preview
          </Button>
          <Button size="sm" onClick={save} loading={saving} disabled={!!jsonError}>
            {saved ? (<><Check className="w-4 h-4" /> Saved</>) : 'Save'}
          </Button>
        </div>
      </div>

      <div className="bg-bg-card border border-border-default rounded-xl p-5 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className={labelCls}>Title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Slug</label>
            <input value={slug} onChange={(e) => setSlug(e.target.value)} className={`${inputCls} font-mono`} />
          </div>
          <div>
            <label className={labelCls}>Type</label>
            <select value={type} onChange={(e) => setType(e.target.value)} className={inputCls}>
              {PAGE_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputCls}>
              <option value="draft">draft</option>
              <option value="live">live</option>
              <option value="published">published</option>
            </select>
          </div>
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 text-sm text-text-muted cursor-pointer">
              <input type="checkbox" checked={isHome} onChange={(e) => setIsHome(e.target.checked)} />
              Home page
            </label>
          </div>
        </div>

        <div>
          <label className={labelCls}>Blocks (JSON)</label>
          <textarea
            value={blocksText}
            onChange={(e) => onBlocksChange(e.target.value)}
            spellCheck={false}
            rows={18}
            className={`${inputCls} font-mono text-xs leading-relaxed resize-y`}
          />
          {jsonError && <div className="mt-1.5 text-sm text-danger">{jsonError}</div>}
          <p className="mt-1.5 text-xs text-text-faint">
            Array of {'{ type, props }'} blocks. The full drag-drop block builder lands in a later slice.
          </p>
        </div>

        {error && <div className="text-sm text-danger">{error}</div>}
      </div>
    </div>
  );
}
