// VariantsGrid — the operator's cost worklist (NEW FILE, costs lane).
//
// One row per LIVE Shopify variant, sorted by 30d revenue descending — the
// row at the top is the one whose missing cost is distorting the most money.
//
// Three display rules carry the whole build:
//   · An empty cost renders as an unknown DASH, never "$0.00". An explicit
//     zero renders as "$0.00" and reads as a deliberate known-free claim.
//   · Margin renders as a dash whenever any cost is unknown. Never 100%.
//   · CONTEXTS is a list of chips, not one kind — variants sold as both a
//     main offer and an upsell are real, and their marginal shipping differs
//     by leg.
//
// Inline editing writes a VARIANT-scope rate only: one target, no fan-out.
// Anything wider (per-context shipping, a backdate, known-free) goes through
// the RateDrawer, which shows its exact target list before saving.
import { useMemo, useState } from 'react';
import { Check, ImageOff, Loader2, Pencil, X } from 'lucide-react';
import Input from '../../../components/ui/Input';
import {
  EM_DASH, computeMargin, costInputError, formatCost, isIgnored, matchesFilter,
  parseCostInput, paysShipping, primaryContext, resolveKind, resolveShip,
  rowCoverage, variantLabel,
} from '../costTargets';

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'needs_cost', label: 'Needs cost' },
  { key: 'ready', label: 'Ready' },
  { key: 'ignored', label: 'Ignored' },
];

