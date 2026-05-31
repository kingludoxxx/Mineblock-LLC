import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Repeat, Loader2, RefreshCw, Clock, X, Sparkles, SlidersHorizontal,
  CheckCircle2, Trash2,
} from 'lucide-react';
import api from '../../../services/api';

// Default thresholds are permissive — show anything with meaningful spend + positive ROAS.
// User can tighten via the filters panel. Strict "winners" would be $200+ / 2x+.
const DEFAULT_MIN_SPEND = 50;
const DEFAULT_MIN_ROAS = 1.5;
const DEFAULT_WINDOW_DAYS = 30;

const COUNT_OPTIONS = [1, 2, 3, 5];
const RATIO_OPTIONS = ['9:16', '4:5', '1:1'];

function formatMoney(n) {
  const num = Number(n) || 0;
  if (num >= 1000) return `$${(num / 1000).toFixed(1)}k`;
  return `$${num.toFixed(0)}`;
}

function timeAgo(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

// ---------------------------------------------------------------------------
// IteratePopover — anchored popover under the pink Iterate button.
// Replaces the old centered modal. Count chips + ratio chips + live total.
// ---------------------------------------------------------------------------
function IteratePopover({ winner, productId, anchorRef, onClose, onSubmitted }) {
  const popRef = useRef(null);
  const [variations, setVariations] = useState(3);
  const [ratios, setRatios] = useState(['9:16', '4:5', '1:1']);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  // Close on outside click + Escape
  useEffect(() => {
    const onDoc = (e) => {
      if (popRef.current?.contains(e.target)) return;
      if (anchorRef?.current?.contains(e.target)) return;
      onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, anchorRef]);

  const toggleRatio = (r) => {
    setRatios((cur) => cur.includes(r) ? cur.filter(x => x !== r) : [...cur, r]);
  };

  const total = variations * (ratios.length || 0);

  const submit = async () => {
    if (ratios.length === 0) { setError('Pick at least one ratio'); return; }
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.post(
        `/statics-generation/iterate/${winner.creative_id}`,
        { variations, ratios, productId: productId || undefined }
      );
      const data = res.data?.data || res.data;
      onSubmitted?.(data);
      onClose();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.response?.data?.error || err.message);
      setSubmitting(false);
    }
  };

  return (
    <div
      ref={popRef}
      className="absolute left-0 right-0 top-full mt-2 z-30 rounded-lg border border-white/[0.08] bg-zinc-950/95 backdrop-blur-xl shadow-2xl p-3 space-y-3"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-300">
          Generate Iterations
        </span>
        <button
          onClick={onClose}
          className="text-zinc-500 hover:text-white cursor-pointer"
          title="Close"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div>
        <div className="text-[9px] font-mono uppercase tracking-wider text-zinc-500 mb-1.5">Count</div>
        <div className="flex gap-1.5">
          {COUNT_OPTIONS.map((n) => (
            <button
              key={n}
              onClick={() => setVariations(n)}
              disabled={submitting}
              className={`flex-1 h-8 rounded-md text-[12px] font-mono font-semibold transition-colors cursor-pointer disabled:opacity-40 ${
                variations === n
                  ? 'bg-fuchsia-500 text-white'
                  : 'bg-white/[0.04] text-zinc-300 hover:bg-white/[0.08]'
              }`}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="text-[9px] font-mono uppercase tracking-wider text-zinc-500 mb-1.5">Ratios</div>
        <div className="flex gap-1.5">
          {RATIO_OPTIONS.map((r) => {
            const active = ratios.includes(r);
            return (
              <button
                key={r}
                onClick={() => toggleRatio(r)}
                disabled={submitting}
                className={`flex-1 h-8 rounded-md text-[11px] font-mono font-semibold transition-colors cursor-pointer disabled:opacity-40 ${
                  active
                    ? 'bg-fuchsia-500 text-white'
                    : 'bg-white/[0.04] text-zinc-400 hover:bg-white/[0.08]'
                }`}
              >
                {r}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex items-center justify-between text-[11px] font-mono pt-0.5">
        <span className="text-zinc-500 uppercase tracking-wider">Total</span>
        <span className="text-white font-semibold">{total} image{total === 1 ? '' : 's'}</span>
      </div>

      {error && (
        <div className="px-2 py-1.5 bg-red-500/10 border border-red-500/30 rounded text-[10px] text-red-300">
          {String(error)}
        </div>
      )}

      <button
        onClick={submit}
        disabled={submitting || ratios.length === 0 || total === 0}
        className="w-full h-9 rounded-md bg-fuchsia-500 hover:bg-fuchsia-400 text-white text-[12px] font-mono font-semibold uppercase tracking-wider transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
      >
        {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
        {submitting ? 'Starting…' : 'Generate'}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Individual winner card — now with 3 action buttons (Select / Iterate / Hide)
// ---------------------------------------------------------------------------
function WinnerCard({ winner, productId, onUseAsReference, onSubmitted, onDismissed }) {
  const roas = Number(winner.roas) || 0;
  const spend = Number(winner.spend) || 0;
  const cpa = Number(winner.cpa) || 0;
  const itCount = Number(winner.iteration_count) || 0;
  const itAgo = timeAgo(winner.iterated_at);

  const [popoverOpen, setPopoverOpen] = useState(false);
  const [selected, setSelected] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [dismissError, setDismissError] = useState(null);
  const iterateBtnRef = useRef(null);

  const handleSelect = () => {
    setSelected(true);
    // Hand the card to the parent so it can pre-load this image in the main
    // statics-generation flow (operator picks angle there).
    onUseAsReference?.(winner);
  };

  const handleHide = async () => {
    if (dismissing) return;
    const ok = window.confirm(`Hide "${winner.ad_name || winner.creative_id}" from the Iterations queue?\n\nIt won't appear here again until you un-dismiss it.`);
    if (!ok) return;
    setDismissing(true);
    setDismissError(null);
    try {
      await api.post(`/statics-generation/iterations/${winner.creative_id}/dismiss`);
      onDismissed?.(winner.creative_id);
    } catch (err) {
      setDismissError(err.response?.data?.error?.message || err.message);
      setDismissing(false);
    }
  };

  return (
    <div className={`group relative glass-card border rounded-xl overflow-hidden transition-all shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)] ${
      selected ? 'border-emerald-500/40 ring-1 ring-emerald-500/20' : 'border-white/[0.05] hover:border-white/[0.12]'
    }`}>
      {/* Thumbnail */}
      {winner.thumbnail_url ? (
        <div className="relative aspect-[4/3] bg-black/40 overflow-hidden">
          <img
            src={winner.thumbnail_url}
            alt={winner.ad_name || winner.creative_id}
            className="w-full h-full object-cover opacity-90 group-hover:opacity-100 group-hover:scale-105 transition-all duration-500"
            onError={(e) => { e.currentTarget.style.opacity = '0.2'; }}
          />
          <span className="absolute top-2 left-2 text-[9px] font-mono bg-black/60 text-zinc-200 px-1.5 py-0.5 rounded border border-white/[0.1] backdrop-blur-md">
            {winner.creative_id}
          </span>
          <span className="absolute top-2 right-2 text-[9px] font-mono font-semibold bg-emerald-500/90 text-black px-1.5 py-0.5 rounded">
            {roas.toFixed(1)}x
          </span>
        </div>
      ) : (
        <div className="aspect-[4/3] bg-white/[0.02] flex items-center justify-center text-zinc-600 text-xs">No preview</div>
      )}

      {/* Body */}
      <div className="px-3 pt-2.5 pb-3 space-y-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-flex items-center text-[11px] font-medium px-2 py-0.5 rounded-full bg-white/[0.06] text-zinc-200 border border-white/[0.1] truncate">
            {winner.angle || 'Uncategorized'}
          </span>
          <span className="text-[10px] text-zinc-400 font-mono shrink-0">{formatMoney(spend)}</span>
          {cpa > 0 && <span className="text-[10px] text-zinc-500 font-mono shrink-0">{formatMoney(cpa)} CPA</span>}
        </div>

        {itCount > 0 && (
          <div className="flex items-center gap-1 text-[9px] font-mono text-zinc-500">
            <Clock className="w-2.5 h-2.5" />
            {itCount} iter{itCount !== 1 ? 's' : ''}{itAgo && ` · ${itAgo}`}
          </div>
        )}

        {dismissError && (
          <div className="text-[10px] text-red-400 font-mono">{dismissError}</div>
        )}

        {/* 3-button action row — Select / Iterate (pink) / Hide */}
        <div className="relative flex items-stretch gap-1.5">
          <button
            onClick={handleSelect}
            disabled={dismissing}
            title="Use as reference for full statics generation (pick angle next)"
            className={`flex-1 inline-flex items-center justify-center gap-1 h-9 rounded-lg text-[11px] font-mono font-semibold transition-colors cursor-pointer disabled:opacity-40 ${
              selected
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                : 'bg-white/[0.04] text-zinc-300 hover:bg-white/[0.08] border border-white/[0.06]'
            }`}
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            {selected ? 'Selected' : 'Select'}
          </button>

          <button
            ref={iterateBtnRef}
            onClick={() => setPopoverOpen((v) => !v)}
            disabled={dismissing}
            title="Generate AI iterations of this ad"
            className={`px-3 h-9 rounded-lg inline-flex items-center justify-center transition-colors cursor-pointer disabled:opacity-40 ${
              popoverOpen
                ? 'bg-fuchsia-500 text-white'
                : 'bg-fuchsia-500/15 text-fuchsia-300 hover:bg-fuchsia-500/25 border border-fuchsia-500/30'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={handleHide}
            disabled={dismissing}
            title="Hide this card from the Iterations queue"
            className="px-3 h-9 rounded-lg inline-flex items-center justify-center text-red-400 hover:bg-red-500/10 border border-red-500/30 transition-colors cursor-pointer disabled:opacity-40"
          >
            {dismissing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
          </button>

          {popoverOpen && (
            <IteratePopover
              winner={winner}
              productId={productId}
              anchorRef={iterateBtnRef}
              onClose={() => setPopoverOpen(false)}
              onSubmitted={onSubmitted}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main column
// ---------------------------------------------------------------------------
export function IterationsColumn({ productId, onSubmitted, onUseAsReference }) {
  const [winners, setWinners] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showFilters, setShowFilters] = useState(false);
  const [minSpend, setMinSpend] = useState(DEFAULT_MIN_SPEND);
  const [minRoas, setMinRoas] = useState(DEFAULT_MIN_ROAS);
  const [windowDays, setWindowDays] = useState(DEFAULT_WINDOW_DAYS);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/statics-generation/iterations', {
        params: { minSpend, minRoas, windowDays },
      });
      const data = res.data?.data || res.data;
      setWinners(data.winners || []);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
    setLoading(false);
  }, [minSpend, minRoas, windowDays]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 10 * 60 * 1000);
    return () => clearInterval(interval);
  }, [load]);

  const handleSubmitted = (batchData) => {
    load();
    onSubmitted?.(batchData);
  };

  // Optimistic remove on hide — no need to wait for /iterations re-fetch.
  const handleDismissed = (creativeId) => {
    setWinners((cur) => cur.filter((w) => w.creative_id !== creativeId));
  };

  const applyPreset = (spend, roas, days) => {
    setMinSpend(spend); setMinRoas(roas); setWindowDays(days);
  };

  return (
    <div className="flex flex-col min-w-[240px] max-w-[340px] flex-1 relative h-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-3 px-1">
        <div className="flex items-center gap-2">
          <Repeat className="w-4 h-4 text-[#d4b55a] drop-shadow-[0_0_6px_rgba(201,168,76,0.5)]" />
          <span className="text-xs font-mono font-semibold text-white uppercase tracking-[0.15em]">
            Iterations
          </span>
          <span className="px-1.5 py-0.5 text-[10px] font-mono font-bold bg-[#c9a84c]/10 text-[#d4b55a] border border-[#c9a84c]/25 rounded">
            {winners.length}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setShowFilters((v) => !v)}
            className={`transition-colors cursor-pointer ${showFilters ? 'text-[#d4b55a]' : 'text-zinc-500 hover:text-zinc-200'}`}
            title="Filters"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={load}
            disabled={loading}
            className="text-zinc-500 hover:text-zinc-200 disabled:opacity-40 cursor-pointer"
            title="Refresh"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Filters panel */}
      {showFilters && (
        <div className="mb-3 p-3 glass-card border border-white/[0.06] rounded-lg space-y-3">
          <div>
            <div className="flex justify-between text-[10px] font-mono text-zinc-400 uppercase tracking-wider mb-1.5">
              <span>Min Spend</span><span className="text-zinc-200">${minSpend}</span>
            </div>
            <input
              type="range" min="0" max="500" step="10" value={minSpend}
              onChange={(e) => setMinSpend(Number(e.target.value))}
              className="w-full accent-[#d4b55a]"
            />
          </div>
          <div>
            <div className="flex justify-between text-[10px] font-mono text-zinc-400 uppercase tracking-wider mb-1.5">
              <span>Min ROAS</span><span className="text-zinc-200">{minRoas.toFixed(1)}x</span>
            </div>
            <input
              type="range" min="0" max="5" step="0.1" value={minRoas}
              onChange={(e) => setMinRoas(Number(e.target.value))}
              className="w-full accent-[#d4b55a]"
            />
          </div>
          <div>
            <div className="flex justify-between text-[10px] font-mono text-zinc-400 uppercase tracking-wider mb-1.5">
              <span>Window</span><span className="text-zinc-200">{windowDays}d</span>
            </div>
            <input
              type="range" min="7" max="90" step="1" value={windowDays}
              onChange={(e) => setWindowDays(Number(e.target.value))}
              className="w-full accent-[#d4b55a]"
            />
          </div>
          <div className="flex gap-1 pt-1">
            <button
              onClick={() => applyPreset(50, 1.5, 30)}
              className="flex-1 px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-zinc-300 border border-white/[0.08] rounded hover:border-white/[0.2] cursor-pointer"
            >All</button>
            <button
              onClick={() => applyPreset(100, 2.0, 30)}
              className="flex-1 px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-zinc-300 border border-white/[0.08] rounded hover:border-white/[0.2] cursor-pointer"
            >Promising</button>
            <button
              onClick={() => applyPreset(200, 2.0, 30)}
              className="flex-1 px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-[#d4b55a] border border-[#c9a84c]/30 bg-[#c9a84c]/10 rounded hover:border-[#c9a84c]/50 cursor-pointer"
            >Winners</button>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto space-y-3 pr-1">
        {error && (
          <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-300">
            {String(error?.message || error)}
          </div>
        )}

        {!loading && !error && winners.length === 0 && (
          <div className="px-3 py-6 text-xs text-zinc-500 text-center leading-relaxed">
            No ads match the current filters.
            <br /><br />
            Try clicking <span className="text-[#d4b55a]">All</span> in the filters panel to widen the range.
          </div>
        )}

        {winners.map((w) => (
          <WinnerCard
            key={w.creative_id}
            winner={w}
            productId={productId}
            onUseAsReference={onUseAsReference}
            onSubmitted={handleSubmitted}
            onDismissed={handleDismissed}
          />
        ))}
      </div>
    </div>
  );
}

export default IterationsColumn;
