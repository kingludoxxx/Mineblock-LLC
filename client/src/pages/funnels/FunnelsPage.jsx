import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search,
  Plus,
  Waypoints,
  X,
  LayoutGrid,
  Rows3,
  BarChart3,
  ChevronRight,
  ArrowRight,
  Upload,
  Download,
  Copy,
  Trash2,
  RotateCcw,
} from 'lucide-react';
import api from '../../services/api';
import Button from '../../components/ui/Button';
import ImportFunnelModal from '../../components/funnels/ImportFunnelModal';
import DateRangePicker from '../../components/ui/DateRangePicker';
import { typeMeta } from '../../components/funnels/pageTypes';
import { fmtMoney, fmtInt, fmtRate, daysAgoIso, todayIso } from '../analytics/format';

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

const isPublished = (f) => f.status === 'published' || f.status === 'live';

// Two-letter initials chip for a funnel name ("Puure Collagen VSL" -> "PC").
const initialsOf = (name) => {
  const words = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return '?';
  return words
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
};

// Order a funnel's pages by walking the MAIN-edge chain in flow_layout from
// the home page; pages outside the chain are appended in their stored order
// (is_home first, then created). Feeds the flow summary and the thumbnail.
function orderedPages(funnel) {
  const pages = Array.isArray(funnel.page_types) ? funnel.page_types : [];
  if (!pages.length) return [];
  const byId = new Map(pages.map((p) => [p.id, p]));
  const next = new Map();
  // flow_layout is operator-shaped JSONB — `edges` can be missing, or (after a
  // bad import/manual edit) not an array at all. A non-array must degrade to
  // "no flow chain" (pages render in stored order), never a TypeError that
  // takes the whole Funnels list down.
  const edges = Array.isArray(funnel.flow_layout?.edges) ? funnel.flow_layout.edges : [];
  for (const e of edges) {
    if (!e || typeof e !== 'object') continue;
    if ((e.kind || 'main') === 'main' && !next.has(e.source)) next.set(e.source, e.target);
  }
  const start = pages.find((p) => p.is_home) || pages[0];
  const chain = [];
  const seen = new Set();
  let cur = start;
  while (cur && !seen.has(cur.id)) {
    chain.push(cur);
    seen.add(cur.id);
    const nid = next.get(cur.id);
    cur = nid ? byId.get(nid) : null;
  }
  for (const p of pages) {
    if (!seen.has(p.id)) {
      chain.push(p);
      seen.add(p.id);
    }
  }
  return chain;
}

// Shown before an export file is written, and only when the envelope earned
// warnings. It names WHAT is about to leave — the operator is handing this file
// to someone, and "2 pages carry custom scripts" is the sentence that makes
// that a decision rather than a click.
function ExportConfirmModal({ pending, onCancel, onConfirm }) {
  const { funnel, warnings, stripped } = pending;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onCancel}>
      <div
        className="w-full max-w-md bg-bg-card border border-border-default rounded-xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-text-primary">Export {funnel.name}?</h2>
          <button onClick={onCancel} className="text-text-muted hover:text-text-primary cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-sm text-text-muted mb-3">This file contains:</p>
        <ul className="text-xs text-amber-300/90 space-y-1 pl-5 list-disc mb-3">
          {warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
        <p className="text-xs text-text-faint mb-4">
          Anyone who receives this file receives that code. Credentials never travel
          {stripped.length ? ` (${stripped.length} settings key${stripped.length === 1 ? '' : 's'} withheld)` : ''}.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button onClick={onConfirm}>
            <Download className="w-4 h-4" /> Export
          </Button>
        </div>
      </div>
    </div>
  );
}

// Shown before a funnel is copied.
//
// ⛔ THIS MODAL DOES NOT PREDICT WHAT WILL BE LEFT BEHIND. An earlier version
// listed "e.g. the Maps API key" as an example — a GUESS, hardcoded on the
// client, about a server-side allowlist it cannot see. It would have gone stale
// the moment the allowlist changed, and it named a key the funnel might not
// even have. The REAL list arrives in the response (`notes` / `stripped`) and
// is rendered after the copy is made. What this modal states is only what is
// true of EVERY duplicate: it is a draft, it is not the original, and the copy
// is composed rather than byte-cloned so some configuration does not travel.
function DuplicateConfirmModal({ funnel, busy, onCancel, onConfirm }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={busy ? undefined : onCancel}>
      <div
        className="w-full max-w-md bg-bg-card border border-border-default rounded-xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-text-primary">Duplicate {funnel.name}?</h2>
          <button onClick={onCancel} disabled={busy} className="text-text-muted hover:text-text-primary cursor-pointer disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-sm text-text-muted mb-3">
          Creates <span className="text-text-primary font-medium">{funnel.name} copy</span> as a
          new <span className="text-text-primary">draft</span> with its own pages, canvas layout and redirects.
        </p>
        <ul className="text-xs text-text-faint space-y-1 pl-5 list-disc mb-4">
          <li>The copy is never published and never carries a custom domain.</li>
          <li>Analytics, orders and split tests stay with the original.</li>
          <li>Some stored settings do not travel. We will list exactly which ones once the copy exists.</li>
        </ul>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button onClick={onConfirm} loading={busy}>
            <Copy className="w-4 h-4" /> Duplicate
          </Button>
        </div>
      </div>
    </div>
  );
}

