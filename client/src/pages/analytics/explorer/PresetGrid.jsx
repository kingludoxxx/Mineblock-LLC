/**
 * PresetGrid — the ported preset catalogue from GET /funnel-metrics/presets,
 * grouped by category. Clicking one LOADS IT INTO THE BUILDER (it does not run
 * a private query), so the operator can see exactly which metrics × group-by a
 * preset is, and edit from there.
 *
 * The catalogue vocabulary is {id, label, category, query, mode} — tolerated
 * aliases only, never invented: a preset with no id is skipped rather than
 * given a synthetic one, because a synthetic id would break the ?report= deep
 * link that names it.
 */
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { explorerApiError, fetchPresets } from './explorerApi';

const UNCATEGORISED = 'Reports';

function normalisePreset(p) {
  if (!p || typeof p !== 'object') return null;
  const id = typeof p.id === 'string' ? p.id : '';
  if (!id) return null;
  return {
    id,
    label: (typeof p.label === 'string' && p.label) || (typeof p.name === 'string' && p.name) || id,
    category: (typeof p.category === 'string' && p.category) || UNCATEGORISED,
    description: typeof p.description === 'string' ? p.description : '',
    mode: p.mode === 'roas' || p.mode === 'clicks' ? p.mode : 'query',
    query: p.query && typeof p.query === 'object' ? p.query : null,
  };
}

export default function PresetGrid({ activeId, onPick }) {
  const [presets, setPresets] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await fetchPresets();
        if (!alive) return;
        setPresets(list.map(normalisePreset).filter(Boolean));
      } catch (e) {
        if (alive) setError(explorerApiError(e, 'Preset catalogue unavailable.'));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  // Nothing to show and nothing to explain — stay out of the way entirely.
  if (!loading && !error && !presets.length) return null;

  const categories = [];
  presets.forEach((p) => {
    let bucket = categories.find((c) => c.name === p.category);
    if (!bucket) { bucket = { name: p.category, items: [] }; categories.push(bucket); }
    bucket.items.push(p);
  });

  return (
    <div className="rounded-xl border border-border-default bg-bg-card" data-testid="ax-presets">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-text-primary cursor-pointer"
        data-testid="ax-presets-toggle"
      >
        {open ? <ChevronDown className="w-4 h-4 text-text-muted" /> : <ChevronRight className="w-4 h-4 text-text-muted" />}
        Presets
        <span className="text-xs text-text-faint font-normal">
          {loading ? 'loading…' : error ? 'unavailable' : `${presets.length} reports`}
        </span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3">
          {error ? (
            <p className="text-xs text-text-muted" data-testid="ax-presets-error">{error}</p>
          ) : categories.map((cat) => (
            <div key={cat.name}>
              <p className="text-[10px] uppercase tracking-wider text-text-faint font-semibold mb-1.5">
                {cat.name}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
                {cat.items.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => onPick?.(p)}
                    title={p.description || p.label}
                    className={`text-left rounded-lg border px-3 py-2 text-xs transition-colors cursor-pointer
                      ${activeId === p.id
                        ? 'border-accent/50 bg-accent-muted text-accent-text'
                        : 'border-border-default bg-bg-elevated text-text-primary hover:border-border-strong hover:bg-bg-hover'}`}
                    data-testid={`ax-preset-${p.id}`}
                  >
                    <span className="block font-medium truncate">{p.label}</span>
                    {p.mode !== 'query' && (
                      <span className="block text-[10px] text-text-faint mt-0.5">{p.mode}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
