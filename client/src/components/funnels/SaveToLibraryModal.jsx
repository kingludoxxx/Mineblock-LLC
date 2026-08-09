// SAVE TO LIBRARY — the ingestion path the reference tool never built.
//
// funnel-os's router docblock advertises "save as template" and its
// lb_templates collection has a `workspace_id` branch in its list query, but no
// POST/PATCH/DELETE route exists anywhere in that repo — the branch can never
// be populated, so its library is permanently the 11 seeded system rows. This
// modal is that missing half: it snapshots the selected page's content into
// funnel_page_library (POST /api/v1/page-library), from where it can be cloned
// into ANY funnel.
//
// The entry is a SNAPSHOT, not a link. Editing the source page afterwards does
// not change the entry, and deleting the source funnel does not remove it. The
// subtitle says so, because an operator who believes this is a live reference
// will be surprised in exactly the expensive direction.
import { useEffect, useState } from 'react';
import { X, Library } from 'lucide-react';
import api from '../../services/api';
import Button from '../ui/Button';
import { typeMeta } from './pageTypes';

// MOUNTED ONLY WHILE OPEN (the canvas renders it behind `{page && ...}`), and
// KEYED ON THE PAGE ID there too. Both matter: a fresh mount is what seeds the
// name field from the page's own title with no reset effect, and the key is
// what stops a fast operator who clicks Save on page B while the modal is still
// showing page A from saving B under A's name.
export default function SaveToLibraryModal({ onClose, funnelId, page, onSaved }) {
  const [name, setName] = useState(page?.title || '');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [categories, setCategories] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Existing categories, so the operator picks an established bucket instead of
  // minting "Checkouts" next to "Checkout".
  useEffect(() => {
    let cancelled = false;
    api
      .get('/page-library?limit=1')
      .then((res) => {
        if (!cancelled) setCategories(res.data?.data?.categories || []);
      })
      .catch(() => {
        // A facet list is a convenience — failing to load it must not block a
        // save, and a free-text category still works.
        if (!cancelled) setCategories([]);
      });
    return () => { cancelled = true; };
  }, []);

  const save = async () => {
    if (saving || !page?.id) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.post('/page-library', {
        funnel_id: funnelId,
        page_id: page.id,
        name: name.trim() || undefined,
        description: description.trim() || undefined,
        category: category.trim() || undefined,
      });
      onSaved?.(res.data?.data);
      onClose?.();
    } catch (err) {
      const e = err.response?.data?.error;
      setError(e?.detail || e?.code || 'Failed to save that page to the library');
    } finally {
      setSaving(false);
    }
  };

  const meta = typeMeta(page?.type);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="w-full max-w-md flex flex-col bg-bg-card border border-border-default rounded-xl shadow-2xl overflow-hidden">
        <div className="shrink-0 flex items-start justify-between px-5 py-3.5 border-b border-border-subtle">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-base font-semibold text-text-primary">
              <Library className="w-4 h-4 text-text-muted" /> Save to page library
            </h2>
            <p className="mt-0.5 text-xs text-text-faint">
              Stores a snapshot of this page&apos;s blocks and code. Later edits to the page do not
              change the saved entry.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 flex flex-col gap-3">
          <div className="flex items-center gap-2 text-xs text-text-muted">
            <span
              className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider"
              style={{ color: meta.color, background: `${meta.color}1a`, border: `1px solid ${meta.color}33` }}
            >
              {meta.label}
            </span>
            <span className="font-mono truncate">{page?.slug}</span>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-text-faint">Name</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={page?.title || 'Untitled page'}
              className="px-2.5 py-1.5 text-sm bg-bg-elevated border border-border-default rounded-md text-text-primary placeholder:text-text-faint focus:outline-none focus:border-border-strong"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-text-faint">
              Category
            </span>
            <input
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Uncategorized"
              list="page-library-categories"
              className="px-2.5 py-1.5 text-sm bg-bg-elevated border border-border-default rounded-md text-text-primary placeholder:text-text-faint focus:outline-none focus:border-border-strong"
            />
            <datalist id="page-library-categories">
              {categories.map((c) => (
                <option key={c.name} value={c.name} />
              ))}
            </datalist>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-text-faint">
              Notes <span className="normal-case tracking-normal font-normal">(optional)</span>
            </span>
            <textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this page for? When should it be reused?"
              className="px-2.5 py-1.5 text-sm bg-bg-elevated border border-border-default rounded-md text-text-primary placeholder:text-text-faint focus:outline-none focus:border-border-strong resize-none"
            />
          </label>

          {error && <p className="text-xs text-danger">{error}</p>}
        </div>

        <div className="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-border-subtle">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving} disabled={!page?.id}>
            Save to library
          </Button>
        </div>
      </div>
    </div>
  );
}