// Restore puts a funnel back on a PUBLIC slug, so the confirmation is TYPED,
// not a click: the operator has to name the funnel they mean. That is also the
// only affordance in this trash view — there is deliberately NO permanent
// delete, here or on the server. Archive is the only "delete" in this codebase
// (funnels.js:875) and a trash screen is exactly where a second, irreversible
// one would get added by reflex.
function RestoreConfirmModal({ funnel, busy, onCancel, onConfirm }) {
  const [typed, setTyped] = useState('');
  const matches = typed.trim() === String(funnel.name).trim();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={busy ? undefined : onCancel}>
      <div
        className="w-full max-w-md bg-bg-card border border-border-default rounded-xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-text-primary">Restore this funnel?</h2>
          <button onClick={onCancel} disabled={busy} className="text-text-muted hover:text-text-primary cursor-pointer disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-sm text-text-muted mb-3">
          It returns to the funnels list as a draft. If another live funnel has taken
          <span className="text-text-primary font-mono"> /{funnel.slug}</span> in the meantime,
          this one comes back on a new slug and we will tell you what it is.
        </p>
        <label className="block text-xs uppercase tracking-wider text-text-faint mb-1.5">
          Type <span className="text-text-primary normal-case font-medium">{funnel.name}</span> to confirm
        </label>
        <input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className="w-full px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-md text-text-primary placeholder:text-text-faint focus:outline-none focus:border-border-strong mb-4"
          placeholder={funnel.name}
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button onClick={onConfirm} loading={busy} disabled={!matches}>
            <RotateCcw className="w-4 h-4" /> Restore
          </Button>
        </div>
      </div>
    </div>
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

// ── Grid view ───────────────────────────────────────────────────────────────

function FlowThumbnail({ pages }) {
  const shown = pages.slice(0, 5);
  return (
    <div className="h-16 rounded-md border border-border-subtle bg-bg-elevated/40 flex items-center px-3 gap-1 overflow-hidden">
      {shown.length === 0 ? (
        <span className="text-[10px] text-text-faint">No pages yet</span>
      ) : (
        shown.map((p, i) => {
          const meta = typeMeta(p.type);
          const Icon = meta.icon;
          return (
            <span key={p.id} className="flex items-center gap-1 shrink-0">
              {i > 0 && <ArrowRight className="w-2.5 h-2.5 text-text-faint" />}
              <span
                className="flex items-center gap-1 px-1.5 py-1 rounded-md border"
                style={{
                  background: `${meta.color}1f`,
                  borderColor: `${meta.color}33`,
                }}
                title={p.title || meta.label}
              >
                <Icon className="w-3 h-3" style={{ color: meta.color }} />
              </span>
            </span>
          );
        })
      )}
      {pages.length > 5 && (
        <span className="text-[10px] text-text-faint shrink-0">+{pages.length - 5}</span>
      )}
    </div>
  );
}

// `trashMode` swaps the card's action set entirely rather than adding to it: a
// trashed funnel cannot be exported or duplicated (the server refuses both),
// so showing those buttons would only produce errors the operator has to read.
function FunnelCard({ funnel, onOpen, onExport, exporting, onDuplicate, duplicating, onRestore, trashMode }) {
  const pages = orderedPages(funnel);
  const summary = pages.map((p) => typeMeta(p.type).label).join(' → ');
  return (
    // Review LOW #10: the export affordance lives on the CARD too — grid is the
    // default view, and an action that only exists in list view is an action
    // most operators never find. `relative` so the icon can sit over the card
    // without becoming a nested <button> inside the card's own <button>.
    <div className="relative">
    <button
      onClick={onOpen}
      className="w-full text-left bg-bg-card border border-border-default rounded-xl p-4 hover:border-border-strong hover:bg-bg-hover transition-colors cursor-pointer flex flex-col gap-3"
    >
      <FlowThumbnail pages={pages} />
      <div className="flex items-start gap-2.5">
        <span className="w-8 h-8 shrink-0 rounded-lg bg-accent-muted text-accent-text border border-accent/20 flex items-center justify-center text-[11px] font-semibold">
          {initialsOf(funnel.name)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text-primary truncate">{funnel.name}</span>
            <StatusPill status={isPublished(funnel) ? 'published' : 'draft'} />
          </div>
          <div className="text-[11px] text-text-faint truncate mt-0.5" title={summary}>
            {summary || 'Empty funnel'}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between text-[10px] text-text-faint font-mono">
        <span title={funnel.id}>{String(funnel.id).slice(0, 12)}</span>
        <span>{fmtDate(funnel.created_at)}</span>
      </div>
    </button>
      <div className="absolute top-2 right-2 flex items-center gap-0.5">
        {trashMode ? (
          <button
            onClick={(e) => { e.stopPropagation(); onRestore?.(funnel); }}
            title="Restore funnel"
            className="p-1.5 rounded-md text-text-faint hover:text-text-primary
              hover:bg-bg-elevated transition-colors cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        ) : (
          <>
            <button
              onClick={(e) => { e.stopPropagation(); onDuplicate?.(funnel); }}
              disabled={duplicating}
              title="Duplicate funnel"
              className="p-1.5 rounded-md text-text-faint hover:text-text-primary
                hover:bg-bg-elevated transition-colors cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onExport?.(funnel); }}
              disabled={exporting}
              title="Export as .json"
              className="p-1.5 rounded-md text-text-faint hover:text-text-primary
                hover:bg-bg-elevated transition-colors cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
            >
              <Download className="w-3.5 h-3.5" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function GridView({ funnels, onOpen, onCreate, onExport, exportingId, onDuplicate, duplicatingId, onRestore, trashMode }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {funnels.map((f) => (
        <FunnelCard
          key={f.id}
          funnel={f}
          onOpen={() => onOpen(f)}
          onExport={onExport}
          exporting={exportingId === f.id}
          onDuplicate={onDuplicate}
          duplicating={duplicatingId === f.id}
          onRestore={onRestore}
          trashMode={trashMode}
        />
      ))}
      {/* No "New Funnel" tile in the trash view — the trash is a list of things
          that already exist, and a create affordance there reads as a mistake. */}
      {!trashMode && (
        <button
          onClick={onCreate}
          className="min-h-[172px] rounded-xl border border-dashed border-border-default hover:border-border-strong hover:bg-bg-hover transition-colors cursor-pointer flex flex-col items-center justify-center gap-2 text-text-muted hover:text-text-primary"
        >
          <Plus className="w-5 h-5" />
          <span className="text-sm">New Funnel</span>
        </button>
      )}
    </div>
  );
}

// ── Metrics view ────────────────────────────────────────────────────────────
// Data: GET /funnel-analytics/funnels/overview?from&to — one row per
// non-archived funnel. null renders as "—" (unmeasured), never 0.

// Money cell for a batch row. When the window mixes currencies, formatting the
// sum as USD would assert a currency the number does not have — render the
// magnitude with an explicit '≈ … mixed' marker instead.
const fmtRowMoney = (v, m) => {
  if (m?.mixed_currency) {
    const n = Number(v);
    if (v === null || v === undefined || !Number.isFinite(n)) return '—';
    return `≈ ${n < 0 ? '−' : ''}${Math.abs(n).toFixed(2)} mixed`;
  }
  return fmtMoney(v, m?.currency);
};

function ExpandedPagesRow({ funnelId, from, to, colSpan }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let alive = true;
    setRows(null);
    setErr(null);
    api
      .get(`/funnel-analytics/funnel/${funnelId}/overview`, { params: { from, to } })
      .then((res) => {
        if (alive) setRows(res.data?.pages || []);
      })
      .catch((e) => {
        if (alive) setErr(e.response?.data?.error || 'Failed to load page metrics');
      });
    return () => {
      alive = false;
    };
  }, [funnelId, from, to]);

  return (
    <tr className="bg-bg-elevated/30">
      <td colSpan={colSpan} className="px-6 py-3">
        {err ? (
          <div className="text-xs text-red-400">{err}</div>
        ) : rows === null ? (
          <div className="text-xs text-text-muted">Loading page metrics…</div>
        ) : rows.length === 0 ? (
          <div className="text-xs text-text-muted">No pages with data in this window.</div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-text-faint">
                <th className="text-left font-medium py-1.5 pr-3">Page</th>
                <th className="text-right font-medium py-1.5 px-3">Visitors</th>
                <th className="text-right font-medium py-1.5 px-3">CTR*</th>
                <th className="text-right font-medium py-1.5 px-3">CVR</th>
                <th className="text-right font-medium py-1.5 px-3">Orders</th>
                <th className="text-right font-medium py-1.5 pl-3">Net</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const meta = typeMeta(p.type);
                // page_id can be null: the overview surfaces money-moved
                // sessions with no page reference as a synthetic '(no page)'
                // row so per-funnel totals match the batch.
                return (
                  <tr key={p.page_id ?? '(no page)'} className="border-t border-border-subtle/60">
                    <td className="py-1.5 pr-3">
                      <span className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: meta.color }} />
                        <span className="text-text-primary truncate max-w-[220px]">{p.title || p.slug || p.page_id}</span>
                      </span>
                    </td>
                    <td className="py-1.5 px-3 text-right text-text-muted tabular-nums">{fmtInt(p.visitors)}</td>
                    <td className="py-1.5 px-3 text-right text-text-muted tabular-nums">{fmtRate(p.ctr)}</td>
                    <td className="py-1.5 px-3 text-right text-text-muted tabular-nums">{fmtRate(p.cvr)}</td>
                    <td className="py-1.5 px-3 text-right text-text-muted tabular-nums">{fmtInt(p.orders)}</td>
                    <td className="py-1.5 pl-3 text-right text-text-muted tabular-nums">{fmtMoney(p.net_revenue)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="mt-1.5 text-[10px] text-text-faint">
          *CTR is a proxy (lower bound) — no click-through event is recorded.
        </div>
      </td>
    </tr>
  );
}

function MetricsView({ funnels, from, to, onRangeChange, onOpen }) {
  const [data, setData] = useState(null); // funnel_id -> metric row
  const [meta, setMeta] = useState(null); // {degraded, warnings}
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .get('/funnel-analytics/funnels/overview', { params: { from, to } })
      .then((res) => {
        if (!alive) return;
        const rows = res.data?.funnels || [];
        setData(Object.fromEntries(rows.map((r) => [r.funnel_id, r])));
        setMeta({ degraded: res.data?.degraded, warnings: res.data?.warnings || [] });
      })
      .catch((e) => {
        if (alive) setError(e.response?.data?.error || 'Failed to load funnel metrics');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [from, to]);

  const toggle = (id) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const COLS = 10;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-text-faint">
          Window is UTC. “—” means the source could not be measured — it is never a zero.
        </span>
        <DateRangePicker
          startDate={from}
          endDate={to}
          onChange={({ startDate, endDate }) => {
            if (startDate && endDate) onRangeChange(startDate, endDate);
          }}
        />
      </div>

      {meta?.degraded ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px] text-amber-200/90">
          <strong className="font-medium">Partial data.</strong> These sources did not answer:{' '}
          {meta.warnings.map((w) => w.source).join(', ')}. Their columns show “—”, never zero.
        </div>
      ) : null}

      <div className="bg-bg-card border border-border-default rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider text-text-faint border-b border-border-subtle">
                <th className="w-8 px-2 py-3" />
                <th className="text-left font-medium px-3 py-3">Funnel</th>
                <th className="text-right font-medium px-3 py-3">Visitors</th>
                <th className="text-right font-medium px-3 py-3">Sales</th>
                <th className="text-right font-medium px-3 py-3">Revenue</th>
                <th className="text-right font-medium px-3 py-3" title="Proxy — lower bound">CTR*</th>
                <th className="text-right font-medium px-3 py-3">AOV pre-upsell</th>
                <th className="text-right font-medium px-3 py-3">AOV post-upsell</th>
                <th className="text-right font-medium px-3 py-3">Refunds</th>
                <th className="text-right font-medium px-3 py-3">Net</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={COLS} className="px-4 py-16 text-center text-text-muted">
                    Loading metrics…
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={COLS} className="px-4 py-16 text-center text-red-400">
                    {error}
                  </td>
                </tr>
              ) : funnels.length === 0 ? (
                <tr>
                  <td colSpan={COLS} className="px-4 py-16 text-center text-text-muted">
                    No funnels match this filter. Archived funnels are excluded from metrics.
                  </td>
                </tr>
              ) : (
                funnels.map((f) => {
                  const m = data?.[f.id];
                  const open = expanded.has(f.id);
                  return (
                    <FunnelMetricsRow
                      key={f.id}
                      funnel={f}
                      metrics={m}
                      open={open}
                      onToggle={() => toggle(f.id)}
                      onOpen={() => onOpen(f)}
                      from={from}
                      to={to}
                      colSpan={COLS}
                    />
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-2.5 border-t border-border-subtle text-[10px] text-text-faint">
          *CTR is a labelled proxy (max of step-through and checkout-submit) — a lower bound, not a measured
          click-through. Revenue is gross (base + upsells); Net is gross − refunds.
        </div>
      </div>
    </div>
  );
}

function FunnelMetricsRow({ funnel, metrics: m, open, onToggle, onOpen, from, to, colSpan }) {
  return (
    <>
      <tr className="border-b border-border-subtle last:border-0 hover:bg-bg-hover transition-colors">
        <td className="px-2 py-3">
          <button
            onClick={onToggle}
            className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-elevated cursor-pointer"
            title={open ? 'Collapse pages' : 'Expand pages'}
          >
            <ChevronRight className={`w-4 h-4 transition-transform ${open ? 'rotate-90' : ''}`} />
          </button>
        </td>
        <td className="px-3 py-3">
          <button onClick={onOpen} className="flex items-center gap-2.5 cursor-pointer text-left">
            <span className="w-7 h-7 shrink-0 rounded-lg bg-accent-muted text-accent-text border border-accent/20 flex items-center justify-center text-[10px] font-semibold">
              {initialsOf(funnel.name)}
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-2">
                <span className="text-text-primary font-medium truncate max-w-[200px]">{funnel.name}</span>
                <StatusPill status={isPublished(funnel) ? 'published' : 'draft'} />
              </span>
              <span className="block text-[10px] text-text-faint font-mono">/{funnel.slug}</span>
            </span>
          </button>
        </td>
        <td className="px-3 py-3 text-right text-text-primary tabular-nums">
          {fmtInt(m?.visitors)}
          {m?.visitors_is_clamped && (
            <span
              className="ml-0.5 text-amber-400 cursor-help"
              title={`Raw count — orders (${m.orders}) exceed measured visitors (a lost beacon). Rates use the clamped denominator ${m.visitors_clamped}.`}
            >
              *
            </span>
          )}
        </td>
        <td className="px-3 py-3 text-right text-text-primary tabular-nums">{fmtInt(m?.orders)}</td>
        <td className="px-3 py-3 text-right text-text-primary tabular-nums">{fmtRowMoney(m?.gross_revenue, m)}</td>
        <td className="px-3 py-3 text-right text-text-muted tabular-nums">{fmtRate(m?.ctr)}</td>
        <td className="px-3 py-3 text-right text-text-muted tabular-nums">{fmtRowMoney(m?.aov_pre_upsell, m)}</td>
        <td className="px-3 py-3 text-right text-text-muted tabular-nums">{fmtRowMoney(m?.aov_post_upsell, m)}</td>
        <td className="px-3 py-3 text-right tabular-nums">
          <span className={m?.refunded > 0 ? 'text-danger' : 'text-text-muted'}>{fmtRowMoney(m?.refunded, m)}</span>
        </td>
        <td className="px-3 py-3 text-right tabular-nums">
          <span className={m?.net_revenue < 0 ? 'text-danger' : 'text-text-primary'}>
            {fmtRowMoney(m?.net_revenue, m)}
          </span>
          {m?.net_revenue_is_upper_bound && (
            <span
              className="ml-1 text-amber-400 cursor-help"
              title={`Upper bound: ${m.upsell_refunds_unmeasured} reversed upsell leg(s) have no measured refund amount anywhere, so actual net may be lower.`}
            >
              ⚠
            </span>
          )}
        </td>
      </tr>
      {open && <ExpandedPagesRow funnelId={funnel.id} from={from} to={to} colSpan={colSpan} />}
    </>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

// 'archived' is the server-side flag; "Trash" is what an operator calls it.
// The key stays `archived` because it IS the query parameter (`?archived=true`)
// — renaming it would only mean translating it back before every request.
const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'published', label: 'Published' },
  { key: 'draft', label: 'Draft' },
  { key: 'archived', label: 'Trash', icon: Trash2 },
];

const SORTS = [
  { key: 'created', label: 'Date Created' },
  { key: 'updated', label: 'Date Updated' },
  { key: 'name', label: 'Name' },
];

const FUNNEL_PAGE_SIZE = 100;

const VIEWS = [
  { key: 'grid', icon: LayoutGrid, title: 'Grid view' },
  { key: 'list', icon: Rows3, title: 'List view' },
  { key: 'metrics', icon: BarChart3, title: 'Metrics view' },
];

export default function FunnelsPage() {
  const navigate = useNavigate();
  const [funnels, setFunnels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  // Export is a per-row action, so its in-flight state is keyed by funnel id —
  // a single boolean would spin every row's icon at once.
  const [exportingId, setExportingId] = useState(null);
  const [rowError, setRowError] = useState(null);
  // Duplicate and restore each have a confirm step, so the pending funnel and
  // the in-flight id are separate: the modal stays up (and its button spins)
  // while the request runs, so a slow copy cannot be double-submitted.
  const [pendingDuplicate, setPendingDuplicate] = useState(null);
  const [duplicatingId, setDuplicatingId] = useState(null);
  const [pendingRestore, setPendingRestore] = useState(null);
  const [restoringId, setRestoringId] = useState(null);
  // Server-authored sentences (a rewritten slug, dropped settings keys). These
  // are FACTS ABOUT WHAT HAPPENED, not decoration — they are shown until the
  // operator's next action, never toasted away after three seconds.
  const [notice, setNotice] = useState(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [appending, setAppending] = useState(false);
  const debounceRef = useRef(null);
  const [query, setQuery] = useState('');
  const [viewMode, setViewMode] = useState('grid'); // 'grid' | 'list' | 'metrics'
  const [filter, setFilter] = useState('all'); // all | published | draft | archived
  const [sort, setSort] = useState('created');
  // Metrics window (defaults to the last 30 days, matching the server default).
  const [from, setFrom] = useState(() => daysAgoIso(29));
  const [to, setTo] = useState(() => todayIso());

  // GET /funnels has always been paged (page + limit, funnels.js:320) and this
  // page always asked for exactly one page and showed whatever came back. On a
  // list under the default that is invisible; on the 101st funnel — or a trash
  // that has been filling up for a year — it silently hides rows, and the trash
  // is the one view where a missing row means "I cannot get my funnel back".
  // Hence an explicit Load more that APPENDS rather than replaces.
  const load = useCallback(async (targetPage = 1, append = false) => {
    if (append) setAppending(true);
    else setLoading(true);
    setError(null);
    try {
      const params = { page: targetPage, limit: FUNNEL_PAGE_SIZE };
      if (query) params.q = query;
      if (filter === 'archived') params.archived = 'true';
      const res = await api.get('/funnels', { params });
      const rows = res.data?.data?.funnels || [];
      setFunnels((prev) => (append ? [...prev, ...rows] : rows));
      setHasMore(targetPage < (res.data?.data?.pages || 1));
      setPage(targetPage);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load funnels');
      // An APPEND that fails must not throw away the rows already on screen —
      // the operator loses their place for a failure that cost them nothing.
      if (!append) setFunnels([]);
      setHasMore(false);
    } finally {
      setLoading(false);
      setAppending(false);
    }
  }, [query, filter]);

  // A new filter or search term is a new list, always from page 1.
  useEffect(() => {
    load(1, false);
  }, [load]);

  const onSearch = (value) => {
    setQ(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setQuery(value), 300);
  };

  const visible = useMemo(() => {
    let rows = funnels;
    if (filter === 'published') rows = rows.filter(isPublished);
    else if (filter === 'draft') rows = rows.filter((f) => !isPublished(f));
    // 'archived' is already server-filtered; 'all' shows every non-archived.
    const sorted = [...rows];
    if (sort === 'name') sorted.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    else if (sort === 'updated')
      sorted.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
    else sorted.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    return sorted;
  }, [funnels, filter, sort]);

  const openFunnel = (f) => navigate(`/app/funnels/${f.id}`);

  // DECISION MADE: the funnels list carries the EXPORT trigger as well as the
  // import one. The import modal is the specified surface, but an export
  // endpoint with no button is an API, not a feature — there would be no way
  // to produce the file the modal consumes without devtools. One icon in the
  // list row is the smallest affordance that closes the loop.
  //
  // The envelope is written to a file client-side (same approach as
  // funnel-os's LBWebsitesPage.jsx:760-771) rather than served as an
  // attachment, because the endpoint is authed with a bearer token and a
  // plain <a download> could not carry it.
  // ── EXPORT: FETCH, THEN CONFIRM, THEN WRITE THE FILE ───────────────────
  // Review MED #8: export is the IRREVERSIBLE half of this feature. Once the
  // .json exists, whatever code it carries has already left — warning the
  // person who IMPORTS it is warning the wrong end of the transfer. So the
  // envelope is fetched first (a read), its own warnings are shown, and the
  // file is only written after the operator says yes.
  //
  // The envelope is written client-side (same approach as funnel-os's
  // LBWebsitesPage.jsx:760-771) rather than served as an attachment, because
  // the endpoint is authed with a bearer token and a plain <a download> could
  // not carry it.
  const [pendingExport, setPendingExport] = useState(null);

  const writeEnvelopeFile = (funnel, envelope) => {
    const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `funnel-${funnel.slug || funnel.id}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const exportFunnel = async (f) => {
    if (exportingId) return;
    setExportingId(f.id);
    setRowError(null);
    try {
      const res = await api.get(`/funnel-transfer/${f.id}/export`);
      const envelope = res.data?.data;
      if (!envelope?.format) throw new Error('empty envelope');
      // `stripped` rides in meta, NOT in the file — it names where this
      // deployment keeps its credentials, so it is shown to the operator here
      // and never written to disk.
      const stripped = res.data?.meta?.stripped || [];
      const warnings = Array.isArray(envelope.warnings) ? envelope.warnings : [];
      if (warnings.length) {
        setPendingExport({ funnel: f, envelope, warnings, stripped });
      } else {
        writeEnvelopeFile(f, envelope);
      }
    } catch (err) {
      const code = err?.response?.data?.error?.code;
      setRowError(
        code === 'funnel_archived'
          ? 'That funnel is archived. Restore it before exporting.'
          : code
            ? `Export failed: ${code}`
            : 'Export failed. Nothing was downloaded.'
      );
    } finally {
      setExportingId(null);
    }
  };

  // ── DUPLICATE ────────────────────────────────────────────────────────────
  // One POST. The whole copy — pages, blocks, canvas layout, redirects — is
  // composed server-side inside ONE transaction, so there is no half-copied
  // funnel to clean up if this request dies mid-flight.
  //
  // ⚠️ THE NAVIGATION USED TO EAT THE ANSWER. This handler previously called
  // navigate() the instant the 201 landed, which unmounted this page and threw
  // away `notes` — the server's list of what did NOT survive the copy (the
  // stripped credential, any trashed pages left behind). The operator was told
  // nothing and met the difference days later as a broken feature on the copy.
  //
  // So the rule is now: NOTES BEFORE NAVIGATION.
  //   • No notes  → straight to the copy, exactly as before. Nothing to say.
  //   • Any notes → stay here, render them, and offer an explicit "Open the
  //     copy" button. The same shape restoreFunnel uses (a notice that persists
  //     until the operator's next action), adapted with a navigation
  //     affordance so the copy is still one click away.
  // The builder page would have been the other place to render this, but it is
  // outside this lane's fence.
  const duplicateFunnel = async (f) => {
    if (duplicatingId) return;
    setDuplicatingId(f.id);
    setRowError(null);
    setNotice(null);
    try {
      const res = await api.post(`/funnels/${f.id}/duplicate`, { confirm: true });
      const data = res.data?.data;
      const notes = Array.isArray(data?.notes) ? data.notes : [];
      const copyId = data?.funnel?.id;
      const copyName = data?.funnel?.name || 'The copy';
      setPendingDuplicate(null);

      if (!notes.length) {
        if (copyId) navigate(`/app/funnels/${copyId}`);
        else load(1, false);
        return;
      }
      setNotice({
        title: `${copyName} was created.`,
        notes,
        gotoPath: copyId ? `/app/funnels/${copyId}` : null,
        gotoLabel: 'Open the copy',
      });
      load(1, false);
    } catch (err) {
      setRowError(err.response?.data?.error || 'Duplicate failed. Nothing was created.');
      setPendingDuplicate(null);
    } finally {
      setDuplicatingId(null);
    }
  };

  // ── RESTORE ──────────────────────────────────────────────────────────────
  // The response's `notes` are the point of this handler. A restore can come
  // back on a DIFFERENT slug (another live funnel took the old one), which
  // silently changes the funnel's public path — an operator who is not told
  // will point an ad at a URL that no longer resolves.
  const restoreFunnel = async (f) => {
    if (restoringId) return;
    setRestoringId(f.id);
    setRowError(null);
    setNotice(null);
    try {
      const res = await api.post(`/funnels/${f.id}/restore`, { confirm: true });
      const data = res.data?.data;
      const notes = Array.isArray(data?.notes) ? data.notes : [];
      setPendingRestore(null);
      setNotice({
        title: data?.restored ? `${f.name} was restored.` : `${f.name} was already live.`,
        notes,
      });
      load(1, false);
    } catch (err) {
      setRowError(err.response?.data?.error || 'Restore failed. The funnel is still in the trash.');
      setPendingRestore(null);
    } finally {
      setRestoringId(null);
    }
  };

  const trashMode = filter === 'archived';

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">Funnels</h1>
          <p className="mt-1 text-sm text-text-muted">
            Build and manage sales funnels: pages, flows and checkout paths.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => setShowImport(true)}>
            <Upload className="w-4 h-4" /> Import funnel
          </Button>
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="w-4 h-4" /> Create funnel
          </Button>
        </div>
      </div>

      <div className="bg-bg-card border border-border-default rounded-xl px-3 py-2 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-1 min-w-[200px]">
          <Search className="w-4 h-4 text-text-faint shrink-0" />
          <input
            value={q}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search by name or slug..."
            className="w-full bg-transparent text-sm text-text-primary placeholder:text-text-faint focus:outline-none py-1.5"
          />
        </div>

        {/* Filter chips */}
        <div className="flex items-center gap-1">
          {FILTERS.map((f) => {
            const Icon = f.icon;
            return (
              <button
                key={f.key}
                onClick={() => { setFilter(f.key); setNotice(null); setRowError(null); }}
                className={`px-2.5 py-1 rounded-full text-xs border transition-colors cursor-pointer inline-flex items-center gap-1 ${
                  filter === f.key
                    ? 'bg-accent-muted text-accent-text border-accent/30'
                    : 'bg-transparent text-text-muted border-border-default hover:text-text-primary hover:border-border-strong'
                }`}
              >
                {Icon ? <Icon className="w-3 h-3" /> : null}
                {f.label}
              </button>
            );
          })}
        </div>

        {/* Sort */}
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          className="px-2 py-1.5 text-xs bg-bg-elevated border border-border-default rounded-md text-text-muted focus:outline-none focus:border-border-strong cursor-pointer"
          title="Sort"
        >
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>

        {/* View mode toggles */}
        <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-bg-elevated border border-border-default">
          {VIEWS.map(({ key, icon: Icon, title }) => (
            <button
              key={key}
              onClick={() => setViewMode(key)}
              className={`p-1.5 rounded-md cursor-pointer transition-colors ${
                viewMode === key
                  ? 'bg-bg-hover text-accent-text'
                  : 'text-text-muted hover:text-text-primary'
              }`}
              title={title}
            >
              <Icon className="w-4 h-4" />
            </button>
          ))}
        </div>
      </div>

      {rowError && (
        <div className="bg-bg-card border border-red-500/20 rounded-xl px-4 py-2.5 text-sm text-red-400">
          {rowError}
        </div>
      )}

      {notice && (
        <div className="bg-bg-card border border-border-default rounded-xl px-4 py-2.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-text-primary">{notice.title}</div>
              {notice.notes.length > 0 && (
                <ul className="mt-1 text-xs text-amber-300/90 space-y-1 pl-5 list-disc">
                  {/* Server notes are SENTENCES, not ids — two pages whose slugs
                      were rewritten the same way produce byte-identical strings.
                      Keying on the text alone made React drop the duplicate, so
                      the operator was told about 2 of 3 rewrites. Key on
                      position + text. */}
                  {notice.notes.map((n, i) => <li key={`${i}:${n}`}>{n}</li>)}
                </ul>
              )}
              {notice.gotoPath && (
                <button
                  onClick={() => navigate(notice.gotoPath)}
                  className="mt-2 px-2 py-1 rounded-md text-xs text-text-primary border border-border-default
                    hover:border-border-strong hover:bg-bg-elevated transition-colors cursor-pointer inline-flex items-center gap-1"
                >
                  {notice.gotoLabel || 'Open'} <ArrowRight className="w-3 h-3" />
                </button>
              )}
            </div>
            <button onClick={() => setNotice(null)} className="text-text-muted hover:text-text-primary cursor-pointer shrink-0">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {trashMode && (
        <div className="text-xs text-text-faint">
          Trashed funnels stop serving immediately and keep all their pages. Restore puts one
          back as a draft. There is no permanent delete — nothing here is ever destroyed.
        </div>
      )}

      {viewMode === 'metrics' && trashMode ? (
        // Metrics + Trash was an EMPTY TABLE with no explanation: MetricsView is
        // handed [] for archived funnels (the analytics overview only covers
        // non-archived ones), so the operator saw a blank grid and could not
        // tell "no data" from "broken". Say which it is.
        <div className="bg-bg-card border border-border-default rounded-xl px-4 py-16 text-center">
          <BarChart3 className="w-6 h-6 mx-auto mb-2 text-text-faint" />
          <div className="text-sm text-text-primary">Metrics do not apply to trashed funnels.</div>
          <div className="text-xs text-text-faint mt-1">
            A trashed funnel stops serving, so it has no traffic to report. Switch to Grid or
            List to see what is in the trash, or pick another filter.
          </div>
        </div>
      ) : viewMode === 'metrics' ? (
        <MetricsView
          funnels={visible}
          from={from}
          to={to}
          onRangeChange={(s, e) => {
            setFrom(s);
            setTo(e);
          }}
          onOpen={openFunnel}
        />
      ) : loading ? (
        <div className="bg-bg-card border border-border-default rounded-xl px-4 py-16 text-center text-text-muted">
          Loading funnels...
        </div>
      ) : error ? (
        <div className="bg-bg-card border border-border-default rounded-xl px-4 py-16 text-center text-red-400">
          {error}
        </div>
      ) : viewMode === 'grid' ? (
        visible.length === 0 && filter !== 'all' ? (
          <div className="bg-bg-card border border-border-default rounded-xl px-4 py-16 text-center text-text-muted">
            {trashMode ? <Trash2 className="w-6 h-6 mx-auto mb-2 text-text-faint" />
              : <Waypoints className="w-6 h-6 mx-auto mb-2 text-text-faint" />}
            {trashMode ? 'The trash is empty.' : `No ${filter} funnels.`}
          </div>
        ) : (
          <GridView
            funnels={visible}
            onOpen={openFunnel}
            onCreate={() => setShowCreate(true)}
            onExport={exportFunnel}
            exportingId={exportingId}
            onDuplicate={(f) => { setNotice(null); setPendingDuplicate(f); }}
            duplicatingId={duplicatingId}
            onRestore={(f) => { setNotice(null); setPendingRestore(f); }}
            trashMode={trashMode}
          />
        )
      ) : (
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
                  <th className="text-right font-medium px-4 py-3">{trashMode ? 'Restore' : 'Actions'}</th>
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-16 text-center text-text-muted">
                      {trashMode ? (
                        <>
                          <Trash2 className="w-6 h-6 mx-auto mb-2 text-text-faint" />
                          The trash is empty.
                        </>
                      ) : (
                        <>
                          <Waypoints className="w-6 h-6 mx-auto mb-2 text-text-faint" />
                          No funnels yet. Create your first one.
                        </>
                      )}
                    </td>
                  </tr>
                ) : (
                  visible.map((f) => (
                    <tr
                      key={f.id}
                      onClick={() => openFunnel(f)}
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
                      <td className="px-4 py-3 text-right">
                        {trashMode ? (
                          // Restore is the ONLY action on a trashed row. There is
                          // deliberately no permanent-delete control — see
                          // RestoreConfirmModal.
                          <button
                            onClick={(e) => { e.stopPropagation(); setNotice(null); setPendingRestore(f); }}
                            title="Restore funnel"
                            className="px-2 py-1 rounded-md text-xs text-text-muted hover:text-text-primary hover:bg-bg-elevated
                              transition-colors cursor-pointer inline-flex items-center gap-1"
                          >
                            <RotateCcw className="w-3.5 h-3.5" /> Restore
                          </button>
                        ) : (
                          <span className="inline-flex items-center gap-0.5">
                            <button
                              onClick={(e) => { e.stopPropagation(); setNotice(null); setPendingDuplicate(f); }}
                              disabled={duplicatingId === f.id}
                              title="Duplicate funnel"
                              className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-elevated
                                transition-colors cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
                            >
                              <Copy className="w-4 h-4" />
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); exportFunnel(f); }}
                              disabled={exportingId === f.id}
                              title="Export as .json"
                              className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-elevated
                                transition-colors cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
                            >
                              <Download className="w-4 h-4" />
                            </button>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-3 border-t border-border-subtle text-sm text-text-muted">
            {visible.length} funnel{visible.length === 1 ? '' : 's'}
          </div>
        </div>
      )}

      {/* Load more applies to Grid and List (Metrics fetches its own window).
          It APPENDS, so an operator who scrolled to row 90 stays at row 90. */}
      {viewMode !== 'metrics' && hasMore && !loading && (
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={() => load(page + 1, true)}
            disabled={appending}
            className="px-3 py-1.5 rounded-md text-xs text-text-muted border border-border-default
              hover:text-text-primary hover:border-border-strong transition-colors cursor-pointer
              disabled:opacity-40 disabled:pointer-events-none"
          >
            {appending ? 'Loading…' : 'Load more'}
          </button>
          <span className="text-[11px] text-text-faint">
            Showing {funnels.length}
            {trashMode ? ' trashed funnels' : ' funnels'} so far
          </span>
        </div>
      )}

      {pendingExport && (
        <ExportConfirmModal
          pending={pendingExport}
          onCancel={() => setPendingExport(null)}
          onConfirm={() => {
            writeEnvelopeFile(pendingExport.funnel, pendingExport.envelope);
            setPendingExport(null);
          }}
        />
      )}

      {pendingDuplicate && (
        <DuplicateConfirmModal
          funnel={pendingDuplicate}
          busy={duplicatingId === pendingDuplicate.id}
          onCancel={() => setPendingDuplicate(null)}
          onConfirm={() => duplicateFunnel(pendingDuplicate)}
        />
      )}

      {pendingRestore && (
        <RestoreConfirmModal
          // Keyed by id so switching rows resets the typed-confirm field — a
          // name typed for one funnel must never satisfy the gate for another.
          key={pendingRestore.id}
          funnel={pendingRestore}
          busy={restoringId === pendingRestore.id}
          onCancel={() => setPendingRestore(null)}
          onConfirm={() => restoreFunnel(pendingRestore)}
        />
      )}

      {showImport && (
        <ImportFunnelModal
          onClose={() => setShowImport(false)}
          onImported={(data) => {
            setShowImport(false);
            // Straight to the new funnel's canvas — the operator's next act is
            // reading the pages that just landed, not the list they came from.
            if (data?.funnel?.id) navigate(`/app/funnels/${data.funnel.id}`);
            else load();
          }}
        />
      )}

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
