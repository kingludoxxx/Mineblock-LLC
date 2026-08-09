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
} from 'lucide-react';
import api from '../../services/api';
import Button from '../../components/ui/Button';
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
  for (const e of funnel.flow_layout?.edges || []) {
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

function FunnelCard({ funnel, onOpen }) {
  const pages = orderedPages(funnel);
  const summary = pages.map((p) => typeMeta(p.type).label).join(' → ');
  return (
    <button
      onClick={onOpen}
      className="text-left bg-bg-card border border-border-default rounded-xl p-4 hover:border-border-strong hover:bg-bg-hover transition-colors cursor-pointer flex flex-col gap-3"
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
  );
}

function GridView({ funnels, onOpen, onCreate }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {funnels.map((f) => (
        <FunnelCard key={f.id} funnel={f} onOpen={() => onOpen(f)} />
      ))}
      <button
        onClick={onCreate}
        className="min-h-[172px] rounded-xl border border-dashed border-border-default hover:border-border-strong hover:bg-bg-hover transition-colors cursor-pointer flex flex-col items-center justify-center gap-2 text-text-muted hover:text-text-primary"
      >
        <Plus className="w-5 h-5" />
        <span className="text-sm">New Funnel</span>
      </button>
    </div>
  );
}

// ── Metrics view ────────────────────────────────────────────────────────────
// Data: GET /funnel-analytics/funnels/overview?from&to — one row per
// non-archived funnel. null renders as "—" (unmeasured), never 0.

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
                return (
                  <tr key={p.page_id} className="border-t border-border-subtle/60">
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
        <td className="px-3 py-3 text-right text-text-primary tabular-nums">{fmtInt(m?.visitors)}</td>
        <td className="px-3 py-3 text-right text-text-primary tabular-nums">{fmtInt(m?.orders)}</td>
        <td className="px-3 py-3 text-right text-text-primary tabular-nums">{fmtMoney(m?.gross_revenue, m?.currency)}</td>
        <td className="px-3 py-3 text-right text-text-muted tabular-nums">{fmtRate(m?.ctr)}</td>
        <td className="px-3 py-3 text-right text-text-muted tabular-nums">{fmtMoney(m?.aov_pre_upsell, m?.currency)}</td>
        <td className="px-3 py-3 text-right text-text-muted tabular-nums">{fmtMoney(m?.aov_post_upsell, m?.currency)}</td>
        <td className="px-3 py-3 text-right tabular-nums">
          <span className={m?.refunded > 0 ? 'text-danger' : 'text-text-muted'}>{fmtMoney(m?.refunded, m?.currency)}</span>
        </td>
        <td className="px-3 py-3 text-right tabular-nums">
          <span className={m?.net_revenue < 0 ? 'text-danger' : 'text-text-primary'}>
            {fmtMoney(m?.net_revenue, m?.currency)}
          </span>
        </td>
      </tr>
      {open && <ExpandedPagesRow funnelId={funnel.id} from={from} to={to} colSpan={colSpan} />}
    </>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'published', label: 'Published' },
  { key: 'draft', label: 'Draft' },
  { key: 'archived', label: 'Archived' },
];

const SORTS = [
  { key: 'created', label: 'Date Created' },
  { key: 'updated', label: 'Date Updated' },
  { key: 'name', label: 'Name' },
];

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
  const debounceRef = useRef(null);
  const [query, setQuery] = useState('');
  const [viewMode, setViewMode] = useState('grid'); // 'grid' | 'list' | 'metrics'
  const [filter, setFilter] = useState('all'); // all | published | draft | archived
  const [sort, setSort] = useState('created');
  // Metrics window (defaults to the last 30 days, matching the server default).
  const [from, setFrom] = useState(() => daysAgoIso(29));
  const [to, setTo] = useState(() => todayIso());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = {};
      if (query) params.q = query;
      if (filter === 'archived') params.archived = 'true';
      const res = await api.get('/funnels', { params });
      setFunnels(res.data?.data?.funnels || []);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load funnels');
      setFunnels([]);
    } finally {
      setLoading(false);
    }
  }, [query, filter]);

  useEffect(() => {
    load();
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
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-2.5 py-1 rounded-full text-xs border transition-colors cursor-pointer ${
                filter === f.key
                  ? 'bg-accent-muted text-accent-text border-accent/30'
                  : 'bg-transparent text-text-muted border-border-default hover:text-text-primary hover:border-border-strong'
              }`}
            >
              {f.label}
            </button>
          ))}
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

      {viewMode === 'metrics' ? (
        <MetricsView
          funnels={filter === 'archived' ? [] : visible}
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
            <Waypoints className="w-6 h-6 mx-auto mb-2 text-text-faint" />
            No {filter} funnels.
          </div>
        ) : (
          <GridView funnels={visible} onOpen={openFunnel} onCreate={() => setShowCreate(true)} />
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
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-16 text-center text-text-muted">
                      <Waypoints className="w-6 h-6 mx-auto mb-2 text-text-faint" />
                      No funnels yet. Create your first one.
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
