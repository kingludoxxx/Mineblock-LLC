import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Plus, Waypoints, X } from 'lucide-react';
import api from '../../services/api';
import Button from '../../components/ui/Button';

const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

export const slugify = (name) =>
  String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

export function StatusPill({ status }) {
  const styles =
    status === 'live' || status === 'published'
      ? 'bg-green-500/10 text-green-400 border-green-500/20'
      : status === 'draft'
        ? 'bg-bg-elevated text-text-muted border-border-default'
        : 'bg-accent-muted text-accent-text border-accent/20';
  return (
    <span className={`px-2 py-0.5 text-[11px] rounded-full border capitalize ${styles}`}>
      {status || 'draft'}
    </span>
  );
}

function CreateFunnelModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const slug = slugify(name);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.post('/funnels', { name: name.trim() });
      onCreated(res.data?.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create funnel');
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
          <h2 className="text-lg font-semibold text-text-primary">Create funnel</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-xs uppercase tracking-wider text-text-faint mb-1.5">
              Name
            </label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Puure Collagen VSL"
              className="w-full px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-md text-text-primary placeholder:text-text-faint focus:outline-none focus:border-border-strong"
            />
          </div>
          <div className="text-xs text-text-muted">
            Slug:{' '}
            <span className="text-text-primary font-mono">{slug || '—'}</span>
          </div>
          {error && <div className="text-sm text-red-400">{error}</div>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={saving} disabled={!name.trim()}>
              Create
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function FunnelsPage() {
  const navigate = useNavigate();
  const [funnels, setFunnels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const debounceRef = useRef(null);
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = {};
      if (query) params.q = query;
      if (showArchived) params.archived = 'true';
      const res = await api.get('/funnels', { params });
      setFunnels(res.data?.data?.funnels || []);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load funnels');
      setFunnels([]);
    } finally {
      setLoading(false);
    }
  }, [query, showArchived]);

  useEffect(() => {
    load();
  }, [load]);

  const onSearch = (value) => {
    setQ(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setQuery(value), 300);
  };

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">Funnels</h1>
          <p className="mt-1 text-sm text-text-muted">
            Build and manage sales funnels: pages, flows and checkout paths.
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)}>
          <Plus className="w-4 h-4" /> Create funnel
        </Button>
      </div>

      <div className="bg-bg-card border border-border-default rounded-xl px-3 py-2 flex items-center gap-3">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Search className="w-4 h-4 text-text-faint shrink-0" />
          <input
            value={q}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search by name or slug..."
            className="w-full bg-transparent text-sm text-text-primary placeholder:text-text-faint focus:outline-none py-1.5"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-text-muted cursor-pointer shrink-0">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            className="accent-current"
          />
          Archived
        </label>
      </div>

      <div className="bg-bg-card border border-border-default rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider text-text-faint border-b border-border-subtle">
                <th className="text-left font-medium px-4 py-3">Funnel</th>
                <th className="text-left font-medium px-4 py-3">Slug</th>
                <th className="text-left font-medium px-4 py-3">Status</th>
                <th className="text-right font-medium px-4 py-3">Pages</th>
                <th className="text-left font-medium px-4 py-3">Updated</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-4 py-16 text-center text-text-muted">
                    Loading funnels...
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={5} className="px-4 py-16 text-center text-red-400">
                    {error}
                  </td>
                </tr>
              ) : funnels.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-16 text-center text-text-muted">
                    <Waypoints className="w-6 h-6 mx-auto mb-2 text-text-faint" />
                    No funnels yet. Create your first one.
                  </td>
                </tr>
              ) : (
                funnels.map((f) => (
                  <tr
                    key={f.id}
                    onClick={() => navigate(`/app/funnels/${f.id}`)}
                    className="border-b border-border-subtle last:border-0 hover:bg-bg-hover cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3 text-text-primary font-medium">{f.name}</td>
                    <td className="px-4 py-3 text-text-muted font-mono text-xs">/{f.slug}</td>
                    <td className="px-4 py-3">
                      <StatusPill status={f.status} />
                    </td>
                    <td className="px-4 py-3 text-right text-text-primary">{f.pages_count}</td>
                    <td className="px-4 py-3 text-text-muted whitespace-nowrap">
                      {fmtDate(f.updated_at)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-3 border-t border-border-subtle text-sm text-text-muted">
          {funnels.length} funnel{funnels.length === 1 ? '' : 's'}
        </div>
      </div>

      {showCreate && (
        <CreateFunnelModal
          onClose={() => setShowCreate(false)}
          onCreated={(funnel) => {
            setShowCreate(false);
            if (funnel?.id) navigate(`/app/funnels/${funnel.id}`);
            else load();
          }}
        />
      )}
    </div>
  );
}
