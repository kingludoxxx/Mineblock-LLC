import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Repeat, Loader2, RefreshCw, TrendingUp, DollarSign, Target, Clock, X, Sparkles,
} from 'lucide-react';
import api from '../../../services/api';

// Time window (days) and thresholds — match backend defaults
const DEFAULT_MIN_SPEND = 200;
const DEFAULT_MIN_ROAS = 2.0;
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
    <div className="group relative glass-card border border-white/[0.05] hover:border-white/[0.12] rounded-lg overflow-hidden transition-all">
      {/* Thumbnail */}
      {winner.thumbnail_url ? (
        <div className="relative aspect-[4/5] bg-black/40 overflow-hidden">
          <img
            src={winner.thumbnail_url}
            alt={winner.ad_name || winner.creative_id}
            className="w-full h-full object-cover"
            onError={(e) => { e.currentTarget.style.opacity = '0.2'; }}
          />
          {/* Top-right metrics overlay */}
          <div className="absolute top-2 right-2 flex flex-col gap-1 items-end">
            <span className="px-1.5 py-0.5 text-[10px] font-mono font-bold bg-emerald-500/90 text-black rounded">
              {roas.toFixed(1)}x
            </span>
          </div>
          {/* Creative ID tag */}
          <div className="absolute top-2 left-2">
            <span className="px-1.5 py-0.5 text-[10px] font-mono font-semibold bg-black/70 text-white rounded">
              {winner.creative_id}
            </span>
          </div>
        </div>
      ) : (
        <div className="aspect-[4/5] bg-white/[0.02] flex items-center justify-center text-zinc-600 text-xs">
          No preview
        </div>
      )}

      {/* Body */}
      <div className="p-3">
        {/* Ad name */}
        <div className="text-[11px] font-mono text-zinc-300 truncate mb-1.5" title={winner.ad_name}>
          {winner.ad_name || winner.creative_id}
        </div>

        {/* Metric row */}
        <div className="flex gap-2 text-[10px] font-mono mb-2">
          <span className="flex items-center gap-0.5 text-zinc-400">
            <DollarSign className="w-2.5 h-2.5" />{formatMoney(spend)}
          </span>
          {cpa > 0 && (
            <span className="flex items-center gap-0.5 text-zinc-400">
              <Target className="w-2.5 h-2.5" />{formatMoney(cpa)}
            </span>
          )}
          {winner.angle && (
            <span className="text-zinc-500 truncate">{winner.angle}</span>
          )}
        </div>

        {/* Iteration history indicator */}
        {itCount > 0 && (
          <div className="flex items-center gap-1 mb-2 text-[9px] font-mono text-zinc-500">
            <Clock className="w-2.5 h-2.5" />
            {itCount} iter{itCount !== 1 ? 's' : ''}
            {itAgo && ` · ${itAgo}`}
          </div>
        )}

        {/* Iterate button */}
        <button
          onClick={() => onIterate(winner)}
          className="w-full flex items-center justify-center gap-1 px-2 py-1.5 text-[11px] font-mono font-medium uppercase tracking-wider text-black bg-[#d4b55a] hover:bg-[#e4c56a] rounded-md transition-colors cursor-pointer"
        >
          <Sparkles className="w-3 h-3" />
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

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/statics-generation/iterations', {
        params: { minSpend: DEFAULT_MIN_SPEND, minRoas: DEFAULT_MIN_ROAS, windowDays: DEFAULT_WINDOW_DAYS },
      });
      const data = res.data?.data || res.data;
      setWinners(data.winners || []);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 10 * 60 * 1000); // auto-refresh every 10 min
    return () => clearInterval(interval);
  }, [load]);

  const handleSubmitted = (batchData) => {
    // Re-fetch winners (to show updated iteration_count + iterated_at)
    load();
    onSubmitted?.(batchData);
  };

  return (
    <div className="flex flex-col flex-shrink-0 w-[280px] h-full">
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
        <button
          onClick={load}
          disabled={loading}
          className="text-zinc-500 hover:text-zinc-200 disabled:opacity-40 cursor-pointer"
          title="Refresh"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto space-y-3 pr-1">
        {error && (
          <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-300">
            {error}
          </div>
        )}

        {!loading && !error && winners.length === 0 && (
          <div className="px-3 py-6 text-xs text-zinc-500 text-center leading-relaxed">
            No winning ads in the last {DEFAULT_WINDOW_DAYS} days with
            <br />${DEFAULT_MIN_SPEND}+ spend and {DEFAULT_MIN_ROAS}x+ ROAS.
            <br /><br />
            Check Creative Analysis or wait for more data.
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
