// FunnelCostTable — FUNNEL → PRODUCT → variants, priced in place
// (NEW FILE, costs lane; ports the reference's FunnelCostGroups).
//
// The Variants grid is a worklist; this is the other job — open a funnel,
// walk what it sells, and price it. COGS and shipping boxes are IN the rows:
// the operator types 15, tabs, types 30, and the funnel gets costed in one
// pass.
//
// EVERY NUMBER HERE IS THIS FUNNEL'S OWN. Per contract v2, each variant row
// carries `own_revenue_30d` / `own_units_30d` — THIS funnel's split — beside
// the catalog-wide `revenue_30d`/`units_30d`. This view renders the own_*
// pair only: crediting a shared variant's catalog total to each funnel counts
// the same money twice. A variant wired on a funnel but never sold there
// reads 0.
//
// WHAT A ROW STILL SHARES: a cost is a property of the good, not the funnel —
// one variant, one rate ledger. Where a variant is wired into more than one
// funnel the row says so ("wired on N funnels"), because that is the blast
// radius of the edit.
import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Layers, Loader2 } from 'lucide-react';
import {
  EM_DASH, costInputError, fmtInt, fmtMoney, fmtMoney0, formatCost, parseCostInput, resolveShip,
} from '../costTargets';
import { Chip, Thumb } from './VariantsGrid';

const ROLE_LABEL = { main: 'Main', upsell: 'Upsell', addon: 'Add-on', bump: 'Bump' };
const SHIP_COLS = ['main', 'upsell', 'addon'];

/**
 * One inline money box. Blank means UNKNOWN and clears the value (null on the
 * wire); a typed 0 is refused with the reason. Commits on Enter or blur so a
 * tab-through prices a whole product — and only when the value actually
 * changed, so tabbing across a filled row writes nothing.
 */
export function MoneyInput({ value, saving, disabled, label, testId, onCommit }) {
  const [draft, setDraft] = useState(null); // null = not being edited
  const [err, setErr] = useState(null);
  const shown = draft !== null
    ? draft
    : (value === null || value === undefined ? '' : String(value));

  const commit = () => {
    if (draft === null) return;
    const parsed = parseCostInput(draft);
    if (parsed.error) { setErr(parsed.error); return; }
    setDraft(null);
    setErr(null);
    const current = value === null || value === undefined ? null : Number(value);
    if (parsed.value === current) return; // unchanged — no write
    onCommit(parsed.value);
  };

  if (disabled) {
    const { state, text } = formatCost(value);
    return (
      <span className={state === 'unknown' ? 'text-text-faint' : 'tabular-nums text-text-primary'}>
        {state === 'unknown' ? EM_DASH : text}
      </span>
    );
  }

  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <span className="inline-flex items-center gap-1">
        <input
          inputMode="decimal"
          value={shown}
          aria-label={label}
          data-testid={testId}
          placeholder={EM_DASH}
          onChange={(e) => { setDraft(e.target.value); setErr(null); }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') { setDraft(null); setErr(null); }
          }}
          className={`h-7 w-[74px] px-2 text-right tabular-nums text-xs bg-bg-elevated border rounded-md
                      text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40
                      ${err ? 'border-danger' : 'border-border-default'}`}
        />
        {saving && <Loader2 className="w-3 h-3 animate-spin text-text-muted" />}
      </span>
      {err && (
        <span className="text-[10px] text-danger max-w-[150px] text-right">{costInputError(err)}</span>
      )}
    </span>
  );
}

