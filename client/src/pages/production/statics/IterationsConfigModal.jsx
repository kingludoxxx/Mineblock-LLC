// ─────────────────────────────────────────────────────────────────────────────
// IterationsConfigModal — per-ad-account filters for the ITERATIONS column.
//
// One config per Meta ad account: max copy words, min spend, date range and
// which ad states to surface. Mirrors BrandFollowConfigModal so the two config
// surfaces in this tool behave the same way.
//
// The account list comes from meta_account_audit. When Meta has never been
// connected that table may not exist, and the server says so explicitly — this
// modal surfaces that sentence instead of rendering an empty list, because
// "no accounts" and "Meta was never connected" are different problems.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from 'react';
import { X, ChevronDown, ChevronUp, Loader2, Plus, AlertTriangle, Flame } from 'lucide-react';
import api from '../../../services/api';

const DATE_RANGES = [
  { label: 'All Time', value: null },
  { label: '30 days',  value: 30 },
  { label: '60 days',  value: 60 },
  { label: '90 days',  value: 90 },
  { label: '180 days', value: 180 },
  { label: '365 days', value: 365 },
];
const AD_STATUSES = ['active', 'paused', 'archived'];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** One-line summary shown on the collapsed header, matching the reference UI. */
function summarize(c) {
  const range = c.date_range_days == null ? 'All Time' : `${c.date_range_days} days`;
  const statuses = (c.ad_statuses || []).map(cap).join(', ') || 'none';
  const copy = c.max_copy_words == null ? 'any copy' : `≤${c.max_copy_words}w copy`;
  return `$${Number(c.min_spend ?? 0)} min · ${range} · ${statuses} · ${copy}`;
}

