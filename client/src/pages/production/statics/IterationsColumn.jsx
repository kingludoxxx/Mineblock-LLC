import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Repeat, Loader2, RefreshCw, TrendingUp, DollarSign, Target, Clock, X, Sparkles, SlidersHorizontal,
} from 'lucide-react';
import api from '../../../services/api';

// Default thresholds are permissive — show anything with meaningful spend + positive ROAS.
// User can tighten via the filters panel. Strict "winners" would be $200+ / 2x+.
const DEFAULT_MIN_SPEND = 50;
const DEFAULT_MIN_ROAS = 1.5;
const DEFAULT_WINDOW_DAYS = 30;

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
// Iterate confirmation modal
// ---------------------------------------------------------------------------
function IterateModal({ winner, productId, onClose, onSubmitted }) {
  const [variations, setVariations] = useState(3);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.post(
        `/statics-generation/iterate/${winner.creative_id}`,
        { variations, productId: productId || undefined }
      );
      const data = res.data?.data || res.data;
      onSubmitted?.(data);
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="glass-card border border-white/10 rounded-xl w-full max-w-md p-6 mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-[#d4b55a]" />
            <h3 className="text-sm font-mono font-semibold text-white uppercase tracking-wider">
              Iterate {winner.creative_id}
            </h3>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-white"><X className="w-4 h-4" /></button>
        </div>

        {/* Parent preview */}
        <div className="flex gap-3 mb-5 p-3 bg-white/[0.02] border border-white/[0.05] rounded-lg">
          {winner.thumbnail_url ? (
            <img src={winner.thumbnail_url} alt="" className="w-14 h-14 rounded object-cover flex-shrink-0" />
          ) : (
            <div className="w-14 h-14 bg-white/5 rounded" />
          )}
          <div className="flex-1 min-w-0">
            <div className="text-xs font-mono text-zinc-300 truncate">{winner.ad_name || winner.creative_id}</div>
            <div className="flex gap-3 mt-1 text-xs">
              <span className="text-emerald-400">{Number(winner.roas).toFixed(1)}x</span>
              <span className="text-zinc-400">{formatMoney(winner.spend)}</span>
              {winner.angle && <span className="text-zinc-500 truncate">{winner.angle}</span>}
            </div>
          </div>
        </div>

        {/* Variations slider */}
        <label className="block mb-5">
          <div className="flex justify-between mb-2">
            <span className="text-xs font-mono text-zinc-400 uppercase tracking-wider">Variations</span>
            <span className="text-xs font-mono text-white">{variations}</span>
          </div>
          <input
            type="range" min="1" max="5" value={variations}
            onChange={(e) => setVariations(Number(e.target.value))}
            className="w-full accent-[#d4b55a]"
            disabled={submitting}
          />
          <div className="flex justify-between mt-1 text-[10px] text-zinc-600 font-mono">
            <span>1</span><span>3 (default)</span><span>5</span>
          </div>
        </label>

        <p className="text-xs text-zinc-400 mb-5 leading-relaxed">
          Iterations land in <strong className="text-zinc-300">To Review</strong>. Each tests a different surgical change while preserving the working hook and product.
        </p>

        {error && (
          <div className="mb-4 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-300">
            {error}
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={onClose}
            disabled={submitting}
            className="flex-1 px-3 py-2 text-xs font-mono uppercase tracking-wider text-zinc-400 border border-white/[0.06] rounded-md hover:border-white/[0.12] hover:text-zinc-200 disabled:opacity-40 cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting}
            className="flex-1 px-3 py-2 text-xs font-mono uppercase tracking-wider text-black bg-[#d4b55a] rounded-md hover:bg-[#e4c56a] disabled:opacity-40 flex items-center justify-center gap-1.5 cursor-pointer"
          >
            {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            {submitting ? 'Starting...' : `Iterate ${variations}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Individual winner card
// ---------------------------------------------------------------------------
function WinnerCard({ winner, productId, onIterate }) {
  const roas = Number(winner.roas) || 0;
  const spend = Number(winner.spend) || 0;
  const cpa = Number(winner.cpa) || 0;
  const itCount = Number(winner.iteration_count) || 0;
  const itAgo = timeAgo(winner.iterated_at);

  return (
    <div className="group relative glass-card border border-white/[0.05] hover:border-white/[0.12] rounded-xl overflow-hidden transition-all shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)]">
      {/* Thumbnail — aspect-[4/3] matches pipeline cards */}
      {winner.thumbnail_url ? (
        <div className="relative aspect-[4/3] bg-black/40 overflow-hidden">
          <img
            src={winner.thumbnail_url}
            alt={winner.ad_name || winner.creative_id}
            className="w-full h-full object-cover opacity-90 group-hover:opacity-100 group-hover:scale-105 transition-all duration-500"
            onError={(e) => { e.currentTarget.style.opacity = '0.2'; }}
          />
          {/* Creative ID badge */}
          <span className="absolute top-2 left-2 text-[9px] font-mono bg-black/60 text-zinc-200 px-1.5 py-0.5 rounded border border-white/[0.1] backdrop-blur-md">
            {winner.creative_id}
          </span>
          {/* ROAS badge */}
          <span className="absolute top-2 right-2 text-[9px] font-mono font-semibold bg-emerald-500/90 text-black px-1.5 py-0.5 rounded">
            {roas.toFixed(1)}x
          </span>
        </div>
      ) : (
        <div className="aspect-[4/3] bg-white/[0.02] flex items-center justify-center text-zinc-600 text-xs">No preview</div>
      )}

      {/* Body — compact, matches pipeline card padding */}
      <div className="px-3 pt-2.5 pb-3 space-y-2">
        {/* Angle pill + metrics — single row, matches pipeline layout */}
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-flex items-center text-[11px] font-medium px-2 py-0.5 rounded-full bg-white/[0.06] text-zinc-200 border border-white/[0.1] truncate">
            {winner.angle || 'Uncategorized'}
          </span>
          <span className="text-[10px] text-zinc-400 font-mono shrink-0">{formatMoney(spend)}</span>
          {cpa > 0 && <span className="text-[10px] text-zinc-500 font-mono shrink-0">{formatMoney(cpa)} CPA</span>}
        </div>

        {/* Iteration history (small, only when iterated before) */}
        {itCount > 0 && (
          <div className="flex items-center gap-1 text-[9px] font-mono text-zinc-500">
            <Clock className="w-2.5 h-2.5" />
            {itCount} iter{itCount !== 1 ? 's' : ''}{itAgo && ` · ${itAgo}`}
          </div>
        )}

        {/* Iterate button — matches "Approve" style: subtle border/bg + gold text */}
        <button
          onClick={() => onIterate(winner)}
          className="w-full inline-flex items-center justify-center gap-1.5 h-9 rounded-lg text-[12px] font-semibold border border-[#c9a84c]/30 bg-[#c9a84c]/[0.08] text-[#d4b55a] hover:bg-[#c9a84c]/15 transition-colors cursor-pointer"
        >
          <Sparkles className="w-3.5 h-3.5 shrink-0" />
          Iterate
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main column
// ---------------------------------------------------------------------------
export function IterationsColumn({ productId, onSubmitted }) {
  const [winners, setWinners] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
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
    const interval = setInterval(load, 10 * 60 * 1000); // auto-refresh every 10 min
    return () => clearInterval(interval);
  }, [load]);

  const handleSubmitted = (batchData) => {
    load();
    onSubmitted?.(batchData);
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
            {error}
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
            onIterate={setSelected}
          />
        ))}
      </div>

      {/* Modal */}
      {selected && (
        <IterateModal
          winner={selected}
          productId={productId}
          onClose={() => setSelected(null)}
          onSubmitted={handleSubmitted}
        />
      )}
    </div>
  );
}

export default IterationsColumn;