/** Kind + context chips share one quiet chrome — status is a pill, never a fill. */
export function Chip({ children, tone = 'neutral', title }) {
  const cls = {
    neutral: 'bg-bg-elevated text-text-muted',
    good: 'bg-green-500/10 text-green-400 ring-1 ring-green-500/25',
    warn: 'bg-amber-500/10 text-amber-400 ring-1 ring-amber-500/25',
    bad: 'bg-danger/10 text-danger ring-1 ring-danger/25',
  }[tone];
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium whitespace-nowrap ${cls}`}
    >
      {children}
    </span>
  );
}

export function CoveragePill({ row }) {
  const cov = rowCoverage(row);
  if (isIgnored(row)) return <Chip tone="neutral">Ignored</Chip>;
  if (cov === 'none') return <Chip tone="warn">Needs cost</Chip>;
  if (cov === 'partial') return <Chip tone="warn" title="Cost known, shipping still unknown">Partial</Chip>;
  return <Chip tone="good">Ready</Chip>;
}

export function Thumb({ src, alt }) {
  if (!src) {
    return (
      <span className="h-8 w-8 shrink-0 rounded-md bg-bg-elevated inline-flex items-center justify-center">
        <ImageOff className="w-3.5 h-3.5 text-text-faint" />
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      className="h-8 w-8 shrink-0 rounded-md object-cover border border-border-default bg-bg-elevated"
    />
  );
}

/** A money cell that tells unknown ("—") and free ("$0.00") apart. */
export function CostText({ value, muted = false }) {
  const { state, text } = formatCost(value);
  if (state === 'unknown') {
    return <span className="text-text-faint" title="Unknown — no cost recorded">{EM_DASH}</span>;
  }
  const quiet = muted || state === 'free';
  return <span className={`tabular-nums ${quiet ? 'text-text-muted' : 'text-text-primary'}`}>{text}</span>;
}

/** Funnel entries may be bare ids or {funnel_id, funnel_name} objects. */
const funnelName = (f) => (f && typeof f === 'object' ? (f.funnel_name || f.name || f.funnel_id) : f);

function FunnelsCell({ funnels }) {
  const list = Array.isArray(funnels) ? funnels : [];
  if (!list.length) return <span className="text-text-faint">{EM_DASH}</span>;
  return (
    <span
      className="tabular-nums cursor-default underline decoration-dotted decoration-border-default underline-offset-2"
      title={`Wired on ${list.length} funnel${list.length === 1 ? '' : 's'}:\n${list.map(funnelName).join('\n')}`}
      data-testid="costs-funnels-count"
    >
      {list.length}
    </span>
  );
}

/**
 * Inline COGS editor. Blank clears to UNKNOWN (null on the wire); a typed 0 is
 * refused with the reason — a real $0.00 has to be deliberate ("known free"
 * lives in the drawer). That refusal is the fix for the reference's 24
 * fabricated free-shipping rows.
 */
export function CogsCell({ row, canEdit, saving, onSave, onOpenDrawer }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState(null);

  const begin = () => {
    setDraft(row.unit_cogs === null || row.unit_cogs === undefined ? '' : String(row.unit_cogs));
    setErr(null);
    setEditing(true);
  };
  const cancel = () => { setEditing(false); setErr(null); };
  const commit = () => {
    const parsed = parseCostInput(draft);
    if (parsed.error) { setErr(parsed.error); return; }
    setEditing(false);
    setErr(null);
    onSave(row, parsed.value);
  };

  if (!editing) {
    return (
      <div className="flex items-center justify-end gap-1.5">
        {row.cogs_source === 'item' && (
          <Chip tone="neutral" title="Resolved from a cost group">group</Chip>
        )}
        <CostText value={row.unit_cogs} />
        {saving && <Loader2 className="w-3 h-3 animate-spin text-text-muted" />}
        {canEdit && !saving && (
          <button
            type="button"
            onClick={begin}
            aria-label={`Edit cost for ${variantLabel(row)}`}
            data-testid={`costs-edit-${row.variant_id}`}
            className="p-1 rounded text-text-faint hover:text-text-primary transition-colors"
          >
            <Pencil className="w-3 h-3" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        <input
          autoFocus
          inputMode="decimal"
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setErr(null); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') cancel();
          }}
          placeholder="blank = unknown"
          aria-label={`Unit cost for ${variantLabel(row)}`}
          className="h-7 w-[104px] px-2 text-right tabular-nums text-xs bg-bg-elevated border border-border-default
                     rounded-md text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40"
          data-testid={`costs-input-${row.variant_id}`}
        />
        <button type="button" onClick={commit} aria-label="Save cost" className="p-1 text-text-muted hover:text-text-primary">
          <Check className="w-3 h-3" />
        </button>
        <button type="button" onClick={cancel} aria-label="Cancel" className="p-1 text-text-muted hover:text-text-primary">
          <X className="w-3 h-3" />
        </button>
      </div>
      {err && (
        <p className="text-[10px] text-danger text-right max-w-[190px] leading-snug" role="alert">
          {costInputError(err)}
          {err === 'zero_requires_known_free' && (
            <button
              type="button"
              onClick={() => { cancel(); onOpenDrawer?.(row); }}
              className="ml-1 underline decoration-dotted underline-offset-2"
            >
              Open rate editor
            </button>
          )}
        </p>
      )}
    </div>
  );
}

const TH = ({ children, right, className = '' }) => (
  <th
    className={`px-2 py-2 text-[10px] font-semibold uppercase tracking-wide text-text-muted whitespace-nowrap ${
      right ? 'text-right' : 'text-left'
    } ${className}`}
  >
    {children}
  </th>
);

export default function VariantsGrid({
  rows = [],
  loading = false,
  canEdit = false,
  filter = 'all',
  onFilterChange,
  search = '',
  onSearchChange,
  savingId = null,
  onSaveCogs,
  onOpenRate,
  onToggleIgnore,
}) {
  const counts = useMemo(() => {
    const c = { all: 0, needs_cost: 0, ready: 0, ignored: 0 };
    for (const f of Object.keys(c)) c[f] = rows.filter((r) => matchesFilter(r, f)).length;
    return c;
  }, [rows]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows
      .filter((r) => matchesFilter(r, filter))
      .filter((r) => !q
        || variantLabel(r).toLowerCase().includes(q)
        || String(r.variant_id).includes(q)
        || (r.funnels || []).some((f) => String(funnelName(f)).toLowerCase().includes(q)))
      .sort((a, b) => (Number(b.revenue_30d || 0) - Number(a.revenue_30d || 0))
        || variantLabel(a).localeCompare(variantLabel(b)));
  }, [rows, filter, search]);

  return (
    <div className="space-y-3" data-testid="costs-variants">
      {/* Filter chips + search */}
      <div className="flex items-center gap-2 flex-wrap">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => onFilterChange?.(f.key)}
            data-testid={`costs-filter-${f.key}`}
            className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-xs font-medium transition-colors
              ${filter === f.key
                ? 'bg-bg-elevated text-text-primary border border-border-default'
                : 'text-text-muted hover:text-text-primary border border-transparent'}`}
          >
            {f.label}
            <span className="tabular-nums text-[10px] text-text-faint">{counts[f.key]}</span>
          </button>
        ))}
        <div className="ml-auto w-[260px]">
          <Input
            value={search}
            onChange={(e) => onSearchChange?.(e.target.value)}
            placeholder="Search product, variant id or funnel…"
            aria-label="Search variants"
            className="h-8 text-xs"
            data-testid="costs-search"
          />
        </div>
      </div>

      <div className="rounded-xl border border-border-default bg-bg-card overflow-x-auto">
        <table className="w-full min-w-[1180px] border-collapse text-xs">
          <thead>
            <tr className="border-b border-border-default">
              <TH className="w-[46px]"> </TH>
              <TH>Product / variant</TH>
              <TH>Kind</TH>
              <TH>Contexts</TH>
              <TH right>Funnels</TH>
              <TH right>Units 30d</TH>
              <TH right>Price</TH>
              <TH right>COGS</TH>
              <TH right>Ship main</TH>
              <TH right>Ship upsell</TH>
              <TH right>Ship addon</TH>
              <TH right>Margin</TH>
              <TH>Coverage</TH>
              <TH className="w-[110px]"> </TH>
            </tr>
          </thead>
          <tbody>
            {loading && !rows.length ? (
              <tr>
                <td colSpan={14} className="py-10 text-center text-text-muted">Loading variants…</td>
              </tr>
            ) : !visible.length ? (
              <tr>
                <td colSpan={14} className="py-10 text-center text-text-muted" data-testid="costs-empty">
                  {rows.length
                    ? 'No variants match this filter.'
                    : 'No variants detected yet — run Detect now to scan sold variants.'}
                </td>
              </tr>
            ) : visible.map((row) => {
              const margin = computeMargin(row);
              const ships = paysShipping(row);
              const prim = primaryContext(row);
              return (
                <tr
                  key={row.variant_id}
                  className="border-b border-border-default/50 hover:bg-bg-elevated/40"
                  data-testid={`costs-row-${row.variant_id}`}
                >
                  <td className="px-2 py-2">
                    <Thumb src={row.image_url || row.image} alt={variantLabel(row)} />
                  </td>

                  <td className="px-2 py-2 max-w-[260px]">
                    <p className="truncate font-medium text-text-primary text-[12.5px]">
                      {row.product_title || EM_DASH}
                    </p>
                    <p className="truncate text-[10.5px] text-text-muted">
                      {row.variant_title || EM_DASH}
                      <span className="tabular-nums ml-1.5 text-text-faint">{row.variant_id}</span>
                    </p>
                  </td>

                  <td className="px-2 py-2">
                    <Chip
                      tone="neutral"
                      title={row.kind_override ? 'Pinned by an operator' : 'Detected from sales'}
                    >
                      {resolveKind(row)}
                      {row.kind_override ? ' ·pin' : ''}
                    </Chip>
                  </td>

                  <td className="px-2 py-2">
                    <span className="inline-flex flex-wrap gap-1">
                      {(row.contexts || []).length
                        ? row.contexts.map((c) => <Chip key={c} tone="neutral">{c}</Chip>)
                        : <span className="text-text-faint">{EM_DASH}</span>}
                    </span>
                  </td>

                  <td className="px-2 py-2 text-right"><FunnelsCell funnels={row.funnels} /></td>

                  <td className="px-2 py-2 text-right tabular-nums text-text-primary">
                    {Number(row.units_30d || 0).toLocaleString()}
                  </td>

                  <td className="px-2 py-2 text-right"><CostText value={row.price} muted /></td>

                  <td className="px-2 py-2 text-right">
                    <CogsCell
                      row={row}
                      canEdit={canEdit && !isIgnored(row)}
                      saving={savingId === row.variant_id}
                      onSave={onSaveCogs}
                      onOpenDrawer={onOpenRate}
                    />
                  </td>

                  {['main', 'upsell', 'addon'].map((ctx) => (
                    <td key={ctx} className="px-2 py-2 text-right">
                      {ships
                        ? <CostText value={resolveShip(row.ship, ctx)} muted={ctx !== prim} />
                        : (
                          <span className="text-text-faint" title="This variant does not carry a shipping cost">
                            n/a
                          </span>
                        )}
                    </td>
                  ))}

                  <td className="px-2 py-2 text-right">
                    {margin === null
                      ? (
                        <span className="text-text-faint" title="No cost entered — margin is unknown, not 100%">
                          {EM_DASH}
                        </span>
                      )
                      : <span className="tabular-nums text-text-primary">{margin.toFixed(1)}%</span>}
                  </td>

                  <td className="px-2 py-2"><CoveragePill row={row} /></td>

                  <td className="px-2 py-2 text-right whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => onOpenRate?.(row)}
                      data-testid={`costs-rate-${row.variant_id}`}
                      className="px-2 py-1 rounded-md text-[11px] text-text-muted hover:text-text-primary
                                 hover:bg-bg-elevated transition-colors"
                    >
                      Rates
                    </button>
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => onToggleIgnore?.(row)}
                        data-testid={`costs-ignore-${row.variant_id}`}
                        title={isIgnored(row)
                          ? 'Put this variant back on the worklist'
                          : 'Take this variant off the worklist (does not delete its rates)'}
                        className="px-2 py-1 rounded-md text-[11px] text-text-faint hover:text-text-primary
                                   hover:bg-bg-elevated transition-colors"
                      >
                        {isIgnored(row) ? 'Restore' : 'Ignore'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="text-[11px] text-text-faint">
        COGS is the cost of one unit <span className="italic">of the variant</span> — a &ldquo;5 Packs&rdquo; row
        holds the cost of the five-pack, not of one bottle. A blank cell means nobody has told us yet;{' '}
        <span className="tabular-nums">$0.00</span> means known free.
        <span className="ml-1.5 px-1.5 py-0.5 rounded-full border border-border-default tabular-nums">
          {visible.length} shown
        </span>
      </div>
    </div>
  );
}
