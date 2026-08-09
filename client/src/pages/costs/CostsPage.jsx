// CostsPage — the Costs workspace (NEW FILE, costs lane).
//
// Where a variant's cost actually gets entered, and where the processing fee
// gets switched on. Everything downstream — the P&L view especially — reads
// the catalog this page fills.
//
// TWO SOURCES, ON PURPOSE. The banner reads GET /coverage-summary, which
// counts the WHOLE catalog server-side; the grid reads a page of /variants.
// Deriving the headline from the loaded page would quietly under-report the
// moment the catalog outgrows one page. The client-side count is kept only as
// a fallback for when the summary call fails.
//
// Detection NEVER runs implicitly on a read — it is the server sweep or the
// button, nothing else.
//
// ── THE DEEP LINK (`?tab=`, `?filter=`, `?variant=`) ─────────────────────
// The query string is a SEED, not a master. Each param is read into ordinary
// state on the FIRST render (an effect would paint the By-funnel tab first
// and swap it under the operator), so a later click on another tab or filter
// chip keeps that choice. The re-sync effects fire only when the PARAM value
// itself changes — a second deep link, Back/Forward, or the plain nav link
// dropping all params. `useSearchParams` (a router-context CONSUMER) is what
// makes a navigation after mount reach this component at all.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Coins } from 'lucide-react';
import Card from '../../components/ui/Card';
import Tabs from '../../components/ui/Tabs';
import { usePermissions } from '../../hooks/usePermissions';
import CostsSubnav from './components/CostsSubnav';
import CoverageBanner from './components/CoverageBanner';
import FeeSettingsCard from './components/FeeSettingsCard';
import FunnelCostTable from './components/FunnelCostTable';
import RateDrawer from './components/RateDrawer';
import VariantsGrid from './components/VariantsGrid';
import useCostSaves from './useCostSaves';
import {
  costApiError, fetchByFunnel, fetchCoverageSummary, fetchVariants, patchVariant,
  postDetect, rowsOf,
} from './costsApi';
import { computeCoverage, isIgnored, matchesFilter, uncostedRevenue } from './costTargets';

/** One page comfortably covers the live catalog; the API caps at 500. */
const PAGE_SIZE = 500;

// The vocabularies the URL may name, and the defaults it falls back to — an
// unknown `?tab=deleted-tab` degrades to the ordinary page, not a blank one.
const TAB_KEYS = ['funnels', 'variants', 'fees'];
const FILTER_KEYS = ['all', 'needs_cost', 'ready', 'ignored'];
const DEFAULT_TAB = 'funnels';
const DEFAULT_FILTER = 'needs_cost';

const TABS = [
  { value: 'funnels', label: 'By funnel' },
  { value: 'variants', label: 'Variants' },
  { value: 'fees', label: 'Fees' },
];

const oneOf = (allowed, value, fallback) => (
  allowed.includes(String(value ?? '')) ? String(value) : fallback
);

