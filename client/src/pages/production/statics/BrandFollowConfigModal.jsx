import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  X, Loader2, RefreshCw, ChevronDown, ChevronUp, Search, Layers, Zap, Info,
} from 'lucide-react';
import api from '../../../services/api';

const ALL_TIERS = ['BANGER', 'CHAMP', 'A', 'B', 'C', 'MID', 'TEST'];

function formatRelative(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'never';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/**
 * Brand Follow Config — per-brand import preferences for the FROM LEAGUE
 * column. Backed by /league/brand-configs.
 *
 * Triggered from the gear icon in the FROM LEAGUE column header.
 *
 * Each brand row collapses to a 1-line summary. Expanding reveals:
 *   - Top ads to import (1-100% slider) — shows the projected ad count.
 *   - Tier filter chips (multi-select; empty = all tiers).
 *   - Max ad copy length (0=no limit; 1000 cap).
 *   - Auto-sync toggle + interval (hours).
 *   - "Last synced X ago" + Sync Now button.
 *
 * All writes go through PATCH /league/brand-configs/:brandId (debounced for
 * slider changes; immediate for toggles + chip clicks).
 */
export function BrandFollowConfigModal({ isOpen, onClose, onSynced }) {
  const [brands, setBrands] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());
  const [search, setSearch] = useState('');
  const [followedFlag, setFollowedFlag] = useState(true);
  const [syncingAll, setSyncingAll] = useState(false);
  const [syncAllMsg, setSyncAllMsg] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.get('/statics-generation/league/brand-configs');
      setBrands(data?.data || []);
      setFollowedFlag(data?.followed !== false);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSyncAll = async () => {
    if (syncingAll) return;
    setSyncingAll(true);
    setSyncAllMsg(null);
    try {
      const { data } = await api.post('/statics-generation/league/brand-configs/sync-all');
      const r = data?.data || {};
      setSyncAllMsg(`Synced ${r.brands || 0} brands — ${r.imported || 0} imported, ${r.skipped || 0} already in library` + ((r.errors || []).length ? ` (${r.errors.length} errored)` : ''));
      await load();
      onSynced?.(r);
    } catch (err) {
      setSyncAllMsg(`Sync all failed: ${err.response?.data?.error?.message || err.message}`);
    } finally {
      setSyncingAll(false);
    }
  };

  useEffect(() => { if (isOpen) load(); }, [isOpen, load]);

  // ESC to close
  useEffect(() => {
    if (!isOpen) return;
    const h = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [isOpen, onClose]);

  const filtered = useMemo(() => {
    if (!search.trim()) return brands;
    const q = search.toLowerCase();
    return brands.filter(b =>
      (b.name || '').toLowerCase().includes(q) ||
      (b.domain || '').toLowerCase().includes(q)
    );
  }, [brands, search]);

  // Aggregate summary — fuel for the Control Center header row. Counts only
  // brands that will actually contribute (active_image_count > 0). Total
  // projected imports = sum of per-brand projections (already tier_filter +
  // top_pct adjusted by the backend's projection math).
  const summary = useMemo(() => {
    const eligible = brands.filter(b => (b.active_image_count || 0) > 0);
    const enabled = brands.filter(b => b.config?.auto_sync_enabled).length;
    const totalProjected = eligible.reduce((s, b) => s + (b.projected_import_count || 0), 0);
    const nextAutoSync = (() => {
      const eligible = brands.filter(b => b.config?.auto_sync_enabled);
      if (eligible.length === 0) return null;
      let soonest = null;
      for (const b of eligible) {
        const last = b.config?.last_synced_at ? new Date(b.config.last_synced_at).getTime() : 0;
        const due  = last + (b.config?.auto_sync_interval_hours || 4) * 3600 * 1000;
        if (soonest === null || due < soonest) soonest = due;
      }
      return soonest;
    })();
    return { count: brands.length, eligible: eligible.length, enabled, totalProjected, nextAutoSync };
  }, [brands]);

  const toggleExpand = (id) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Patch a brand's config and update local state with the server's
  // canonical merged config. Reloads if the projected_import_count
  // depends on top_pct (it does), so the summary line stays accurate.
  const patchBrand = async (brandId, patch) => {
    try {
      const { data } = await api.patch(`/statics-generation/league/brand-configs/${brandId}`, patch);
      const next = data?.data;
      if (next) {
        setBrands(prev => prev.map(b => b.id === brandId
          ? {
              ...b,
              config: next,
              projected_import_count: b.active_image_count > 0
                ? Math.max(1, Math.ceil(b.active_image_count * (next.top_pct / 100)))
                : 0,
            }
          : b
        ));
      }
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/80 backdrop-blur-sm p-6 overflow-y-auto" onClick={onClose}>
      <div
        className="relative bg-zinc-950 border border-white/[0.08] rounded-xl max-w-3xl w-full my-8 flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-5 border-b border-white/[0.06]">
          <div className="space-y-1">
            <h2 className="text-lg font-mono text-white">Brand Follow Config</h2>
            <p className="text-xs text-zinc-500 leading-relaxed max-w-lg">
              Manage which brands auto-pull static ads into the Spy Reference Library and at what cadence.
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-white/[0.05] text-zinc-400 cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-5 max-h-[75vh] overflow-y-auto custom-scrollbar">
          {error && (
            <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-300">
              {error}
            </div>
          )}

          {/* Control Center — top-of-modal summary + sync-all */}
          <div className="rounded-lg border border-violet-400/20 bg-violet-500/[0.04] p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3 min-w-0">
                <Layers className="w-4 h-4 text-violet-300 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <div className="text-[11px] font-mono uppercase tracking-wider text-violet-300 mb-1">
                    Control Center
                    {!followedFlag && (
                      <span className="ml-2 text-[9px] normal-case text-amber-300/80" title="No formally-followed brands found; falling back to top-100 active Brand Spy brands.">
                        · fallback
                      </span>
                    )}
                  </div>
                  <div className="text-xs font-mono text-zinc-200 leading-relaxed">
                    <span className="text-white font-bold">{summary.count}</span> brand{summary.count === 1 ? '' : 's'}
                    {summary.enabled > 0 && (<> · <span className="text-emerald-300 font-bold">{summary.enabled}</span> auto-syncing</>)}
                    {' · '}
                    <span className="text-cyan-300 font-bold">~{summary.totalProjected}</span> ads will sync
                  </div>
                  {summary.nextAutoSync && (
                    <div className="text-[10px] font-mono text-zinc-500 mt-0.5">
                      Next auto-sync {summary.nextAutoSync > Date.now()
                        ? `in ${Math.max(1, Math.round((summary.nextAutoSync - Date.now()) / 3600000))}h`
                        : 'pending'}
                    </div>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={handleSyncAll}
                disabled={syncingAll || summary.count === 0}
                className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-violet-500/20 border border-violet-400/40 hover:bg-violet-500/30 text-violet-200 text-xs font-mono font-semibold uppercase tracking-wide cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                title="Import the top N% of each brand's static ads into the FROM LEAGUE column"
              >
                {syncingAll ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                {syncingAll ? 'Importing…' : 'Import all'}
              </button>
            </div>
            {syncAllMsg && (
              <div className="mt-3 text-[10px] font-mono text-zinc-400 border-t border-white/[0.05] pt-2">
                {syncAllMsg}
              </div>
            )}
          </div>

          <div>
            <h3 className="text-sm font-mono font-semibold text-white mb-3">Followed Brands</h3>

            {loading && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin text-violet-400" />
              </div>
            )}

            {!loading && filtered.length === 0 && (
              <div className="text-xs text-zinc-500 text-center py-8">
                {brands.length === 0
                  ? 'No followed brands yet. Follow some from the League view first.'
                  : 'No brands match your search.'}
              </div>
            )}

            <div className="space-y-2">
              {filtered.map((b) => (
                <BrandRow
                  key={b.id}
                  brand={b}
                  expanded={expanded.has(b.id)}
                  onToggleExpand={() => toggleExpand(b.id)}
                  onPatch={(patch) => patchBrand(b.id, patch)}
                  onSynced={(payload) => {
                    // Re-pull from server so last_synced_at + counts stay in sync.
                    load();
                    onSynced?.(payload);
                  }}
                />
              ))}
            </div>
          </div>

          {/* Search */}
          <div>
            <h3 className="text-sm font-mono font-semibold text-white mb-2">Filter</h3>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-600" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter brands…"
                className="w-full pl-10 pr-3 py-2.5 rounded-md bg-white/[0.04] border border-white/[0.08] focus:border-violet-400/40 focus:outline-none text-zinc-200 text-sm font-mono placeholder:text-zinc-600"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
 * One brand row — collapsed = 1-line summary; expanded = full controls
 * -------------------------------------------------------------------------- */

function BrandRow({ brand, expanded, onToggleExpand, onPatch, onSynced }) {
  const { id, name, domain, active_image_count, projected_import_count, config } = brand;
  const initial = (name || domain || '?').charAt(0).toUpperCase();
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);

  // Local "in-flight" copy so sliders feel responsive while the debounced
  // patch flies. Resets when config changes from the server.
  const [localTopPct, setLocalTopPct] = useState(config.top_pct);
  const [localMaxLen, setLocalMaxLen] = useState(config.max_copy_length || 0);
  useEffect(() => { setLocalTopPct(config.top_pct); }, [config.top_pct]);
  useEffect(() => { setLocalMaxLen(config.max_copy_length || 0); }, [config.max_copy_length]);

  // Debounced patch for sliders — fires 350ms after the user stops dragging.
  useEffect(() => {
    if (localTopPct === config.top_pct) return undefined;
    const t = setTimeout(() => onPatch({ top_pct: localTopPct }), 350);
    return () => clearTimeout(t);
  }, [localTopPct, config.top_pct, onPatch]);
  useEffect(() => {
    if (localMaxLen === (config.max_copy_length || 0)) return undefined;
    const t = setTimeout(() => onPatch({ max_copy_length: localMaxLen || null }), 350);
    return () => clearTimeout(t);
  }, [localMaxLen, config.max_copy_length, onPatch]);

  const handleSyncNow = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncMsg(null);
    try {
      const { data } = await api.post(`/statics-generation/league/brand-configs/${id}/sync`);
      const r = data?.data || {};
      setSyncMsg(`Synced — ${r.imported || 0} imported, ${r.skipped || 0} already-in-lib`);
      onSynced?.({ brandId: id, ...r });
    } catch (err) {
      setSyncMsg(`Sync failed: ${err.response?.data?.error?.message || err.message}`);
    } finally {
      setSyncing(false);
    }
  };

  const toggleTier = (tier) => {
    const current = Array.isArray(config.tier_filter) ? config.tier_filter : [];
    const next = current.includes(tier)
      ? current.filter(t => t !== tier)
      : [...current, tier];
    onPatch({ tier_filter: next.length === 0 ? null : next });
  };
  const tierActive = (tier) => {
    const current = Array.isArray(config.tier_filter) ? config.tier_filter : [];
    return current.length === 0 || current.includes(tier);
  };

  return (
    <div className={`rounded-lg border ${expanded ? 'border-violet-400/30 bg-violet-500/[0.03]' : 'border-white/[0.06] bg-white/[0.02]'}`}>
      {/* Summary row */}
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="shrink-0 w-9 h-9 rounded-md bg-white/[0.05] border border-white/[0.08] flex items-center justify-center text-zinc-300 text-sm font-mono font-bold">
          {initial}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-mono text-white truncate">{name || domain}</div>
          <div className="text-[11px] font-mono text-zinc-500">
            {active_image_count} active · will import ~{projected_import_count}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={handleSyncNow}
            disabled={syncing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-violet-500/15 border border-violet-400/30 hover:bg-violet-500/25 hover:border-violet-400/50 text-violet-200 text-[10px] font-mono font-semibold uppercase tracking-wide cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title="Import the top N% of this brand's static ads into the FROM LEAGUE column"
          >
            {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            {syncing ? 'Importing…' : 'Import'}
          </button>
          <button
            type="button"
            onClick={onToggleExpand}
            className="p-2 rounded-md bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] text-zinc-300 cursor-pointer"
            title={expanded ? 'Collapse' : 'Configure'}
          >
            {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {syncMsg && (
        <div className="px-4 pb-2 text-[10px] font-mono text-zinc-400">
          {syncMsg}
        </div>
      )}

      {/* Expanded controls */}
      {expanded && (
        <div className="border-t border-white/[0.05] px-4 py-4 space-y-5">
          {/* Top ads to import */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-mono text-zinc-300 flex items-center gap-1.5">
                Top ads to import
                <Info className="w-3 h-3 text-zinc-500" title="Picks the top N% of this brand's active image ads ordered by tier_score DESC, current_rank ASC — BANGER first, then CHAMP, A, B, C, MID, TEST. Within a tier, ads ranked higher in the FB Ad Library (lower current_rank) come first." />
              </label>
              <span className="text-xs font-mono text-cyan-300">
                {localTopPct}% (~{Math.max(1, Math.ceil(active_image_count * (localTopPct / 100)))} ads)
              </span>
            </div>
            <input
              type="range"
              min="1"
              max="100"
              value={localTopPct}
              onChange={(e) => setLocalTopPct(parseInt(e.target.value, 10))}
              className="w-full accent-violet-500"
            />
            <div className="flex justify-between text-[9px] font-mono text-zinc-600 mt-1">
              <span>1%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span>
            </div>
            <div className="text-[10px] font-mono text-zinc-500 mt-2 leading-relaxed">
              Ranked best-converters first <span className="text-[#c9a84c]">BANGER</span> → CHAMP → A → B → C, then by FB Ad Library position.
            </div>
          </div>

          {/* Tier filter */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-mono text-zinc-300">Tier filter</label>
              <span className="text-[10px] font-mono text-zinc-600">
                {Array.isArray(config.tier_filter) && config.tier_filter.length > 0
                  ? `${config.tier_filter.length} selected`
                  : 'All tiers'}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {ALL_TIERS.map(tier => (
                <button
                  key={tier}
                  type="button"
                  onClick={() => toggleTier(tier)}
                  className={`px-2 py-1 rounded text-[10px] font-mono font-bold transition-all cursor-pointer ${
                    tierActive(tier)
                      ? 'bg-[#c9a84c]/30 text-[#e8d5a3] border border-[#c9a84c]/40'
                      : 'bg-white/[0.03] text-zinc-600 border border-white/[0.06] hover:text-zinc-400'
                  }`}
                >
                  {tier}
                </button>
              ))}
              {Array.isArray(config.tier_filter) && config.tier_filter.length > 0 && (
                <button
                  type="button"
                  onClick={() => onPatch({ tier_filter: null })}
                  className="px-2 py-1 rounded text-[10px] font-mono text-zinc-400 hover:text-zinc-200 cursor-pointer"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Max copy length */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-mono text-zinc-300">Max ad copy length</label>
              <span className="text-xs font-mono text-violet-300">
                {localMaxLen === 0 ? 'No limit' : `${localMaxLen} chars`}
              </span>
            </div>
            <input
              type="range"
              min="0"
              max="1000"
              step="50"
              value={localMaxLen}
              onChange={(e) => setLocalMaxLen(parseInt(e.target.value, 10))}
              className="w-full accent-violet-500"
            />
            <div className="flex justify-between text-[9px] font-mono text-zinc-600 mt-1">
              <span>No limit</span><span>500</span><span>1000</span>
            </div>
          </div>

          {/* Auto-sync */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-mono text-zinc-300">
                Auto-sync (every {config.auto_sync_interval_hours}h)
              </label>
              <button
                type="button"
                onClick={() => onPatch({ auto_sync_enabled: !config.auto_sync_enabled })}
                className={`relative inline-flex h-5 w-10 items-center rounded-full transition-colors cursor-pointer ${
                  config.auto_sync_enabled ? 'bg-emerald-500/80' : 'bg-white/[0.08]'
                }`}
                title={config.auto_sync_enabled ? 'Disable auto-sync' : 'Enable auto-sync'}
              >
                <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                  config.auto_sync_enabled ? 'translate-x-5' : 'translate-x-1'
                }`} />
              </button>
            </div>
            <div className="text-[10px] font-mono text-zinc-600">
              Last synced {formatRelative(config.last_synced_at)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default BrandFollowConfigModal;
