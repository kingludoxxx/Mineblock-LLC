// Saved views — named filter presets over the orders list, per user.
//
// Ported from funnel-os's orders view-prefs UI (useOrderViewPrefs.js +
// the LBOrdersPage views strip). Interaction matches the reference: the views
// read as a tab strip, "All" is the always-present unsaved default, clicking a
// view applies its filters AND its sort in one go, and the active view offers
// "Save changes" the moment the live filter state diverges from what is stored.
//
// The divergence check is a stable-key comparison, not a JSON.stringify of two
// objects — key order differs between "what the server returned" and "what the
// user just built", and stringify would report every view as dirty forever.
import { useMemo, useState } from 'react';
import { Bookmark, Check, Plus, Trash2, X } from 'lucide-react';

// Canonical string for a filter set, so two equal sets always compare equal
// regardless of the order their keys happen to be in.
function filterKey(filters) {
  return Object.entries(filters || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('&');
}

function viewMatchesState(view, filters, sort) {
  return filterKey(view?.filters) === filterKey(filters) && (view?.sort || '') === (sort || '');
}

export default function SavedViewsBar({
  views,
  activeViewId,
  filters,
  sort,
  onApply,
  onCreate,
  onUpdate,
  onDelete,
  busy,
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [err, setErr] = useState(null);

  const activeView = useMemo(
    () => views.find((v) => v.id === activeViewId) || null,
    [views, activeViewId]
  );

  // "Dirty" only means something while a view is selected — with no view
  // active there is nothing for the live filters to have diverged FROM.
  const dirty = activeView ? !viewMatchesState(activeView, filters, sort) : false;
  const hasFilters = filterKey(filters).length > 0;

  const submitNew = async (e) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setErr(null);
    try {
      await onCreate(trimmed);
      setName('');
      setNaming(false);
    } catch (e2) {
      setErr(e2?.response?.data?.error || 'Could not save this view');
    }
  };

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <button
        onClick={() => onApply(null)}
        className={`px-2.5 py-1 text-sm font-medium rounded-md transition-colors cursor-pointer ${
          activeViewId == null
            ? 'bg-bg-elevated text-text-primary'
            : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'
        }`}
      >
        All
      </button>

      {views.map((v) => (
        <span key={v.id} className="inline-flex items-center">
          <button
            onClick={() => onApply(v)}
            title={filterKey(v.filters).replace(/&/g, ' · ') || 'No filters'}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-sm font-medium rounded-md transition-colors cursor-pointer ${
              v.id === activeViewId
                ? 'bg-bg-elevated text-text-primary'
                : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'
            }`}
          >
            <Bookmark className="w-3.5 h-3.5" />
            {v.name}
          </button>
          {v.id === activeViewId && (
            <button
              onClick={() => onDelete(v)}
              disabled={busy}
              title="Delete this view"
              className="ml-0.5 p-1 rounded-md text-text-faint hover:text-danger hover:bg-bg-hover cursor-pointer transition-colors disabled:opacity-40"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </span>
      ))}

      {dirty && (
        <button
          onClick={() => onUpdate(activeView)}
          disabled={busy}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md bg-accent-muted text-accent-text border border-accent/20 cursor-pointer disabled:opacity-40"
        >
          <Check className="w-3.5 h-3.5" /> Save changes
        </button>
      )}

      {naming ? (
        <form onSubmit={submitNew} className="inline-flex items-center gap-1">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            placeholder="View name"
            className="w-36 px-2 py-1 text-sm bg-bg-card border border-border-default rounded-md text-text-primary placeholder:text-text-faint focus:outline-none focus:border-border-strong"
          />
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="p-1 rounded-md text-emerald-400 hover:bg-bg-hover cursor-pointer disabled:opacity-40"
          >
            <Check className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              setNaming(false);
              setName('');
              setErr(null);
            }}
            className="p-1 rounded-md text-text-muted hover:bg-bg-hover cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </form>
      ) : (
        <button
          onClick={() => setNaming(true)}
          disabled={!hasFilters}
          title={
            hasFilters
              ? 'Save the current filters as a view'
              : 'Add a filter first — an empty view is just "All"'
          }
          className="inline-flex items-center gap-1 px-2 py-1 text-xs text-text-muted hover:text-text-primary border border-dashed border-border-strong rounded-md cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Plus className="w-3 h-3" /> Save view
        </button>
      )}

      {err && <span className="text-xs text-danger">{err}</span>}
    </div>
  );
}
