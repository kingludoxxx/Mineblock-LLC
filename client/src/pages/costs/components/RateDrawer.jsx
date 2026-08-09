// RateDrawer — append an effective-dated cost, and read the history of the
// ones already appended (NEW FILE, costs lane).
//
// Rates are APPEND-ONLY. There is no edit and no delete: an "edit" is a new
// row with a later `effective_from`, and the cost in force for a day is the
// greatest `effective_from <= day`. That is what makes a cost change stop
// rewriting last quarter's gross profit — and why this drawer shows a
// timeline rather than a form pre-filled with "the" value.
//
// Three safety rails, each a shipped defect in the reference:
//   · KNOWN FREE is a checkbox, not a typed 0. Blank means unknown and clears
//     the value; only the checkbox writes a real $0.00.
//   · THE TARGET LIST IS SHOWN BEFORE SAVING, spelled out with the funnels
//     each target reaches.
//   · THE EFFECTIVE DATE IS ALWAYS VISIBLE, and the drawer says out loud when
//     it restates already-reported numbers. A FIRST cost defaults back to the
//     variant's first sale (a first entry dated today reports nothing — every
//     historical report keeps showing 100% margin); a SUBSEQUENT cost defaults
//     to today. "Only from today" pins it either way. We always send
//     `effective_from` explicitly so the date on screen is the date written.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, History, Loader2, X } from 'lucide-react';
import {
  CONTEXT_KEYS, EM_DASH, costInputError, fmtDateTime, formatCost, hasShipMap,
  parseCostInput, paysShipping, resolveFanOutTargets, resolveShip, todayIso, variantLabel,
} from '../costTargets';
import { costApiError, fetchCostGroup, fetchRateHistory, postRate, rowsOf } from '../costsApi';

const BLANK_SHIP = { default: '', main: '', upsell: '', addon: '', bump: '' };
const SHIP_KEYS = ['default', ...CONTEXT_KEYS];

function shipDraftFrom(row) {
  const s = row?.ship || {};
  const out = { ...BLANK_SHIP };
  for (const k of SHIP_KEYS) {
    out[k] = s[k] === null || s[k] === undefined ? '' : String(s[k]);
  }
  return out;
}

/** One appended rate, newest first. Source is shown because "where did this
 *  number come from" is the question a month later. */
function HistoryRow({ rate }) {
  const cogs = formatCost(rate.unit_cogs);
  return (
    <li className="flex items-start gap-3 py-2 border-b border-border-default/50 last:border-b-0">
      <span className="tabular-nums text-[10px] text-text-muted w-[86px] shrink-0 pt-0.5">
        {(rate.effective_from || '').slice(0, 10) || EM_DASH}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-text-primary">
          <span className={`tabular-nums ${cogs.state === 'unknown' ? 'text-text-muted' : ''}`}>
            {cogs.state === 'unknown' ? 'cost cleared' : cogs.text}
          </span>
          {rate.ship && Object.values(rate.ship).some((v) => v !== null && v !== undefined) && (
            <span className="text-text-muted">
              {'  ·  ship '}
              {SHIP_KEYS
                .filter((k) => rate.ship[k] !== null && rate.ship[k] !== undefined)
                .map((k) => `${k} ${formatCost(rate.ship[k]).text}`)
                .join(', ')}
            </span>
          )}
        </p>
        <p className="text-[10px] text-text-faint truncate">
          <span className="inline-flex items-center rounded-md border border-border-default px-1.5 mr-1.5 font-medium text-text-muted">
            {rate.source || 'manual'}
          </span>
          {rate.created_by || EM_DASH}
          {rate.created_at ? ` · ${fmtDateTime(rate.created_at)}` : ''}
          {rate.note ? ` · ${rate.note}` : ''}
        </p>
      </div>
    </li>
  );
}

const L = ({ children, htmlFor }) => (
  <label htmlFor={htmlFor} className="block text-[10px] uppercase tracking-wide text-text-muted font-semibold">
    {children}
  </label>
);

