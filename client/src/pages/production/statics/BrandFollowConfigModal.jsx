import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  X, Loader2, RefreshCw, ChevronDown, ChevronUp, Search, Layers, Zap, Info, Download,
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
  const [autoSyncBusy, setAutoSyncBusy] = useState(false);
  const [autoSyncMsg, setAutoSyncMsg] = useState(null);

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

  const handleMasterAutoSync = async (next) => {
    if (autoSyncBusy) return;
    setAutoSyncBusy(true);
    setAutoSyncMsg(null);
    try {
      const { data } = await api.post('/statics-generation/league/brand-configs/auto-sync-all', { enabled: next });
      const r = data?.data || {};
      setAutoSyncMsg(`Auto-sync ${next ? 'enabled' : 'disabled'} on ${r.touched || 0} brand${r.touched === 1 ? '' : 's'}`);
      await load();
    } catch (err) {
      setAutoSyncMsg(`Failed: ${err.response?.data?.error?.message || err.message}`);
    } finally {
      setAutoSyncBusy(false);
    }
  };

  const handleSyncAll = async () => {
    if (syncingAll) return;
    setSyncingAll(true);
    setSyncAllMsg(null);
    try {
      const { data } = await api.post('/statics-generation/league/brand-configs/sync-all');
      const r = data?.data || {};
      // The import runs on the server in the background (big brands take
      // minutes). Refresh FROM LEAGUE a few times so cards appear as they land.
      setSyncAllMsg(`Import started for ${r.brands || 0} brands. Cards appear in FROM LEAGUE as each brand finishes.`);
      await load();
      onSynced?.(r);
      [30, 90, 180, 300].forEach((sec) => setTimeout(() => onSynced?.(r), sec * 1000));
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
    const anyAutoSync = enabled > 0;
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
    return { count: brands.length, eligible: eligible.length, enabled, anyAutoSync, totalProjected, nextAutoSync };
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
        <div className="flex items-start justify-between gap-4 px-6 py-5 border-b border-white/[0.06]">
          <div className="flex items-start gap-3 min-w-0">
            <Layers className="w-5 h-5 text-[#c9a84c] mt-0.5 shrink-0" />
            <div className="space-y-1 min-w-0">
              <h2 className="text-xl font-semibold text-white">Brand Follow Config</h2>
              <p className="text-sm text-zinc-300 leading-relaxed max-w-lg">
                Import top static ads from the brands you follow.
              </p>
              <p className="text-xs text-zinc-500 leading-relaxed max-w-lg">
                Imported ads are pinned to FROM LEAGUE with a star badge.
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-white/[0.05] text-zinc-400 cursor-pointer shrink-0">
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
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
              <div className="flex items-start gap-3 min-w-0">
                <Layers className="w-4 h-4 text-[#c9a84c] mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className="text-[11px] font-mono uppercase tracking-widest text-zinc-400">
                      Control Center
                    </span>
                    {!followedFlag && (
                      <span
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-[#c9a84c]/30 bg-[#c9a84c]/10 text-[#c9a84c] text-[10px] font-mono"
                        title="No formally-followed brands found; falling back to top-100 active Brand Spy brands."
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-[#c9a84c]" />
                        Fallback
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-zinc-300 leading-relaxed">
                    <span className="text-white font-semibold">{summary.count}</span> brand{summary.count === 1 ? '' : 's'}
                    {' · '}
                    <span className="text-[#c9a84c] font-bold">~{summary.totalProjected}</span> ads to import
                  </div>
                  {summary.nextAutoSync && (
                    <div className="text-xs text-zinc-500 mt-0.5">
                      Next auto-sync {summary.nextAutoSync > Date.now()
                        ? `in ${Math.max(1, Math.round((summary.nextAutoSync - Date.now()) / 3600000))}h`
                        : 'pending'}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap shrink-0">
                {/* Master Auto-sync toggle — flips every brand's
                    auto_sync_enabled in one call. */}
                <button
                  type="button"
                  onClick={() => handleMasterAutoSync(!summary.anyAutoSync)}
                  disabled={autoSyncBusy || summary.count === 0}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 bg-white/[0.04] hover:bg-white/[0.08] text-zinc-300 text-xs font-medium cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  title={summary.anyAutoSync
                    ? 'Auto-sync is on for some brands, click to pause all'
                    : 'Auto-sync is off everywhere, click to enable on all brands'}
                >
                  {autoSyncBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                  {`Auto-sync ${summary.anyAutoSync ? 'on' : 'off'}`}
                </button>
                <button
                  type="button"
                  onClick={handleSyncAll}
                  disabled={syncingAll || summary.count === 0}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#c9a84c] hover:bg-[#d9ba63] text-black text-xs font-semibold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  title="Import the top N% of each brand's static ads into the FROM LEAGUE column"
                >
                  {syncingAll ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                  {syncingAll ? 'Importing…' : 'Import all'}
                </button>
              </div>
            </div>
            {syncAllMsg && (
              <div className="mt-3 text-xs text-zinc-400 border-t border-white/[0.08] pt-2">
                {syncAllMsg}
              </div>
            )}
            {autoSyncMsg && (
              <div className="mt-2 text-xs text-zinc-400">
                {autoSyncMsg}
              </div>
            )}
          </div>

          <div>
            <div className="flex items-center gap-2 mb-3">
              <h3 className="text-xs font-mono uppercase tracking-widest text-zinc-400">Followed Brands</h3>
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full border border-[#c9a84c]/30 text-[#c9a84c] text-[10px] font-mono">
                {brands.length}
              </span>
            </div>

            {loading && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin text-[#c9a84c]" />
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
            <h3 className="text-sm font-semibold text-white mb-2">Filter</h3>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-600" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter brands…"
                className="w-full pl-10 pr-3 py-2.5 rounded-lg bg-white/[0.04] border border-white/10 focus:border-[#c9a84c]/40 focus:outline-none text-zinc-200 text-sm placeholder:text-zinc-600"
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
  const [pickerOpen, setPickerOpen] = useState(false);
  // Default count = projected (from top_pct math) clamped to active_image_count.
  const defaultCount = Math.max(1, Math.min(projected_import_count || 5, active_image_count || 1));
  const [importCount, setImportCount] = useState(defaultCount);
  useEffect(() => { setImportCount(defaultCount); }, [defaultCount]);

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

  // Manual count-driven import. `count=null` falls back to the configured
  // top_pct math (legacy behavior, kept for Import-all + auto-sync paths).
  const handleSyncNow = async (count = null) => {
    if (syncing) return;
    setSyncing(true);
    setSyncMsg(null);
    setPickerOpen(false);
    try {
      const body = count != null ? { count } : {};
      const { data } = await api.post(`/statics-generation/league/brand-configs/${id}/sync`, body);
      const r = data?.data || {};
      setSyncMsg(`Imported: ${r.imported || 0} new${r.skipped ? `, ${r.skipped} already in library` : ''}`);
      onSynced?.({ brandId: id, ...r });
    } catch (err) {
      setSyncMsg(`Import failed: ${err.response?.data?.error?.message || err.message}`);
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
    <div className={`rounded-xl border ${expanded ? 'border-[#c9a84c]/30 bg-[#c9a84c]/[0.03]' : 'border-white/10 bg-white/[0.02]'}`}>
      {/* Summary row */}
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="shrink-0 w-9 h-9 rounded-lg bg-black/40 border border-white/10 flex items-center justify-center text-zinc-300 text-sm font-semibold">
          {initial}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-base font-medium text-white truncate">{name || domain}</div>
          <div className="text-xs text-zinc-400">
            {active_image_count} active · ~{projected_import_count} to import
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {pickerOpen ? (
            <div className="flex items-center gap-1.5 bg-[#c9a84c]/[0.06] border border-[#c9a84c]/40 rounded-lg px-2 py-1">
              <span className="text-[10px] font-mono text-[#c9a84c] uppercase tracking-wide">Import</span>
              <input
                type="number"
                min="1"
                max={Math.max(1, active_image_count || 1)}
                value={importCount}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  if (Number.isFinite(n)) setImportCount(Math.max(1, Math.min(active_image_count || 999, n)));
                }}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSyncNow(importCount); if (e.key === 'Escape') setPickerOpen(false); }}
                autoFocus
                className="w-16 px-1.5 py-0.5 rounded bg-black/40 border border-white/10 text-zinc-100 text-xs text-center focus:outline-none focus:border-[#c9a84c]/60"
              />
              <span className="text-[10px] text-zinc-500">of {active_image_count}</span>
              <button
                type="button"
                onClick={() => handleSyncNow(importCount)}
                disabled={syncing}
                className="ml-1 inline-flex items-center gap-1 px-2 py-1 rounded bg-[#c9a84c] hover:bg-[#d9ba63] text-black text-[10px] font-semibold cursor-pointer disabled:opacity-40"
              >
                {syncing ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Go'}
              </button>
              <button
                type="button"
                onClick={() => setPickerOpen(false)}
                className="p-0.5 rounded text-zinc-500 hover:text-zinc-200 cursor-pointer"
                title="Cancel"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              disabled={syncing || (active_image_count || 0) === 0}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#c9a84c]/40 hover:bg-[#c9a84c]/10 text-white text-xs font-medium cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title="Pick how many static ads to import from this brand"
            >
              {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin text-[#c9a84c]" /> : <Download className="w-3.5 h-3.5 text-[#c9a84c]" />}
              {syncing ? 'Importing…' : 'Import'}
            </button>
          )}
          <button
            type="button"
            onClick={onToggleExpand}
            className="p-2 rounded-lg bg-white/[0.04] border border-white/10 hover:bg-white/[0.08] text-zinc-300 cursor-pointer"
            title={expanded ? 'Collapse' : 'Configure'}
          >
            {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {syncMsg && (
        <div className="px-4 pb-2 text-xs text-zinc-400">
          {syncMsg}
        </div>
      )}

      {/* Expanded controls */}
      {expanded && (
        <div className="border-t border-white/10 px-4 py-4 space-y-5">
          {/* Top ads to import */}
          <div>
            <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
              <label className="text-sm text-zinc-300 flex items-center gap-1.5">
                Top ads to import
                <Info className="w-3.5 h-3.5 text-zinc-500" title="Picks the top N% of this brand's active image ads ordered by tier_score DESC, current_rank ASC: BANGER first, then CHAMP, A, B, C, MID, TEST. Within a tier, ads ranked higher in the FB Ad Library (lower current_rank) come first." />
              </label>
              <span className="text-sm text-white font-bold">
                {localTopPct}% (~{Math.max(1, Math.ceil(active_image_count * (localTopPct / 100)))} ads)
              </span>
            </div>
            <input
              type="range"
              min="1"
              max="100"
              value={localTopPct}
              onChange={(e) => setLocalTopPct(parseInt(e.target.value, 10))}
              className="w-full h-1.5 rounded-full bg-zinc-300 accent-[#c9a84c] cursor-pointer"
            />
            <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
              <span>1%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span>
            </div>
            <div className="text-xs text-zinc-500 mt-2 leading-relaxed">
              Best converters first: <span className="text-[#c9a84c] font-semibold">BANGER</span> → CHAMP → A → B → C, then by FB Ad Library position.
            </div>
          </div>

          {/* Tier filter */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm text-zinc-300">Tier filter</label>
              <span className="text-xs text-zinc-400">
                {Array.isArray(config.tier_filter) && config.tier_filter.length > 0
                  ? `${config.tier_filter.length} selected`
                  : 'All tiers'}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {ALL_TIERS.map(tier => {
                const active = tierActive(tier);
                const selected = Array.isArray(config.tier_filter) && config.tier_filter.includes(tier);
                return (
                  <button
                    key={tier}
                    type="button"
                    onClick={() => toggleTier(tier)}
                    className={`px-2 py-1 rounded text-[10px] font-mono uppercase font-bold transition-all cursor-pointer border ${
                      !active
                        ? 'bg-white/[0.03] text-zinc-600 border-white/[0.06] hover:text-zinc-400'
                        : selected
                          ? 'bg-[#c9a84c]/25 text-[#e8d5a3] border-[#c9a84c]/40'
                          : 'bg-[#c9a84c]/10 text-[#c9a84c] border-[#c9a84c]/40'
                    }`}
                  >
                    {tier}
                  </button>
                );
              })}
              {Array.isArray(config.tier_filter) && config.tier_filter.length > 0 && (
                <button
                  type="button"
                  onClick={() => onPatch({ tier_filter: null })}
                  className="px-2 py-1 rounded text-xs text-zinc-400 hover:text-zinc-200 cursor-pointer"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Max copy length */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm text-zinc-300">Max ad copy length</label>
              <span className="text-sm text-white font-bold">
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
              className="w-full h-1.5 rounded-full bg-zinc-300 accent-[#c9a84c] cursor-pointer"
            />
            <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
              <span>No limit</span><span>500</span><span>1000</span>
            </div>
          </div>

          {/* ── Import breadth (migration 094) ────────────────────────────────
              These three were hardcoded before: currently-running plain images,
              best-tier-first. On mydermadream that reached 9 of 100 available
              creatives. "Longest running" in particular was unreachable, because
              a proven long-runner that has since ended fails the active filter. */}

          {/* Sort by */}
          <div>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <label className="text-sm text-zinc-300 sm:w-40 shrink-0">Import by</label>
              <div className="flex flex-wrap gap-1.5">
                {[
                  { v: 'tier_score',      label: 'Top performers' },
                  { v: 'longest_running', label: 'Longest running' },
                  { v: 'newest',          label: 'Newest' },
                ].map(o => {
                  const active = (config.sort_mode || 'tier_score') === o.v;
                  return (
                    <button
                      key={o.v}
                      type="button"
                      onClick={() => onPatch({ sort_mode: o.v })}
                      className={`px-2.5 h-7 rounded-lg text-xs border transition-colors cursor-pointer ${
                        active
                          ? 'border-[#c9a84c]/50 bg-[#c9a84c]/10 text-white'
                          : 'border-white/10 bg-white/[0.03] text-zinc-300 hover:text-white'
                      }`}
                    >
                      {o.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <p className="text-xs text-zinc-500 mt-1.5">
              Longest running highlights ads with proven staying power.
            </p>
          </div>

          {/* Format */}
          <div>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <label className="text-sm text-zinc-300 sm:w-40 shrink-0">Creative formats</label>
              <div className="flex flex-wrap gap-1.5">
                {[
                  { v: 'IMAGE',      label: 'Images only' },
                  { v: 'ALL_STATIC', label: 'All statics' },
                  { v: 'CAROUSEL',   label: 'Carousel only' },
                ].map(o => {
                  const active = (config.format_filter || 'IMAGE') === o.v;
                  return (
                    <button
                      key={o.v}
                      type="button"
                      onClick={() => onPatch({ format_filter: o.v })}
                      className={`px-2.5 h-7 rounded-lg text-xs border transition-colors cursor-pointer ${
                        active
                          ? 'border-[#c9a84c]/50 bg-[#c9a84c]/10 text-white'
                          : 'border-white/10 bg-white/[0.03] text-zinc-300 hover:text-white'
                      }`}
                    >
                      {o.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <p className="text-xs text-zinc-500 mt-1.5">
              Images only excludes carousel, DCO and DPA.
            </p>
          </div>

          <div className="border-t border-white/10" />

          {/* Include ended ads */}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <label className="text-sm text-zinc-300">Include ended ads</label>
              <p className="text-xs text-zinc-500 mt-0.5">
                Only running ads when disabled.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onPatch({ include_inactive: !config.include_inactive })}
              className={`relative inline-flex h-5 w-10 items-center rounded-full transition-colors cursor-pointer shrink-0 ${
                config.include_inactive ? 'bg-[#c9a84c]' : 'bg-zinc-700'
              }`}
              title={config.include_inactive ? 'Disable to only show running ads' : 'Enable to include ended ads'}
            >
              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                config.include_inactive ? 'translate-x-5' : 'translate-x-1'
              }`} />
            </button>
          </div>

          {/* Auto-sync */}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <label className="text-sm text-zinc-300">
                Auto-sync (every {config.auto_sync_interval_hours}h)
              </label>
              <p className="text-xs text-zinc-500 mt-0.5">
                Last synced: {formatRelative(config.last_synced_at)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onPatch({ auto_sync_enabled: !config.auto_sync_enabled })}
              className={`relative inline-flex h-5 w-10 items-center rounded-full transition-colors cursor-pointer shrink-0 ${
                config.auto_sync_enabled ? 'bg-[#c9a84c]' : 'bg-zinc-700'
              }`}
              title={config.auto_sync_enabled ? 'Disable auto-sync' : 'Enable auto-sync'}
            >
              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                config.auto_sync_enabled ? 'translate-x-5' : 'translate-x-1'
              }`} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default BrandFollowConfigModal;