function ConfigCard({ config, onSave, onRemove }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(config);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => { setDraft(config); }, [config]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(config);

  const toggleStatus = (s) => {
    const cur = draft.ad_statuses || [];
    // At least one status must stay selected — an empty set would return nothing
    // and look like a broken column rather than a filter choice.
    const next = cur.includes(s) ? cur.filter(x => x !== s) : [...cur, s];
    if (next.length === 0) { setErr('Keep at least one ad status selected'); return; }
    setErr(null);
    setDraft({ ...draft, ad_statuses: next });
  };

  const save = async () => {
    setSaving(true); setErr(null);
    try {
      await onSave(draft);
    } catch (e) {
      setErr(e.response?.data?.error?.message || e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border border-emerald-500/25 bg-emerald-500/[0.05] rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex-1 min-w-0 text-left cursor-pointer"
        >
          <p className="text-[12px] font-mono text-zinc-100 truncate">
            {config.account_name || config.account_id}
          </p>
          <p className="text-[10px] text-zinc-400 truncate mt-0.5">{summarize(config)}</p>
        </button>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="text-zinc-400 hover:text-zinc-200 cursor-pointer shrink-0"
          title={open ? 'Collapse' : 'Expand'}
        >
          {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        <button
          type="button"
          onClick={() => onRemove(config.account_id)}
          className="text-zinc-500 hover:text-red-400 cursor-pointer shrink-0"
          title="Stop sourcing Iterations from this account"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {open && (
        <div className="px-3 pb-3 space-y-3 border-t border-white/[0.06] pt-3">
          {/* MAX COPY WORDS */}
          <div>
            <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-zinc-500 mb-1.5">
              Max copy words
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={1000}
                value={draft.max_copy_words ?? ''}
                onChange={(e) => setDraft({ ...draft, max_copy_words: e.target.value === '' ? null : parseInt(e.target.value, 10) })}
                placeholder="no limit"
                className="flex-1 h-9 bg-black/40 border border-white/[0.08] rounded-lg px-2.5 text-[12px] text-zinc-200 focus:outline-none focus:border-emerald-500/40"
              />
              <span className="text-[11px] text-zinc-500 shrink-0">words max</span>
            </div>
            {/* Units matter: the legacy Brand Follow slider is characters despite
                its "words" label. This one really is words. */}
            <p className="text-[10px] text-zinc-600 mt-1">Blank or 0 = no limit. Counted in words.</p>
          </div>

          {/* MIN SPEND */}
          <div>
            <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-zinc-500 mb-1.5">
              Min spend ($)
            </label>
            <input
              type="number"
              min={0}
              step={50}
              value={draft.min_spend ?? 0}
              onChange={(e) => setDraft({ ...draft, min_spend: e.target.value === '' ? 0 : Number(e.target.value) })}
              className="w-full h-9 bg-black/40 border border-white/[0.08] rounded-lg px-2.5 text-[12px] text-zinc-200 focus:outline-none focus:border-emerald-500/40"
            />
          </div>

          {/* DATE RANGE */}
          <div>
            <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-zinc-500 mb-1.5">
              Date range
            </label>
            <div className="flex flex-wrap gap-1.5">
              {DATE_RANGES.map(r => {
                const active = (draft.date_range_days ?? null) === r.value;
                return (
                  <button
                    key={r.label}
                    type="button"
                    onClick={() => setDraft({ ...draft, date_range_days: r.value })}
                    className={`px-2.5 h-7 rounded-lg text-[11px] font-mono border transition-colors cursor-pointer ${
                      active
                        ? 'border-amber-500/40 bg-amber-500/15 text-amber-300'
                        : 'border-white/[0.08] bg-white/[0.03] text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {r.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* AD STATUS */}
          <div>
            <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-zinc-500 mb-1.5">
              Ad status
            </label>
            <div className="flex flex-wrap gap-1.5">
              {AD_STATUSES.map(s => {
                const active = (draft.ad_statuses || []).includes(s);
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => toggleStatus(s)}
                    className={`px-2.5 h-7 rounded-lg text-[11px] font-mono border transition-colors cursor-pointer ${
                      active
                        ? 'border-amber-500/40 bg-amber-500/15 text-amber-300'
                        : 'border-white/[0.08] bg-white/[0.03] text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    {cap(s)}
                  </button>
                );
              })}
            </div>
          </div>

          {err && (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/[0.06] px-2.5 py-2">
              <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
              <p className="text-[11px] text-red-300 leading-snug">{err}</p>
            </div>
          )}

          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            className={`w-full h-9 rounded-lg text-[12px] font-semibold inline-flex items-center justify-center gap-2 transition-colors ${
              !dirty || saving
                ? 'bg-white/[0.04] text-zinc-600 cursor-not-allowed'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer'
            }`}
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            {saving ? 'Saving...' : dirty ? 'Save settings' : 'Saved'}
          </button>
        </div>
      )}
    </div>
  );
}

export default function IterationsConfigModal({ open, onClose, onChanged }) {
  const [configs, setConfigs] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [unavailable, setUnavailable] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [c, a] = await Promise.all([
        api.get('/statics-generation/iterations/configs'),
        api.get('/statics-generation/iterations/ad-accounts'),
      ]);
      setConfigs(c.data?.data || []);
      setAccounts(a.data?.data || []);
      setUnavailable(a.data?.unavailable_reason || null);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (open) load(); }, [open, load]);

  if (!open) return null;

  const saveConfig = async (draft) => {
    await api.put(`/statics-generation/iterations/configs/${encodeURIComponent(draft.account_id)}`, {
      max_copy_words: draft.max_copy_words,
      min_spend: draft.min_spend,
      date_range_days: draft.date_range_days,
      ad_statuses: draft.ad_statuses,
      enabled: draft.enabled !== false,
    });
    await load();
    onChanged?.();
  };

  const addAccount = async (accountId) => {
    setError(null);
    try {
      // Defaults match the reference UI: $500 min, All Time, Active + Paused.
      await api.put(`/statics-generation/iterations/configs/${encodeURIComponent(accountId)}`, {
        min_spend: 500,
        date_range_days: null,
        ad_statuses: ['active', 'paused'],
        max_copy_words: 1000,
      });
      await load();
      onChanged?.();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message);
    }
  };

  const removeConfig = async (accountId) => {
    setError(null);
    try {
      await api.delete(`/statics-generation/iterations/configs/${encodeURIComponent(accountId)}`);
      await load();
      onChanged?.();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message);
    }
  };

  const visible = accounts.filter(a => {
    if (!filter.trim()) return true;
    const q = filter.toLowerCase();
    return (a.account_name || '').toLowerCase().includes(q) || (a.account_id || '').toLowerCase().includes(q);
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="bg-[#0c0c0c] border border-white/[0.08] rounded-xl w-full max-w-lg max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
          <div className="flex items-center gap-2">
            <Flame className="w-4 h-4 text-orange-400" />
            <h2 className="text-sm font-semibold text-white">Iterations Config</h2>
          </div>
          <button type="button" onClick={onClose} className="text-zinc-500 hover:text-zinc-200 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 custom-scrollbar">
          {loading && configs.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-4 h-4 animate-spin text-zinc-500" />
            </div>
          ) : (
            <>
              {error && (
                <div className="flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/[0.06] px-2.5 py-2">
                  <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
                  <p className="text-[11px] text-red-300 leading-snug">{error}</p>
                </div>
              )}

              {configs.length === 0 ? (
                <p className="text-[11px] text-zinc-500 leading-relaxed">
                  No ad accounts configured yet. Add one below — Iterations will then surface that
                  account&apos;s live statics that clear the filters you set.
                </p>
              ) : (
                <div className="space-y-2">
                  {configs.map(c => (
                    <ConfigCard key={c.account_id} config={c} onSave={saveConfig} onRemove={removeConfig} />
                  ))}
                </div>
              )}

              {/* Add Ad Account */}
              <div>
                <p className="text-[11px] font-semibold text-zinc-300 mb-2">Add Ad Account</p>
                {unavailable ? (
                  <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-2.5 py-2">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                    <p className="text-[11px] text-amber-200 leading-snug">{unavailable}</p>
                  </div>
                ) : accounts.length === 0 ? (
                  <p className="text-[11px] text-zinc-500">
                    No Meta ad accounts found yet. They appear here once a Meta account has been
                    connected and verified.
                  </p>
                ) : (
                  <>
                    <input
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      placeholder="Filter accounts..."
                      className="w-full h-9 bg-black/40 border border-white/[0.08] rounded-lg px-2.5 text-[12px] text-zinc-200 placeholder:text-zinc-600 mb-2 focus:outline-none focus:border-white/20"
                    />
                    <div className="max-h-52 overflow-y-auto space-y-1.5 custom-scrollbar">
                      {visible.map(a => (
                        <div
                          key={a.account_id}
                          className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-2 ${
                            a.already_added
                              ? 'border-white/[0.05] bg-white/[0.01] opacity-60'
                              : 'border-white/[0.08] bg-white/[0.03]'
                          }`}
                        >
                          <div className="min-w-0">
                            <p className="text-[12px] text-zinc-200 truncate">{a.account_name || a.account_id}</p>
                            <p className="text-[10px] font-mono text-zinc-500 truncate">{a.account_id}</p>
                          </div>
                          {a.already_added ? (
                            <span className="text-[10px] font-mono text-emerald-400/70 shrink-0">Already added</span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => addAccount(a.account_id)}
                              className="inline-flex items-center gap-1 text-[11px] font-mono text-emerald-400 hover:text-emerald-300 cursor-pointer shrink-0"
                            >
                              <Plus className="w-3.5 h-3.5" /> Add
                            </button>
                          )}
                        </div>
                      ))}
                      {visible.length === 0 && (
                        <p className="text-[11px] text-zinc-600 py-2">No account matches &ldquo;{filter}&rdquo;</p>
                      )}
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
