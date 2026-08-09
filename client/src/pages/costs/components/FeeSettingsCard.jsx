// FeeSettingsCard — the processing rate, globally and per gateway
// (NEW FILE, costs lane).
//
// One global default (seeded 6.0%) plus a per-gateway override row, so
// swapping in a real rate later is an edit on this card and not a migration.
//
// NULL vs 0 matters just as much here. A blank gateway field means "this rail
// runs on the default", stored as `null`. A typed `0` means "this rail is
// genuinely free" and pins the override at zero. Coercing blank → 0 would
// silently take a gateway off the 6% the operator just switched on.
//
// The card mirrors `PATCH /fee-settings` exactly: `{default:{pct,fixed},
// gateways:{gw:{pct,fixed}|null}}`. A gateway mapped to `null` clears its
// override; a partial override ({pct: 3, fixed: null}) fills its blanks from
// the default.
import { useEffect, useMemo, useState } from 'react';
import { Loader2, Percent, Wallet } from 'lucide-react';
import { GATEWAYS, costApiError, fetchFeeSettings, patchFeeSettings } from '../costsApi';
import { buildFeeSettingsBody, fmtMoney, fmtDateTime, toFeeDraft } from '../costTargets';

// Read side of the contract's nested shape lives in costTargets.toFeeDraft
// (B5), where the harness round-trips it through buildFeeSettingsBody.
const toDraft = (data) => toFeeDraft(data, GATEWAYS);

const moneyInput = 'h-8 px-2 tabular-nums text-right text-xs bg-bg-elevated border border-border-default rounded-md text-text-primary disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent/40';