function VariantRow({ row, canEdit, savingId, onSaveCogs, onSaveShip }) {
  const saving = savingId === row.variant_id;
  const wired = Array.isArray(row.funnels) ? row.funnels.length : 0;
  return (
    <tr className="border-b border-border-default/40 last:border-0" data-testid="costs-fn-variant-row">
      <td className="py-1.5 pl-10 pr-2 max-w-0 w-[44%]">
        <span className="block truncate text-[12.5px] text-text-primary" title={row.variant_title || ''}>
          {row.variant_title || EM_DASH}
        </span>
        <span className="block text-[10.5px] text-text-muted tabular-nums">
          {row.variant_id}
          {wired > 1 && (
            <span
              className="ml-1.5 cursor-default underline decoration-dotted decoration-border-default underline-offset-2"
              title={`Wired on ${wired} funnels. The cost belongs to the product, so a change here applies wherever it sells — the units and revenue above stay this funnel's own.`}
            >
              wired on {wired} funnels
            </span>
          )}
        </span>
      </td>
      {/* This funnel's OWN split (contract own_*); null is unknown, not 0. */}
      <td className="px-2 text-right tabular-nums text-text-primary">{fmtInt(row.own_units_30d)}</td>
      <td className="px-2 text-right tabular-nums text-text-primary">{fmtMoney0(row.own_revenue_30d)}</td>
      <td className="px-2 text-right tabular-nums text-text-muted">
        {row.price ? fmtMoney(row.price) : EM_DASH}
      </td>
      <td className="px-2 text-right">
        <MoneyInput
          value={row.unit_cogs}
          saving={saving}
          disabled={!canEdit}
          label={`Unit cost for ${row.variant_title || row.variant_id}`}
          testId={`costs-fn-cogs-${row.variant_id}`}
          onCommit={(v) => onSaveCogs(row, v)}
        />
      </td>
      {SHIP_COLS.map((ctx) => (
        <td key={ctx} className="px-2 text-right">
          <MoneyInput
            value={resolveShip(row.ship, ctx)}
            saving={saving}
            disabled={!canEdit}
            label={`${ctx} shipping for ${row.variant_title || row.variant_id}`}
            testId={`costs-fn-ship-${ctx}-${row.variant_id}`}
            onCommit={(v) => onSaveShip(row, ctx, v)}
          />
        </td>
      ))}
      <td className="px-2 text-[11px] text-text-muted whitespace-nowrap">
        {(row.last_sold || '').slice(0, 10) || EM_DASH}
      </td>
    </tr>
  );
}

function ProductRow({ product, canEdit, savingId, onSaveCogs, onSaveShip, defaultOpen }) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const Caret = open ? ChevronDown : ChevronRight;
  // `missing_count` is the contract's; the fallback derivation matches it.
  const missing = product.missing_count
    ?? (product.variants || []).filter((v) => v.unit_cogs === null || v.unit_cogs === undefined).length;
  // The contract carries no product-level totals — sum THIS FUNNEL'S OWN
  // splits from the variants. All-null stays null (unknown, not $0).
  const ownSums = useMemo(() => {
    let units = null;
    let revenue = null;
    for (const v of product.variants || []) {
      if (v.own_units_30d !== null && v.own_units_30d !== undefined) {
        units = (units ?? 0) + Number(v.own_units_30d);
      }
      if (v.own_revenue_30d !== null && v.own_revenue_30d !== undefined) {
        revenue = (revenue ?? 0) + Number(v.own_revenue_30d);
      }
    }
    return { units, revenue };
  }, [product.variants]);

  return (
    <>
      <tr
        className="border-b border-border-default bg-bg-elevated/30 cursor-pointer"
        onClick={() => setOpen((v) => !v)}
        data-testid="costs-fn-product-row"
      >
        {/* max-w-0 + a share width is what makes truncate work inside a table —
            without it a long title pushes the cost boxes off-screen. */}
        <td className="py-2 pl-3 pr-2 max-w-0 w-[44%]">
          <span className="flex items-center gap-2 min-w-0">
            <Caret className="w-3.5 h-3.5 shrink-0 text-text-muted" />
            <Thumb src={product.image_url || product.image} alt={product.product_title} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-[13px] text-text-primary">
                {product.product_title}
              </span>
              <span className="block text-[10.5px] text-text-muted truncate">
                {(product.variants || []).length} variant{(product.variants || []).length === 1 ? '' : 's'}
              </span>
            </span>
            {product.role && <Chip tone="neutral">{ROLE_LABEL[product.role] || product.role}</Chip>}
          </span>
        </td>
        <td className="px-2 text-right tabular-nums text-text-primary">{fmtInt(ownSums.units)}</td>
        <td className="px-2 text-right tabular-nums font-medium text-text-primary">
          {fmtMoney0(ownSums.revenue)}
        </td>
        <td className="px-2 text-right tabular-nums text-text-muted">
          {/* Avg price is THIS funnel's revenue ÷ units. Unknown when nothing
              sold here — a $0.00 would read as "we gave it away". */}
          {product.avg_price === null || product.avg_price === undefined
            ? EM_DASH : fmtMoney(product.avg_price)}
        </td>
        <td className="px-2 text-right" colSpan={4}>
          {missing > 0
            ? <Chip tone="warn">{missing} missing</Chip>
            : <Chip tone="good">costed</Chip>}
        </td>
        <td />
      </tr>
      {open && (product.variants || []).map((v) => (
        <VariantRow
          key={v.variant_id}
          row={v}
          canEdit={canEdit}
          savingId={savingId}
          onSaveCogs={onSaveCogs}
          onSaveShip={onSaveShip}
        />
      ))}
    </>
  );
}

