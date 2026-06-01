import React, { useEffect, useState, useCallback } from 'react';
import {
  Upload, Globe, TrendingUp, Loader2, RefreshCw, Trash2, ExternalLink, X, Sparkles, Check, CheckCircle2, Layers,
} from 'lucide-react';
import api from '../../../services/api';
import LeagueImportModal from './LeagueImportModal';
import MetaImportModal from './MetaImportModal';

const SOURCE_BADGES = {
  league: { label: 'LEAGUE', cls: 'bg-[#c9a84c]/80 text-black' },
  meta:   { label: 'TW',     cls: 'bg-cyan-500/80 text-black' },
  upload: { label: 'UPLOAD', cls: 'bg-zinc-500/80 text-black' },
};

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

function ReferencePreviewModal({ item, onClose, onUse, isSelected, onToggleSelect, productAngles = [], onQueueRefWithAngles }) {
  // Close on ESC + autofocus the close button so tab-order starts on the modal,
  // not the page underneath. Cleanup on unmount.
  const [mode, setMode] = useState('view'); // 'view' | 'angles'
  const [pickedAngles, setPickedAngles] = useState(() => new Set());
  const [queueing, setQueueing] = useState(false);
  useEffect(() => {
    if (!item) return undefined;
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [item, onClose]);
  // Reset angle-picker state when the modal opens with a new item.
  useEffect(() => {
    if (item) { setMode('view'); setPickedAngles(new Set()); setQueueing(false); }
  }, [item?.id]);
  if (!item) return null;
  const hasAngles = Array.isArray(productAngles) && productAngles.length > 0;
  const toggleAngle = (angleObj) => {
    const key = (angleObj?.name || '').trim().toLowerCase();
    if (!key) return;
    setPickedAngles(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const selectAllAngles = () => {
    const all = new Set();
    productAngles.forEach(a => {
      const k = (a?.name || '').trim().toLowerCase();
      if (k) all.add(k);
    });
    setPickedAngles(all);
  };
  const clearAngles = () => setPickedAngles(new Set());
  const handleQueueAngles = async () => {
    if (pickedAngles.size === 0 || queueing) return;
    const picked = productAngles.filter(a => pickedAngles.has((a?.name || '').trim().toLowerCase()));
    if (picked.length === 0) return;
    setQueueing(true);
    try {
      await onQueueRefWithAngles?.(item, picked);
      onClose();
    } finally {
      setQueueing(false);
    }
  };
  const fullImg = item.image_url || item.thumbnail_url || item.reference_thumbnail;
  const src = SOURCE_BADGES[item.imported_from] || SOURCE_BADGES.upload;
  const meta = item.imported_metadata || {};
  const title = item.reference_name || item.source_label || 'Reference';
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-6"
      onClick={onClose}
    >
      <div
        className="glass-card border border-white/10 rounded-xl max-w-3xl w-full max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06] shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${src.cls}`}>{src.label}</span>
            <h3 className="text-sm font-mono text-white truncate" title={title}>{title}</h3>
            {meta.tier && (
              <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-emerald-500/90 text-black">{meta.tier}</span>
            )}
            {meta.roas != null && (
              <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-emerald-500/90 text-black">
                {Number(meta.roas).toFixed(2)}x ROAS
              </span>
            )}
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-white p-1 cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>
        {/* Body — split: image (left) + angle picker (right) when in 'angles' mode */}
        <div className={`flex-1 overflow-hidden flex ${mode === 'angles' ? 'flex-row' : ''} min-h-[200px]`}>
          {/* Image */}
          <div className={`overflow-auto p-4 flex items-center justify-center bg-black/40 ${mode === 'angles' ? 'w-1/2 border-r border-white/[0.06]' : 'flex-1'}`}>
            {fullImg ? (
              <img
                src={fullImg}
                alt={title}
                loading="lazy"
                decoding="async"
                className="max-w-full max-h-[60vh] object-contain rounded shadow-lg"
                onError={(e) => { e.currentTarget.alt = 'Preview failed to load'; e.currentTarget.style.opacity = '0.3'; }}
              />
            ) : (
              <div className="text-zinc-500 text-sm">No preview available</div>
            )}
          </div>

          {/* Angle picker — visible only in 'angles' mode */}
          {mode === 'angles' && (
            <div className="w-1/2 flex flex-col overflow-hidden">
              <div className="px-5 py-3 border-b border-white/[0.06] flex items-center justify-between shrink-0">
                <div className="flex items-center gap-2 min-w-0">
                  <Layers className="w-4 h-4 text-violet-300" />
                  <span className="text-xs font-mono font-semibold uppercase tracking-wider text-white">
                    Queue Angles
                  </span>
                  <span className="text-[10px] font-mono text-zinc-500">
                    {pickedAngles.size}/{productAngles.length} picked
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={selectAllAngles}
                    disabled={!hasAngles || queueing}
                    className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 hover:text-white disabled:opacity-30 cursor-pointer"
                  >All</button>
                  <button
                    type="button"
                    onClick={clearAngles}
                    disabled={pickedAngles.size === 0 || queueing}
                    className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 hover:text-white disabled:opacity-30 cursor-pointer"
                  >Clear</button>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
                {!hasAngles ? (
                  <div className="px-2 py-6 text-xs text-zinc-500 text-center leading-relaxed">
                    No angles available for this product. Add angles in the product library, then come back here.
                  </div>
                ) : (
                  productAngles.map((angleObj, idx) => {
                    const name = angleObj?.name || `Angle ${idx + 1}`;
                    const key = name.trim().toLowerCase();
                    const checked = pickedAngles.has(key);
                    return (
                      <button
                        type="button"
                        key={`${key}-${idx}`}
                        onClick={() => toggleAngle(angleObj)}
                        disabled={queueing}
                        className={`w-full flex items-start gap-2.5 px-3 py-2.5 rounded-lg border text-left transition-all cursor-pointer ${
                          checked
                            ? 'bg-violet-500/15 border-violet-400/50 text-white'
                            : 'bg-white/[0.02] border-white/[0.06] text-zinc-300 hover:bg-white/[0.05] hover:border-white/[0.12]'
                        } disabled:opacity-50 disabled:cursor-not-allowed`}
                      >
                        <div className={`mt-0.5 w-4 h-4 rounded border shrink-0 flex items-center justify-center ${
                          checked ? 'bg-violet-500 border-violet-400' : 'border-white/20 bg-white/[0.04]'
                        }`}>
                          {checked && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-[12px] font-mono font-semibold truncate">{name}</div>
                          {angleObj?.description && (
                            <div className="text-[10px] text-zinc-500 line-clamp-2 mt-0.5">
                              {angleObj.description}
                            </div>
                          )}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-white/[0.06] shrink-0">
          <div className="text-[10px] font-mono text-zinc-500 truncate flex-1">
            {meta.headline && <span className="mr-3"><span className="text-zinc-300">{meta.headline.slice(0, 80)}</span></span>}
            {timeAgo(item.created_at) && <span>imported {timeAgo(item.created_at)}</span>}
          </div>
          <div className="flex gap-2 shrink-0">
            {mode === 'view' ? (
              <>
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-xs font-mono uppercase tracking-wider text-zinc-300 border border-white/[0.08] rounded hover:border-white/[0.2] cursor-pointer"
                >Cancel</button>
                {/* QUEUE ANGLES — multi-pick angles for this reference */}
                {typeof onQueueRefWithAngles === 'function' && (
                  <button
                    onClick={() => setMode('angles')}
                    className="px-4 py-2 text-xs font-mono uppercase tracking-wider rounded cursor-pointer font-bold bg-violet-500/80 text-white hover:bg-violet-500 inline-flex items-center gap-1.5"
                    title={hasAngles ? 'Pick multiple angles and queue one generation per angle' : 'No angles available for this product yet'}
                  >
                    <Layers className="w-3.5 h-3.5" />
                    Queue Angles
                  </button>
                )}
                {/* SELECT — toggle multi-select for batch generation */}
                <button
                  onClick={() => { onToggleSelect?.(item); onClose(); }}
                  className={`px-4 py-2 text-xs font-mono uppercase tracking-wider rounded cursor-pointer font-bold transition-colors ${
                    isSelected
                      ? 'bg-emerald-500 text-black hover:bg-emerald-400'
                      : 'bg-emerald-500/80 text-black hover:bg-emerald-500'
                  }`}
                >{isSelected ? '✓ Selected' : 'Select'}</button>
                <button
                  onClick={onUse}
                  className="px-4 py-2 text-xs font-mono uppercase tracking-wider text-black bg-[#d4b55a] hover:bg-[#e4c56a] rounded cursor-pointer font-bold"
                >Use as Reference</button>
              </>
            ) : (
              <>
                <button
                  onClick={() => setMode('view')}
                  disabled={queueing}
                  className="px-4 py-2 text-xs font-mono uppercase tracking-wider text-zinc-300 border border-white/[0.08] rounded hover:border-white/[0.2] cursor-pointer disabled:opacity-40"
                >Back</button>
                <button
                  onClick={handleQueueAngles}
                  disabled={pickedAngles.size === 0 || queueing || !hasAngles}
                  className="px-4 py-2 text-xs font-mono uppercase tracking-wider rounded cursor-pointer font-bold bg-violet-500 text-white hover:bg-violet-400 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
                >
                  {queueing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                  Queue {pickedAngles.size || ''} Angle{pickedAngles.size !== 1 ? 's' : ''}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ReferenceCard({ item, onPreview, onDelete, isSelected, onToggleSelect, onAddToQueue }) {
  const src = SOURCE_BADGES[item.imported_from] || SOURCE_BADGES.upload;
  const meta = item.imported_metadata || {};
  const rightBadge = item.imported_from === 'league' && meta.tier
    ? { text: meta.tier, cls: 'bg-emerald-500/90 text-black' }
    : item.imported_from === 'meta' && meta.roas
      ? { text: `${Number(meta.roas).toFixed(1)}x`, cls: 'bg-emerald-500/90 text-black' }
      : null;
  const title = item.reference_name || item.source_label || '—';
  const thumb = item.thumbnail_url || item.image_url || item.reference_thumbnail;
  return (
    <div
      className={`group relative glass-card border rounded-xl overflow-hidden transition-all cursor-pointer ${
        isSelected ? 'border-emerald-400 ring-2 ring-emerald-400/40' : 'border-white/[0.05] hover:border-white/[0.12]'
      }`}
      onClick={() => onPreview(item)}
    >
      {thumb ? (
        <div className="relative aspect-[4/3] bg-black/40 overflow-hidden">
          <img
            src={thumb}
            alt={title}
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover opacity-90 group-hover:opacity-100 group-hover:scale-105 transition-all duration-500"
            onError={(e) => { e.currentTarget.style.opacity = '0.2'; }}
          />
          <span className={`absolute top-2 left-2 text-[9px] font-mono font-bold px-1.5 py-0.5 rounded ${src.cls}`}>
            {src.label}
          </span>
          {rightBadge && (
            <span className={`absolute top-2 right-2 text-[9px] font-mono font-bold px-1.5 py-0.5 rounded ${rightBadge.cls}`}>
              {rightBadge.text}
            </span>
          )}
        </div>
      ) : (
        <div className="aspect-[4/3] bg-white/[0.02] flex items-center justify-center text-zinc-600 text-xs">No preview</div>
      )}
      <div className="px-3 pt-2.5 pb-3 space-y-2.5">
        {/* Title + timestamp */}
        <div className="space-y-0.5">
          <div className="text-[11px] font-mono text-zinc-100 truncate" title={title}>{title}</div>
          <div className="text-[10px] text-zinc-500 font-mono">{timeAgo(item.created_at)}</div>
        </div>
        {/* Action row — bottom of the card, BELOW everything else.
            - NOT selected: full-width Select button + small trash icon.
            - SELECTED:    mint "Selected" button + sparkle (Add to Queue) + red X (delete). */}
        {isSelected ? (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onToggleSelect(item); }}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-500/15 border border-emerald-400/40 text-emerald-300 text-[11px] font-mono font-semibold uppercase tracking-wide hover:bg-emerald-500/20 transition-all cursor-pointer"
              title="Click to deselect"
            >
              <CheckCircle2 className="w-3.5 h-3.5" strokeWidth={2} />
              <span>Selected</span>
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onAddToQueue?.(item); }}
              className="shrink-0 p-2 rounded-lg bg-white/[0.04] border border-white/[0.08] hover:bg-violet-500/20 hover:border-violet-400/40 text-violet-300 hover:text-violet-200 transition-all cursor-pointer"
              title="Add to queue"
            >
              <Sparkles className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDelete(item); }}
              className="shrink-0 p-2 rounded-lg bg-white/[0.04] border border-white/[0.08] hover:bg-red-500/20 hover:border-red-400/40 text-red-300 hover:text-red-200 transition-all cursor-pointer"
              title="Remove from library"
            >
              <X className="w-3.5 h-3.5" strokeWidth={2.5} />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onToggleSelect(item); }}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] hover:bg-emerald-500/15 hover:border-emerald-400/40 text-zinc-300 hover:text-emerald-200 text-[11px] font-mono font-semibold uppercase tracking-wide transition-all cursor-pointer"
              title="Select to add to queue"
            >
              Select
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDelete(item); }}
              className="shrink-0 p-2 rounded-lg bg-white/[0.04] border border-white/[0.08] hover:bg-red-500/20 hover:border-red-400/40 text-zinc-500 hover:text-red-300 transition-all cursor-pointer"
              title="Remove from library"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function ReferenceColumn({ productId, onSelectReference, onAddSelectedToQueue, productAngles = [], onQueueRefWithAngles, onLeagueImported }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showLeague, setShowLeague] = useState(false);
  const [showMeta, setShowMeta] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [previewItem, setPreviewItem] = useState(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const fileInputRef = React.useRef(null);

  const toggleSelect = (item) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      const isAdding = !next.has(item.id);
      if (isAdding) next.add(item.id); else next.delete(item.id);
      // Also wire single-pick mode: when adding, mark this item as the active
      // single reference so Generate Static / Add to Queue enable. When
      // removing (and no other items remain selected), clear the active ref.
      if (isAdding) {
        onSelectReference?.(item);
      } else if (next.size === 0) {
        onSelectReference?.(null);
      }
      return next;
    });
  };
  const clearSelection = () => setSelectedIds(new Set());
  const handleAddSelected = () => {
    const picked = items.filter(it => selectedIds.has(it.id));
    if (picked.length === 0) return;
    onAddSelectedToQueue?.(picked);
    clearSelection();
  };

  const handleFilePicked = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset so same file can be re-picked
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Please pick an image file (PNG, JPG, WebP).');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setError('Image must be under 8 MB.');
      return;
    }
    setUploading(true); setError(null);
    try {
      const dataUri = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      await api.post('/statics-generation/reference-ads/upload', {
        image_data_uri: dataUri,
        label: file.name.replace(/\.[^.]+$/, '').slice(0, 80) || 'Upload',
      });
      await load();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/statics-generation/reference-ads', {
        params: productId ? { product_id: productId } : {},
      });
      setItems(res.data?.data || []);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message);
    }
    setLoading(false);
  }, [productId]);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (item) => {
    // Optimistic: drop from UI immediately, then fire DELETE.
    // On error we re-fetch the full list so state stays accurate.
    setItems(prev => prev.filter(i => i.id !== item.id));
    try {
      await api.delete(`/statics-generation/reference-ads/${item.id}`);
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Delete failed');
      load(); // restore from server
    }
  };

  // Card click → open preview modal (was: immediately select).
  // Modal's "Use as Reference" button is what actually triggers selection.
  const handleSelect = (item) => {
    setPreviewItem(item);
  };
  const handleUseReference = () => {
    if (!previewItem) return;
    onSelectReference?.(previewItem);
    setPreviewItem(null);
  };

  return (
    <div className="flex flex-col min-w-[240px] max-w-[340px] flex-1 relative h-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-3 px-1">
        <div className="flex items-center gap-2">
          <Globe className="w-4 h-4 text-[#d4b55a] drop-shadow-[0_0_6px_rgba(201,168,76,0.5)]" />
          <span className="text-xs font-mono font-semibold text-white uppercase tracking-[0.15em]">
            Reference
          </span>
          <span className="px-1.5 py-0.5 text-[10px] font-mono font-bold bg-[#c9a84c]/10 text-[#d4b55a] border border-[#c9a84c]/25 rounded">
            {items.length}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <a
            href="/app/brand-spy"
            className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 hover:text-[#d4b55a] inline-flex items-center gap-1"
            title="Manage followed brands"
          >
            Follow <ExternalLink className="w-2.5 h-2.5" />
          </a>
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

      {/* Source buttons row */}
      <div className="grid grid-cols-3 gap-2 mb-3 px-1">
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="inline-flex flex-col items-center justify-center gap-1 h-14 rounded-lg border border-white/[0.08] bg-white/[0.02] hover:border-white/[0.15] text-zinc-300 hover:text-white transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          title="Upload an image from disk"
        >
          {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          <span className="text-[9px] font-mono uppercase tracking-wider">{uploading ? 'Uploading' : 'Upload'}</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={handleFilePicked}
          className="hidden"
        />
        <button
          onClick={() => setShowLeague(true)}
          className="inline-flex flex-col items-center justify-center gap-1 h-14 rounded-lg border border-[#c9a84c]/30 bg-[#c9a84c]/[0.08] hover:bg-[#c9a84c]/15 text-[#d4b55a] transition-colors cursor-pointer"
          title="Import from League"
        >
          <Globe className="w-4 h-4" />
          <span className="text-[9px] font-mono uppercase tracking-wider">League</span>
        </button>
        <button
          onClick={() => setShowMeta(true)}
          className="inline-flex flex-col items-center justify-center gap-1 h-14 rounded-lg border border-cyan-500/30 bg-cyan-500/[0.08] hover:bg-cyan-500/15 text-cyan-300 transition-colors cursor-pointer"
          title="Import from Meta (Triple Whale)"
        >
          <TrendingUp className="w-4 h-4" />
          <span className="text-[9px] font-mono uppercase tracking-wider">Meta</span>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto space-y-3 pr-1">
        {error && (
          <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-300">
            {error}
          </div>
        )}
        {!loading && !error && items.length === 0 && (
          <div className="px-3 py-6 text-xs text-zinc-500 text-center leading-relaxed">
            No reference ads yet.
          </div>
        )}
        {items.map((it) => (
          <ReferenceCard
            key={it.id}
            item={it}
            onPreview={handleSelect}
            onDelete={handleDelete}
            isSelected={selectedIds.has(it.id)}
            onToggleSelect={toggleSelect}
            onAddToQueue={(item) => onAddSelectedToQueue?.([item])}
          />
        ))}
      </div>

      {showLeague && (
        <LeagueImportModal
          onClose={() => setShowLeague(false)}
          onImported={() => {
            setShowLeague(false);
            load();
            // League imports land in the FROM LEAGUE column, NOT the
            // Reference column (which excludes imported_from='league').
            // Without this bridge, the operator clicks Import, sees zero
            // change in Reference, and assumes the import failed silently.
            onLeagueImported?.();
          }}
        />
      )}
      {showMeta && (
        <MetaImportModal
          onClose={() => setShowMeta(false)}
          onImported={() => { setShowMeta(false); load(); }}
        />
      )}
      <ReferencePreviewModal
        item={previewItem}
        onClose={() => setPreviewItem(null)}
        onUse={handleUseReference}
        isSelected={previewItem ? selectedIds.has(previewItem.id) : false}
        onToggleSelect={toggleSelect}
        productAngles={productAngles}
        onQueueRefWithAngles={onQueueRefWithAngles}
      />
    </div>
  );
}

export default ReferenceColumn;