export default function CostsPage() {
  const { hasPermission } = usePermissions();
  // The server gates every write on funnels access; the UI gates the same way
  // so it never renders a box that would 403.
  const canEdit = hasPermission('funnels:access');

  // The SUBSCRIPTION, not a snapshot. The setter is deliberately unused —
  // nothing on this page writes the URL back.
  const [searchParams] = useSearchParams();
  const urlTab = searchParams.get('tab');
  const urlFilter = searchParams.get('filter');
  // The BARE numeric id. `.split('/').pop()` tolerates a hand-pasted
  // `gid://shopify/ProductVariant/123`.
  const urlVariant = (searchParams.get('variant') || '').trim().split('/').pop();

  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [funnelGroups, setFunnelGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [detecting, setDetecting] = useState(false);
  const [lastDetectedAt, setLastDetectedAt] = useState(null);
  const [flash, setFlash] = useState(null); // { text, isError }
  // Seeded on the FIRST render — see the header block.
  const [tab, setTab] = useState(() => oneOf(TAB_KEYS, urlTab, DEFAULT_TAB));
  const [filter, setFilter] = useState(() => oneOf(FILTER_KEYS, urlFilter, DEFAULT_FILTER));
  // `?variant=` seeds the grid's search box, isolating the clicked variant by
  // construction. A normal editable value — clearing the box restores the grid.
  const [search, setSearch] = useState(urlVariant);
  const [rateRow, setRateRow] = useState(null);

  const notify = useCallback((text, isError = false) => {
    setFlash(text ? { text, isError } : null);
  }, []);

  // `quiet` refreshes in place — the full-page spinner would yank the rows out
  // from under an operator part-way down a funnel entering costs.
  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const [variants, cov, grouped] = await Promise.all([
        fetchVariants({ limit: PAGE_SIZE }),
        // A failed summary must not take the grid down with it.
        fetchCoverageSummary().catch(() => null),
        // Nor must the by-funnel view — the grid stands on its own.
        fetchByFunnel().catch(() => null),
      ]);
      setRows(rowsOf(variants));
      if (cov) setSummary(cov);
      if (grouped) setFunnelGroups(grouped.funnels || []);
      setLoadError(null);
    } catch (e) {
      // Keep whatever is on screen — a transient 5xx must not blank a grid the
      // operator is halfway through filling in.
      setLoadError(costApiError(e, 'Could not load the cost catalog'));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // The deep link, after the first render: no-ops on mount (state already
  // seeded), fire only when the PARAM itself changes.
  useEffect(() => { setTab(oneOf(TAB_KEYS, urlTab, DEFAULT_TAB)); }, [urlTab]);
  useEffect(() => { setFilter(oneOf(FILTER_KEYS, urlFilter, DEFAULT_FILTER)); }, [urlFilter]);
  useEffect(() => { setSearch(urlVariant); }, [urlVariant]);

  // THE IGNORED-VARIANT HOLE: "All" hides ignored rows too, so a deep link to
  // an ignored variant would land on an empty grid. When the target turns out
  // to be one, move to the filter that shows it — ONE SHOT per target (the
  // ref), so quiet reloads never yank the operator's later filter choice back.
  const targetRow = useMemo(
    () => (urlVariant ? rows.find((r) => String(r.variant_id) === urlVariant) : undefined),
    [urlVariant, rows],
  );
  const escalatedFor = useRef('');
  useEffect(() => {
    if (!urlVariant || escalatedFor.current === urlVariant) return;
    if (!targetRow) return; // not loaded yet, or genuinely not in the catalog
    escalatedFor.current = urlVariant;
    setFilter((f) => (
      matchesFilter(targetRow, f) ? f : (isIgnored(targetRow) ? 'ignored' : 'all')
    ));
  }, [urlVariant, targetRow]);

  // Bring the grid into view once per deep-link target. Guarded — this must
  // never be able to throw on a money page.
  const variantsRef = useRef(null);
  const scrolledFor = useRef('');
  useEffect(() => {
    if (!urlVariant || tab !== 'variants' || scrolledFor.current === urlVariant) return;
    const el = variantsRef.current;
    if (!el || typeof el.scrollIntoView !== 'function') return;
    scrolledFor.current = urlVariant;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [urlVariant, tab]);

  const local = useMemo(() => computeCoverage(rows), [rows]);
  const coverage = useMemo(() => (summary
    ? { costed: summary.ready ?? 0, total: (summary.total ?? 0) - (summary.ignored ?? 0) }
    : local), [summary, local]);
  const uncosted = summary?.revenue_at_risk_30d ?? uncostedRevenue(rows);
  const revenue30d = useMemo(
    () => rows.reduce((acc, r) => acc + (Number(r?.revenue_30d) || 0), 0),
    [rows],
  );

  const detect = useCallback(async () => {
    setDetecting(true);
    try {
      const res = await postDetect();
      notify(res?.variants != null
        ? `Detected ${res.variants} variants — ${res.inserted ?? 0} new, ${res.updated ?? 0} updated`
        : 'Detection finished');
      setLastDetectedAt(res?.ran_at || new Date().toISOString());
      await load();
    } catch (e) {
      notify(costApiError(e, 'Detection failed'), true);
    } finally {
      setDetecting(false);
    }
  }, [load, notify]);

  /**
   * WHERE THIS PAGE KEEPS ITS COPIES OF A ROW. The catalog is held TWICE:
   * `rows` flat for the grid, `funnelGroups` nested for the By-funnel view.
   * Every copy must be patched on a write — a rate row is a SNAPSHOT, so the
   * NEXT inline edit builds its body from whatever row the UI holds. Patch the
   * flat list and skip the tree, and the next shipping edit posts the stale
   * `unit_cogs: null` the tree still carries, silently erasing the cost just
   * entered.
   */
  const applyPatch = useCallback((variantId, patch) => {
    setRows((prev) => prev.map((r) => (r.variant_id === variantId ? patch(r) : r)));
    setFunnelGroups((prev) => prev.map((g) => ({
      ...g,
      products: (g.products || []).map((p) => ({
        ...p,
        variants: (p.variants || []).map((v) => (
          v.variant_id === variantId ? patch(v) : v
        )),
      })),
    })));
  }, []);

  const { savingId, saveCogs, saveShip } = useCostSaves({ applyPatch, reload: load, notify });

  // Operator-owned lifecycle toggle (PATCH /variants/:id — never the sweep's).
  const toggleIgnore = useCallback(async (row) => {
    const ignored = !isIgnored(row);
    applyPatch(row.variant_id, (v) => ({ ...v, coverage: ignored ? 'ignored' : 'needs_cost' }));
    try {
      await patchVariant(row.variant_id, { ignored });
      notify(ignored ? 'Variant ignored — its rates are kept.' : 'Variant restored to the worklist.');
    } catch (e) {
      notify(costApiError(e, 'Could not update the variant'), true);
    } finally {
      await load({ quiet: true });
    }
  }, [applyPatch, load, notify]);

  return (
    <div className="p-6 space-y-5 max-w-[1600px]" data-testid="costs-page">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-text-primary flex items-center gap-2">
            <Coins className="w-5 h-5 text-accent-text" />
            Costs
          </h1>
          <p className="text-sm text-text-muted mt-0.5 max-w-[720px]">
            What every variant actually costs you — goods, shipping per leg, and processing fees.
            Enter it once here and it follows the money into the P&amp;L.
          </p>
        </div>
        <CostsSubnav />
      </div>

      {loadError ? (
        <Card className="border-danger/30 bg-danger/5 text-sm text-danger flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          {String(loadError)}
        </Card>
      ) : null}

      {flash ? (
        <div
          className={`rounded-lg border px-3 py-2 text-[12px] flex items-center justify-between gap-3 ${
            flash.isError
              ? 'border-danger/30 bg-danger/5 text-danger'
              : 'border-border-default bg-bg-elevated/40 text-text-muted'
          }`}
          role={flash.isError ? 'alert' : 'status'}
          data-testid="costs-flash"
        >
          <span>{flash.text}</span>
          <button
            type="button"
            onClick={() => setFlash(null)}
            className="shrink-0 underline decoration-dotted underline-offset-2 hover:text-text-primary"
          >
            dismiss
          </button>
        </div>
      ) : null}

      <CoverageBanner
        coverage={coverage}
        uncostedRevenue30d={uncosted}
        lastDetectedAt={lastDetectedAt}
        detecting={detecting}
        canEdit={canEdit}
        onDetect={detect}
      />

      <Tabs tabs={TABS} activeTab={tab} onChange={setTab} />

      {tab === 'funnels' && (
        <FunnelCostTable
          groups={funnelGroups}
          loading={loading}
          canEdit={canEdit}
          savingId={savingId}
          onSaveCogs={saveCogs}
          onSaveShip={saveShip}
        />
      )}

      {tab === 'variants' && (
        <div ref={variantsRef} className="space-y-3">
          {/* Says out loud that the grid shows ONE variant on purpose — an
              isolated grid otherwise reads as a broken catalog. GATED ON THE
              ROW, not the URL: a variant with no catalog row must not get
              "showing the variant you opened" printed above "no variants
              match". */}
          {urlVariant && search === urlVariant && targetRow && (
            <div
              className="flex items-center gap-2 flex-wrap rounded-lg border border-border-default bg-bg-elevated/40 px-3 py-2 text-xs"
              data-testid="costs-variant-target"
            >
              <span className="text-text-muted">Showing the variant you deep-linked to —</span>
              <span className="tabular-nums text-text-primary">{urlVariant}</span>
              <button
                type="button"
                onClick={() => setSearch('')}
                className="ml-auto underline decoration-dotted underline-offset-2 text-text-muted hover:text-text-primary"
                data-testid="costs-variant-target-clear"
              >
                Show all variants
              </button>
            </div>
          )}
          {/* …and when it genuinely is not in the catalog, SAY SO. Held back
              until the catalog has loaded, so a slow fetch never accuses a
              variant that is about to appear. */}
          {urlVariant && search === urlVariant && !targetRow && !loading && (
            <div
              className="flex items-center gap-2 flex-wrap rounded-lg border border-border-default bg-bg-elevated/40 px-3 py-2 text-xs"
              data-testid="costs-variant-missing"
            >
              <span className="tabular-nums text-text-primary">{urlVariant}</span>
              <span className="text-text-muted">
                is not in the cost catalog — it may be a deleted Shopify variant, or detection has not
                picked it up yet.
              </span>
              <button
                type="button"
                onClick={() => setSearch('')}
                className="ml-auto underline decoration-dotted underline-offset-2 text-text-muted hover:text-text-primary"
                data-testid="costs-variant-target-clear"
              >
                Show all variants
              </button>
            </div>
          )}
          <VariantsGrid
            rows={rows}
            loading={loading}
            canEdit={canEdit}
            filter={filter}
            onFilterChange={setFilter}
            search={search}
            onSearchChange={setSearch}
            savingId={savingId}
            onSaveCogs={saveCogs}
            onOpenRate={setRateRow}
            onToggleIgnore={toggleIgnore}
          />
        </div>
      )}

      {tab === 'fees' && (
        <FeeSettingsCard canEdit={canEdit} revenue30d={revenue30d} />
      )}

      <RateDrawer
        open={Boolean(rateRow)}
        row={rateRow}
        rows={rows}
        canEdit={canEdit}
        onOpenChange={(v) => { if (!v) setRateRow(null); }}
        onSaved={() => load({ quiet: true })}
      />
    </div>
  );
}