function FunnelGroup({ group, canEdit, savingId, onSaveCogs, onSaveShip, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  const Caret = open ? ChevronDown : ChevronRight;
  const atRisk = Number(group.revenue_at_risk_30d || 0);
  const missing = group.counts?.needs_cost || 0;
  const products = group.products || [];

  return (
    <section
      className="rounded-lg border border-border-default bg-bg-card overflow-hidden"
      data-testid="costs-funnel-group"
      data-funnel-id={group.funnel_id}
    >
      <header className="flex items-center gap-3 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-2 text-left min-w-0 flex-1"
          aria-expanded={open}
          data-testid="costs-funnel-toggle"
        >
          <Caret className="w-4 h-4 shrink-0 text-text-muted" />
          <Layers className="w-4 h-4 shrink-0 text-text-muted" />
          {/* Contract v2: the funnel's display name is `name`. */}
          <span className="truncate font-medium text-[13.5px] text-text-primary">
            {group.name || group.funnel_id}
          </span>
          <span className="text-[11.5px] text-text-muted shrink-0">
            · {products.length} product{products.length === 1 ? '' : 's'}
          </span>
          {group.known === false && (
            <Chip tone="neutral" title="This funnel no longer exists — the money it made still does.">
              archived
            </Chip>
          )}
        </button>

        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11.5px] text-text-muted tabular-nums">
            Revenue: {fmtMoney0(group.revenue_30d ?? 0)}
          </span>
          {missing > 0
            ? (
              <span title={`${fmtMoney(atRisk)} of this funnel's 30-day revenue is still booked at 100% margin.`}>
                <Chip tone="warn">{missing} missing</Chip>
              </span>
            )
            : <Chip tone="good">fully costed</Chip>}
        </div>
      </header>

      {open && (
        <div className="border-t border-border-default overflow-x-auto">
          <table className="w-full text-[12.5px]" data-testid="costs-funnel-table">
            <thead className="text-[10.5px] uppercase tracking-wide text-text-muted">
              <tr className="border-b border-border-default">
                <th className="px-3 py-1.5 text-left font-medium">Product</th>
                <th className="px-2 py-1.5 text-right font-medium">Units</th>
                <th className="px-2 py-1.5 text-right font-medium">Revenue</th>
                <th className="px-2 py-1.5 text-right font-medium">Avg price</th>
                <th className="px-2 py-1.5 text-right font-medium">COGS / unit</th>
                <th className="px-2 py-1.5 text-right font-medium">Ship main</th>
                <th className="px-2 py-1.5 text-right font-medium">Ship upsell</th>
                <th className="px-2 py-1.5 text-right font-medium">Ship addon</th>
                <th className="px-2 py-1.5 text-left font-medium">Last sold</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p, i) => (
                <ProductRow
                  key={p.shopify_product_id || p.product_title || i}
                  product={p}
                  canEdit={canEdit}
                  savingId={savingId}
                  onSaveCogs={onSaveCogs}
                  onSaveShip={onSaveShip}
                  /* The biggest earner opens itself — that is where the money is. */
                  defaultOpen={i === 0}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function FunnelCostTable({
  groups = [],
  loading = false,
  canEdit = false,
  savingId = null,
  onSaveCogs,
  onSaveShip,
}) {
  // DISTINCT variants, not the sum of the funnels' counts — funnels share
  // variants, and summing per-funnel counts inflates the worklist.
  const total = useMemo(() => {
    const seen = new Set();
    for (const g of groups) {
      for (const p of g.products || []) {
        for (const v of p.variants || []) {
          if ((v.coverage ?? v.status) === 'needs_cost') seen.add(String(v.variant_id));
        }
      }
    }
    return seen.size;
  }, [groups]);

  if (loading) {
    return (
      <div className="rounded-lg border border-border-default p-6 text-center text-[13px] text-text-muted">
        Loading funnels…
      </div>
    );
  }
  if (!groups.length) {
    return (
      <div
        className="rounded-lg border border-border-default p-6 text-center text-[13px] text-text-muted"
        data-testid="costs-funnels-empty"
      >
        No funnel has a detected variant yet. Run <span className="font-medium">Detect now</span> above.
      </div>
    );
  }
  return (
    <div className="space-y-3" data-testid="costs-funnel-groups">
      {total > 0 && (
        <p className="text-[11.5px] text-text-muted">
          {total === 1 ? '1 variant still needs a cost.' : `${total} variants still need a cost.`}{' '}
          Type into any box — blank leaves it unknown, and every change saves on its own.
        </p>
      )}
      {groups.map((g, i) => (
        <FunnelGroup
          key={g.funnel_id}
          group={g}
          canEdit={canEdit}
          savingId={savingId}
          onSaveCogs={onSaveCogs}
          onSaveShip={onSaveShip}
          /* The worst funnel opens itself — that is the one to work on. */
          defaultOpen={i === 0}
        />
      ))}
    </div>
  );
}