export default function RateDrawer({ open, row, rows = [], canEdit = false, onOpenChange, onSaved, notify }) {
  const [scope, setScope] = useState('variant');
  const [cogsDraft, setCogsDraft] = useState('');
  const [knownFree, setKnownFree] = useState(false);
  const [shipDraft, setShipDraft] = useState(BLANK_SHIP);
  const [onlyToday, setOnlyToday] = useState(false);
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [dateTouched, setDateTouched] = useState(false);
  const [note, setNote] = useState('');
  const [history, setHistory] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const today = todayIso();
  const variantId = String(row?.variant_id || '');
  const itemId = String(row?.cost_item_id || '');

  // Reset the form every time the drawer opens on a (possibly different) row.
  useEffect(() => {
    if (!open || !row) return;
    setScope('variant');
    setCogsDraft(row.unit_cogs === null || row.unit_cogs === undefined ? '' : String(row.unit_cogs));
    setKnownFree(row.unit_cogs === 0);
    setShipDraft(shipDraftFrom(row));
    setOnlyToday(false);
    setDateTouched(false);
    setNote('');
    setErr(null);
  }, [open, row]);

  const loadHistory = useCallback(() => {
    if (!open || !variantId) { setHistory([]); return; }
    setLoadingHistory(true);
    fetchRateHistory(variantId)
      .then((data) => setHistory(rowsOf(data)))
      .catch(() => setHistory([]))
      .finally(() => setLoadingHistory(false));
  }, [open, variantId]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  // Escape closes (the drawer is hand-rolled, so it owns its own key handling).
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onOpenChange?.(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  /** Has this exact scope+ref ever been given a rate before? */
  const hasPriorRate = useMemo(() => history.some((h) => (
    scope === 'item'
      ? h.scope === 'item' && String(h.cost_item_id || '') === itemId
      : (h.scope ?? 'variant') === 'variant' && String(h.variant_id || '') === variantId
  )), [history, scope, itemId, variantId]);

  const firstSoldDay = String(row?.first_sold || '').slice(0, 10);

  /**
   * The server's own default, mirrored so the date the operator SEES is the
   * date that gets written: a FIRST cost backdates to the variant's first
   * sale; a SUBSEQUENT cost starts today (an edit is a change from now, not a
   * retroactive restatement).
   */
  const defaultFrom = useMemo(() => {
    if (onlyToday) return today;
    if (hasPriorRate) return today;
    return firstSoldDay || today;
  }, [onlyToday, hasPriorRate, firstSoldDay, today]);

  useEffect(() => {
    if (!dateTouched) setEffectiveFrom(defaultFrom);
  }, [defaultFrom, dateTouched]);

  /**
   * THE GROUP'S REAL MEMBERS, FROM THE SERVER.
   *
   * `rows` is the variant page this screen happens to have loaded. Deriving
   * a group's membership from it under-reports every member that did not fit
   * on the page — and this preview is the operator's only warning about how
   * many variants, and which funnels, a group rate is about to move. So an
   * item-scope save reads the membership from GET /:id and refuses to render
   * a count until it has it.
   */
  const [groupMembers, setGroupMembers] = useState(null);
  const [groupError, setGroupError] = useState(null);
  useEffect(() => {
    if (!open || scope !== 'item' || !itemId) { setGroupMembers(null); setGroupError(null); return; }
    let live = true;
    setGroupMembers(null);
    setGroupError(null);
    fetchCostGroup(itemId)
      .then((data) => { if (live) setGroupMembers(data?.group?.members || []); })
      .catch((e) => { if (live) setGroupError(costApiError(e, 'Could not read this cost group')); });
    return () => { live = false; };
  }, [open, scope, itemId]);

  // Until the real list arrives, an item-scope save has no honest preview —
  // the button below is disabled on `groupPending` rather than showing a
  // number derived from the page.
  const groupPending = scope === 'item' && Boolean(itemId) && groupMembers === null && !groupError;

  const fanOut = useMemo(
    () => resolveFanOutTargets({
      row,
      rows: scope === 'item' && groupMembers ? groupMembers : rows,
      scope,
    }),
    [row, rows, scope, groupMembers],
  );

  if (!open || !row) return null;

  const ships = paysShipping(row);
  const restatesHistory = Boolean(effectiveFrom) && effectiveFrom < today;

  const buildBody = () => {
    // THE SHIP WRITE-GUARD (contract v2 B4). The drafts were seeded from the
    // row's ship map; a row that arrived WITHOUT one means the drafts carry
    // nothing real, and posting them would snapshot the variant's shipping to
    // all-unknown. Refuse — same rule as the inline builders.
    if (!hasShipMap(row)) return { error: 'missing_ship_map' };

    const parsed = parseCostInput(cogsDraft, { knownFree });
    if (parsed.error) return { error: parsed.error };

    const ship = {};
    for (const k of SHIP_KEYS) {
      const raw = shipDraft[k];
      const s = raw === null || raw === undefined ? '' : String(raw).trim();
      if (s === '') { ship[k] = null; continue; } // blank = unknown/inherit, NEVER 0
      const n = Number(s);
      if (!Number.isFinite(n)) return { error: 'not_a_number' };
      if (n < 0) return { error: 'negative' };
      // A typed 0 on a SHIPPING leg is legitimate and unambiguous (an upsell
      // riding in the same box genuinely costs nothing extra), so unlike the
      // COGS field it needs no separate affordance. Blank still means unknown.
      ship[k] = n;
    }

    const isItem = fanOut.scope === 'item';
    return {
      body: {
        scope: fanOut.scope,
        ...(isItem ? { cost_item_id: itemId } : { variant_id: variantId }),
        effective_from: effectiveFrom,
        only_from_today: onlyToday,
        unit_cogs: parsed.value,
        ship,
        currency: 'USD',
        source: 'manual',
        note: note.trim(),
      },
    };
  };

  const save = async () => {
    const { body, error } = buildBody();
    if (error) { setErr(error); return; }
    setSaving(true);
    setErr(null);
    try {
      // POST /rates answers { rate:{…} } (contract v2); the confirmation
      // names the day the SERVER wrote, not the day the form showed.
      const res = await postRate(body);
      const from = res?.rate?.effective_from;
      notify?.(from ? `Rate saved — applies from ${from}` : 'Rate saved');
      loadHistory();
      onSaved?.();
      onOpenChange?.(false);
    } catch (e) {
      setErr(costApiError(e, 'Could not save the rate'));
    } finally {
      setSaving(false);
    }
  };

  const scopeBtn = (val, label, disabled, title) => (
    <button
      type="button"
      onClick={() => setScope(val)}
      disabled={disabled}
      title={title}
      data-testid={`costs-scope-${val}`}
      className={`h-8 px-3 rounded-full text-xs font-medium transition-colors disabled:opacity-40
        ${scope === val
          ? 'bg-bg-elevated text-text-primary border border-border-default'
          : 'text-text-muted hover:text-text-primary border border-transparent'}`}
    >
      {label}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" data-testid="costs-rate-drawer">
      {/* overlay */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => onOpenChange?.(false)} />
      {/* panel */}
      <aside className="absolute right-0 top-0 h-full w-full sm:max-w-[560px] bg-bg-card border-l border-border-default
                        overflow-y-auto p-5">
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-text-primary truncate">{variantLabel(row)}</h2>
            <p className="tabular-nums text-[11px] text-text-muted">{row.variant_id}</p>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange?.(false)}
            aria-label="Close"
            className="p-1 rounded-md text-text-muted hover:text-text-primary transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="mt-5 space-y-5">
          {/* Scope — v1 keeps cost groups as a nullable hook, so "item" is
              only reachable when the variant is actually bound to one. */}
          <div className="space-y-2">
            <L>Applies to</L>
            <div className="flex gap-2">
              {scopeBtn('variant', 'This variant', false)}
              {scopeBtn('item', 'Cost group', !row.cost_item_id,
                row.cost_item_id ? undefined : 'This variant is not bound to a cost group')}
            </div>
          </div>

          {/* Cost */}
          <div className="space-y-2">
            <L htmlFor="costs-drawer-cogs">Unit cost (per unit of the variant)</L>
            <div className="flex items-center gap-3">
              <input
                id="costs-drawer-cogs"
                inputMode="decimal"
                value={knownFree ? '' : cogsDraft}
                disabled={knownFree || !canEdit}
                onChange={(e) => { setCogsDraft(e.target.value); setErr(null); }}
                placeholder="blank = unknown"
                className="w-[150px] h-9 px-3 tabular-nums text-right text-sm bg-bg-elevated border border-border-default
                           rounded-lg text-text-primary disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent/40"
                data-testid="costs-drawer-cogs"
              />
              <label className="flex items-center gap-2 text-xs text-text-muted cursor-pointer">
                <input
                  type="checkbox"
                  checked={knownFree}
                  disabled={!canEdit}
                  onChange={(e) => { setKnownFree(e.target.checked); setErr(null); }}
                  className="accent-current w-3.5 h-3.5"
                  data-testid="costs-known-free"
                />
                Known free ($0.00)
              </label>
            </div>
            <p className="text-[10.5px] text-text-faint leading-relaxed">
              A blank field clears the cost to <span className="italic">unknown</span> and the margin goes back
              to a dash. Only &ldquo;known free&rdquo; writes a real $0.00 — a claim that the item genuinely
              costs nothing.
            </p>
          </div>

          {/* Shipping */}
          <div className="space-y-2">
            <L>Shipping cost per unit, by context</L>
            {!ships && (
              <p className="text-[10.5px] text-text-muted">
                This variant is marked as not shipping, so these values will not be applied until that changes.
              </p>
            )}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {SHIP_KEYS.map((k) => (
                <div key={k} className="space-y-1">
                  <label htmlFor={`costs-ship-${k}`} className="text-[10px] text-text-muted capitalize">{k}</label>
                  <input
                    id={`costs-ship-${k}`}
                    inputMode="decimal"
                    disabled={!canEdit}
                    value={shipDraft[k]}
                    onChange={(e) => { setShipDraft((s) => ({ ...s, [k]: e.target.value })); setErr(null); }}
                    placeholder={k === 'default' ? 'unknown' : 'inherit'}
                    className="h-8 w-full px-2 tabular-nums text-right text-xs bg-bg-elevated border border-border-default
                               rounded-md text-text-primary disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent/40"
                    data-testid={`costs-drawer-ship-${k}`}
                  />
                </div>
              ))}
            </div>
            <p className="text-[10.5px] text-text-faint">
              A blank context inherits <span className="italic">default</span>. Today this variant resolves to{' '}
              <span className="tabular-nums">{formatCost(resolveShip(row.ship, 'main')).text}</span> on a main leg and{' '}
              <span className="tabular-nums">{formatCost(resolveShip(row.ship, 'upsell')).text}</span> on an upsell leg.
            </p>
          </div>

          <hr className="border-border-default" />

          {/* Effective date */}
          <div className="space-y-2">
            <L>Effective from</L>
            <div className="flex items-center gap-3 flex-wrap">
              <input
                type="date"
                value={effectiveFrom}
                disabled={!canEdit || onlyToday}
                onChange={(e) => { setDateTouched(true); setEffectiveFrom(e.target.value); }}
                className="w-[170px] h-9 px-3 tabular-nums text-xs bg-bg-elevated border border-border-default
                           rounded-lg text-text-primary disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent/40"
                data-testid="costs-effective-from"
              />
              <label className="flex items-center gap-2 text-xs text-text-muted cursor-pointer">
                <input
                  type="checkbox"
                  checked={onlyToday}
                  disabled={!canEdit}
                  onChange={(e) => { setDateTouched(false); setOnlyToday(e.target.checked); }}
                  className="accent-current w-3.5 h-3.5"
                  data-testid="costs-only-today"
                />
                Only from today
              </label>
            </div>
            {restatesHistory ? (
              <p className="text-[10.5px] text-amber-400 flex items-start gap-1.5" data-testid="costs-backdate-warning">
                <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                <span>
                  This applies from <span className="tabular-nums">{effectiveFrom}</span>, so it restates numbers
                  that have already been reported — margins on past reports will move. Tick &ldquo;only from
                  today&rdquo; to leave history byte-identical.
                </span>
              </p>
            ) : (
              <p className="text-[10.5px] text-text-faint">Applies from today forward. History is untouched.</p>
            )}
            {!hasPriorRate && firstSoldDay && !onlyToday && (
              <p className="text-[10.5px] text-text-faint">
                This is the first cost recorded for this variant, so it defaults back to its first sale
                (<span className="tabular-nums">{firstSoldDay}</span>) — otherwise every existing report keeps
                showing 100% margin, which is the bug this page exists to fix.
              </p>
            )}
          </div>

          {/* Note */}
          <div className="space-y-2">
            <L htmlFor="costs-note">Note (optional)</L>
            <input
              id="costs-note"
              value={note}
              disabled={!canEdit}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. supplier quote 2026-08, 500 unit MOQ"
              className="w-full h-9 px-3 text-xs bg-bg-elevated border border-border-default rounded-lg
                         text-text-primary disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent/40"
              data-testid="costs-note"
            />
          </div>

          {/* Target preview — the exact rows this save touches, before saving.
              For an item-scope save the membership comes from the SERVER, so
              the count is the group's real reach and not a page artefact. */}
          <div className="rounded-lg border border-border-default bg-bg-elevated/40 p-3 space-y-2" data-testid="costs-targets">
            {groupPending && (
              <p className="text-[11px] text-text-muted flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin" />
                Reading this cost group&rsquo;s members from the server…
              </p>
            )}
            {groupError && (
              <p className="text-[11px] text-danger flex items-center gap-1.5">
                <AlertTriangle className="w-3 h-3" />
                {groupError} — the group&rsquo;s reach cannot be shown, so this save is blocked.
              </p>
            )}
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-medium text-text-primary">
                This save writes to <span className="tabular-nums">{groupPending ? '…' : fanOut.affected.length}</span>{' '}
                variant{fanOut.affected.length === 1 ? '' : 's'}
              </p>
              {fanOut.crossFunnel && (
                <span className="inline-flex items-center gap-1 text-[10px] text-amber-400">
                  <AlertTriangle className="w-3 h-3" /> reaches other funnels
                </span>
              )}
            </div>
            <ul className="space-y-1 max-h-[190px] overflow-y-auto">
              {fanOut.targets.map((t) => (
                <li key={t.variant_id} className="flex items-center justify-between gap-2 text-[10px]">
                  <span className={`truncate ${t.shadowed ? 'text-text-faint line-through' : 'text-text-primary'}`}>
                    {t.label}
                    <span className="tabular-nums ml-1.5 text-text-faint">{t.variant_id}</span>
                  </span>
                  <span className="shrink-0 text-text-muted tabular-nums">
                    {t.funnels.length} funnel{t.funnels.length === 1 ? '' : 's'} · {t.units_30d} u
                  </span>
                </li>
              ))}
            </ul>
            {fanOut.shadowed.length > 0 && (
              <p className="text-[10px] text-text-faint">
                {fanOut.shadowed.length} struck-through row{fanOut.shadowed.length === 1 ? ' has' : 's have'} their
                own variant-level cost, which wins over the group — the group rate is stored but their resolved
                cost does not move.
              </p>
            )}
            {fanOut.crossFunnel && (
              <p className="text-[10px] text-text-faint">Funnels touched: {fanOut.funnels.join(', ')}</p>
            )}
          </div>

          {err && (
            <p className="text-[11px] text-danger" role="alert" data-testid="costs-drawer-error">
              {typeof err === 'string' && !err.includes('_') ? err : costInputError(err)}
            </p>
          )}

          <hr className="border-border-default" />

          {/* History */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <History className="w-3.5 h-3.5 text-text-muted" />
              <p className="text-[10px] uppercase tracking-wide text-text-muted font-semibold">Rate history</p>
              {loadingHistory && <Loader2 className="w-3 h-3 animate-spin text-text-muted" />}
            </div>
            {history.length ? (
              <ul data-testid="costs-history">
                {history.map((r, i) => <HistoryRow key={r.id || i} rate={r} />)}
              </ul>
            ) : (
              <p className="text-[10.5px] text-text-muted">
                {loadingHistory ? 'Loading…' : 'No rate has ever been recorded for this scope.'}
              </p>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2 pb-6">
            <button
              type="button"
              onClick={() => onOpenChange?.(false)}
              className="h-9 px-4 rounded-lg text-sm text-text-muted hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!canEdit || saving || groupPending || Boolean(groupError)}
              data-testid="costs-save-rate"
              className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-accent text-white text-sm
                         font-medium disabled:opacity-50 transition-colors"
            >
              {(saving || groupPending) && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {saving ? 'Saving…'
                : groupPending ? 'Reading the group…'
                  : `Append rate (${fanOut.affected.length})`}
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