export default function FeeSettingsCard({ canEdit = false, revenue30d = 0, onSaved }) {
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const [savedMsg, setSavedMsg] = useState(null);

  useEffect(() => {
    let alive = true;
    fetchFeeSettings()
      .then((data) => { if (alive) setDraft(toDraft(data)); })
      .catch(() => { if (alive) setDraft(toDraft(null)); });
    return () => { alive = false; };
  }, []);

  // "6%" is an abstraction; a concrete monthly dollar figure is not.
  const monthlyFee = useMemo(() => {
    const pct = Number(draft?.pct);
    if (!Number.isFinite(pct) || !revenue30d) return null;
    return (revenue30d * pct) / 100;
  }, [draft?.pct, revenue30d]);

  if (!draft) {
    return (
      <div className="rounded-xl border border-border-default bg-bg-card p-5 text-xs text-text-muted">
        Loading fee settings…
      </div>
    );
  }

  const set = (k) => (v) => { setDraft((d) => ({ ...d, [k]: v })); setErr(null); setSavedMsg(null); };
  const setGw = (key, field) => (v) => {
    setDraft((d) => ({ ...d, gateways: { ...d.gateways, [key]: { ...d.gateways[key], [field]: v } } }));
    setErr(null);
    setSavedMsg(null);
  };

  const save = async () => {
    let body;
    try { body = buildFeeSettingsBody(draft, GATEWAYS); } catch (e) { setErr(e.message); return; }
    setSaving(true);
    setErr(null);
    try {
      const data = await patchFeeSettings(body);
      setDraft(toDraft(data || null));
      setSavedMsg('Fee settings saved.');
      onSaved?.();
    } catch (e) {
      setErr(costApiError(e, 'Could not save fee settings'));
    } finally {
      setSaving(false);
    }
  };

  /** Clearing every override is how you say "all rails run on the default". */
  const clearOverrides = () => {
    setDraft((d) => ({
      ...d,
      gateways: Object.fromEntries(GATEWAYS.map(({ key }) => [key, { pct: '', fixed: '' }])),
    }));
    setErr(null);
    setSavedMsg(null);
  };

  /** The greyed placeholder a blank field resolves to today. */
  const effective = (key, field) => {
    const own = String(draft.gateways[key][field] ?? '').trim();
    if (own !== '') return null; // has its own value
    return field === 'pct' ? draft.pct : (draft.fixed || '0');
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2" data-testid="costs-fees">
      {/* Global default */}
      <section className="rounded-xl border border-border-default bg-bg-card p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Percent className="w-3.5 h-3.5 text-text-muted" />
          <h3 className="text-sm font-medium text-text-primary">Default processing rate</h3>
        </div>

        <div className="flex items-center justify-between gap-2">
          <label htmlFor="fee-global-pct" className="text-xs text-text-muted">Processing rate</label>
          <div className="flex items-center gap-1.5">
            <input
              id="fee-global-pct" inputMode="decimal" disabled={!canEdit}
              value={draft.pct} onChange={(e) => set('pct')(e.target.value)}
              className={`w-[104px] ${moneyInput}`}
              data-testid="costs-fee-pct"
            />
            <span className="text-[11px] text-text-muted w-3">%</span>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <label htmlFor="fee-global-fixed" className="text-xs text-text-muted">Fixed fee per charge</label>
          <div className="flex items-center gap-1.5">
            <input
              id="fee-global-fixed" inputMode="decimal" disabled={!canEdit}
              value={draft.fixed} onChange={(e) => set('fixed')(e.target.value)}
              className={`w-[104px] ${moneyInput}`}
              data-testid="costs-fee-fixed"
            />
            <span className="text-[11px] text-text-muted w-3">$</span>
          </div>
        </div>

        {monthlyFee != null && (
          <p className="text-[11px] text-text-muted" data-testid="costs-fee-estimate">
            At the last 30 days&rsquo; revenue that is about{' '}
            <span className="tabular-nums text-text-primary">{fmtMoney(monthlyFee)}</span> a month in
            processing fees.
          </p>
        )}

        <p className="text-[10.5px] text-text-faint leading-relaxed">
          Fees are charged <span className="italic">per transaction</span>, not per order: an order with two
          appended upsells is three real charges, so the fixed fee applies three times. That is how the
          processor bills you and how the cost engine books it.
        </p>

        {draft.updated_at && (
          <p className="text-[10px] text-text-faint">
            Last changed {fmtDateTime(draft.updated_at)}
            {draft.updated_by ? ` by ${draft.updated_by}` : ''}
          </p>
        )}
      </section>

      {/* Per gateway */}
      <section className="rounded-xl border border-border-default bg-bg-card p-5 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Wallet className="w-3.5 h-3.5 text-text-muted" />
            <h3 className="text-sm font-medium text-text-primary">Per gateway</h3>
          </div>
          {canEdit && (
            <button
              type="button"
              onClick={clearOverrides}
              data-testid="costs-fee-clear-overrides"
              className="text-xs text-text-muted hover:text-text-primary transition-colors"
            >
              Clear overrides
            </button>
          )}
        </div>

        <div className="space-y-2">
          {GATEWAYS.map(({ key, label }) => (
            <div key={key} className="flex items-center justify-between gap-2">
              <span className="text-xs text-text-primary">{label}</span>
              <div className="flex items-center gap-1.5">
                <input
                  inputMode="decimal" disabled={!canEdit}
                  value={draft.gateways[key].pct} onChange={(e) => setGw(key, 'pct')(e.target.value)}
                  placeholder={String(effective(key, 'pct') ?? '')}
                  aria-label={`${label} percentage rate`}
                  className={`w-[80px] ${moneyInput} placeholder:text-text-faint`}
                  data-testid={`costs-fee-${key}-pct`}
                />
                <span className="text-[11px] text-text-muted w-3">%</span>
                <input
                  inputMode="decimal" disabled={!canEdit}
                  value={draft.gateways[key].fixed} onChange={(e) => setGw(key, 'fixed')(e.target.value)}
                  placeholder={String(effective(key, 'fixed') ?? '')}
                  aria-label={`${label} fixed fee`}
                  className={`w-[80px] ${moneyInput} placeholder:text-text-faint`}
                  data-testid={`costs-fee-${key}-fixed`}
                />
                <span className="text-[11px] text-text-muted w-3">$</span>
              </div>
            </div>
          ))}
        </div>

        <hr className="border-border-default" />

        <p className="text-[10.5px] text-text-faint leading-relaxed">
          A blank field means the gateway runs on the default — the greyed number is what it resolves to
          today. Type <span className="tabular-nums">0</span> only when a rail is genuinely free; that pins it
          at zero and stops it following the default.
        </p>

        {err && <p className="text-[11px] text-danger" role="alert" data-testid="costs-fee-error">{err}</p>}
        {savedMsg && <p className="text-[11px] text-green-400" data-testid="costs-fee-saved">{savedMsg}</p>}

        {canEdit && (
          <button
            type="button"
            onClick={save}
            disabled={saving}
            data-testid="costs-fee-save"
            className="inline-flex items-center justify-center gap-1.5 w-full h-9 rounded-lg bg-accent text-white
                       text-sm font-medium disabled:opacity-50 transition-colors"
          >
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {saving ? 'Saving…' : 'Save fee settings'}
          </button>
        )}
      </section>
    </div>
  );
}
