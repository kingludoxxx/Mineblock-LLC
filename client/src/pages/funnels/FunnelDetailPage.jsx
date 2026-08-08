import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Archive,
  ArchiveRestore,
  Home,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import api from '../../services/api';
import Button from '../../components/ui/Button';
import { StatusPill } from './FunnelsPage';

const PAGE_TYPES = [
  'generic',
  'listicle',
  'lead',
  'quiz',
  'checkout',
  'upsell',
  'downsell',
  'thankyou',
];

const inputCls =
  'w-full px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-md text-text-primary placeholder:text-text-faint focus:outline-none focus:border-border-strong';
const labelCls = 'block text-xs uppercase tracking-wider text-text-faint mb-1.5';

function AddPageModal({ funnelId, onClose, onCreated }) {
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [type, setType] = useState('generic');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await api.post(`/funnels/${funnelId}/pages`, { title, slug, type });
      onCreated();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create page');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-md bg-bg-card border border-border-default rounded-xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-text-primary">Add page</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className={labelCls}>Title</label>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Sales Page"
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>Slug</label>
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="/ or /sales-page"
              className={`${inputCls} font-mono`}
            />
          </div>
          <div>
            <label className={labelCls}>Type</label>
            <select value={type} onChange={(e) => setType(e.target.value)} className={inputCls}>
              {PAGE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          {error && <div className="text-sm text-red-400">{error}</div>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={saving} disabled={!title.trim() || !slug.trim()}>
              Add page
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function PageEditor({ funnelId, page, onClose, onSaved }) {
  const [title, setTitle] = useState(page.title || '');
  const [slug, setSlug] = useState(page.slug || '');
  const [type, setType] = useState(page.type || 'generic');
  const [status, setStatus] = useState(page.status || 'draft');
  const [isHome, setIsHome] = useState(!!page.is_home);
  const [blocksText, setBlocksText] = useState(JSON.stringify(page.blocks ?? [], null, 2));
  const [jsonError, setJsonError] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const onBlocksChange = (text) => {
    setBlocksText(text);
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) setJsonError('Blocks must be a JSON array');
      else setJsonError(null);
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
    try {
      await api.patch(`/funnels/${funnelId}/pages/${page.id}`, {
        title,
        slug,
        type,
        status,
        is_home: isHome,
        blocks,
      });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save page');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-xl h-full bg-bg-card border-l border-border-default overflow-y-auto p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">Edit page</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className={labelCls}>Title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Slug</label>
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              className={`${inputCls} font-mono`}
            />
          </div>
          <div>
            <label className={labelCls}>Type</label>
            <select value={type} onChange={(e) => setType(e.target.value)} className={inputCls}>
              {PAGE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputCls}>
              <option value="draft">draft</option>
              <option value="live">live</option>
            </select>
          </div>
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 text-sm text-text-muted cursor-pointer">
              <input
                type="checkbox"
                checked={isHome}
                onChange={(e) => setIsHome(e.target.checked)}
              />
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
            rows={16}
            className={`${inputCls} font-mono text-xs leading-relaxed resize-y`}
          />
          {jsonError && <div className="mt-1.5 text-sm text-red-400">{jsonError}</div>}
        </div>

        {error && <div className="text-sm text-red-400">{error}</div>}

        <div className="flex justify-end gap-2 pb-4">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving} disabled={!!jsonError}>
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function FunnelDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [funnel, setFunnel] = useState(null);
  const [pages, setPages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showAddPage, setShowAddPage] = useState(false);
  const [editingPage, setEditingPage] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get(`/funnels/${id}`);
      const d = res.data?.data || {};
      setFunnel(d.funnel || null);
      setPages(d.pages || []);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load funnel');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const archiveFunnel = async () => {
    if (busy || !funnel) return;
    setBusy(true);
    try {
      await api.post(`/funnels/${id}/archive`, { archived: !funnel.archived });
      if (!funnel.archived) navigate('/app/funnels');
      else await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to archive funnel');
    } finally {
      setBusy(false);
    }
  };

  const archivePage = async (pageId) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.post(`/funnels/${id}/pages/${pageId}/archive`, { archived: true });
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to archive page');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div className="p-6 text-text-muted">Loading funnel...</div>;
  }
  if (!funnel) {
    return (
      <div className="p-6 space-y-4">
        <div className="text-red-400">{error || 'Funnel not found'}</div>
        <Button variant="secondary" onClick={() => navigate('/app/funnels')}>
          <ArrowLeft className="w-4 h-4" /> Back to funnels
        </Button>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <button
            onClick={() => navigate('/app/funnels')}
            className="mt-1 text-text-muted hover:text-text-primary cursor-pointer"
            title="Back to funnels"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-semibold text-text-primary truncate">{funnel.name}</h1>
              <StatusPill status={funnel.status} />
              {funnel.archived && (
                <span className="px-2 py-0.5 text-[11px] rounded-full border bg-red-500/10 text-red-400 border-red-500/20">
                  archived
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-text-muted font-mono">/{funnel.slug}</p>
          </div>
        </div>
        <Button variant="secondary" onClick={archiveFunnel} loading={busy}>
          {funnel.archived ? (
            <>
              <ArchiveRestore className="w-4 h-4" /> Restore
            </>
          ) : (
            <>
              <Archive className="w-4 h-4" /> Archive
            </>
          )}
        </Button>
      </div>

      {error && <div className="text-sm text-red-400">{error}</div>}

      <div className="bg-bg-card border border-border-default rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
          <span className="text-sm font-medium text-text-primary">Pages</span>
          <Button size="sm" onClick={() => setShowAddPage(true)}>
            <Plus className="w-3.5 h-3.5" /> Add page
          </Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider text-text-faint border-b border-border-subtle">
                <th className="text-left font-medium px-4 py-3">Title</th>
                <th className="text-left font-medium px-4 py-3">Slug</th>
                <th className="text-left font-medium px-4 py-3">Type</th>
                <th className="text-left font-medium px-4 py-3">Status</th>
                <th className="text-right font-medium px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {pages.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-text-muted">
                    No pages yet. Add the first one — it becomes the home page.
                  </td>
                </tr>
              ) : (
                pages.map((p) => (
                  <tr key={p.id} className="border-b border-border-subtle last:border-0">
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-2">
                        <span className="text-text-primary font-medium">{p.title || '—'}</span>
                        {p.is_home && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded-full bg-accent-muted text-accent-text border border-accent/20">
                            <Home className="w-3 h-3" /> home
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-text-muted font-mono text-xs">{p.slug}</td>
                    <td className="px-4 py-3 text-text-muted">{p.type}</td>
                    <td className="px-4 py-3">
                      <StatusPill status={p.status} />
                    </td>
                    <td className="px-4 py-3">
                      <span className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => setEditingPage(p)}
                          className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer transition-colors"
                          title="Edit page"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => archivePage(p.id)}
                          className="p-1.5 rounded-md text-text-muted hover:text-red-400 hover:bg-bg-hover cursor-pointer transition-colors"
                          title="Trash page"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showAddPage && (
        <AddPageModal
          funnelId={id}
          onClose={() => setShowAddPage(false)}
          onCreated={() => {
            setShowAddPage(false);
            load();
          }}
        />
      )}

      {editingPage && (
        <PageEditor
          funnelId={id}
          page={editingPage}
          onClose={() => setEditingPage(null)}
          onSaved={() => {
            setEditingPage(null);
            load();
          }}
        />
      )}
    </div>
  );
}
