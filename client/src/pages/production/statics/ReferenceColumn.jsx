import React, { useEffect, useState, useCallback } from 'react';
import {
  Upload, Globe, TrendingUp, Loader2, RefreshCw, Trash2, ExternalLink,
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

function ReferenceCard({ item, onSelect, onDelete }) {
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
      className="group relative glass-card border border-white/[0.05] hover:border-white/[0.12] rounded-xl overflow-hidden transition-all cursor-pointer"
      onClick={() => onSelect(item)}
    >
      {thumb ? (
        <div className="relative aspect-[4/3] bg-black/40 overflow-hidden">
          <img
            src={thumb}
            alt={title}
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
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(item); }}
            className="absolute bottom-2 right-2 p-1.5 bg-red-500/80 hover:bg-red-500 text-white rounded opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
            title="Remove from reference"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      ) : (
        <div className="aspect-[4/3] bg-white/[0.02] flex items-center justify-center text-zinc-600 text-xs">No preview</div>
      )}
      <div className="px-3 pt-2 pb-2.5 space-y-1">
        <div className="text-[11px] font-mono text-zinc-200 truncate" title={title}>{title}</div>
        <div className="text-[9px] text-zinc-500 font-mono">{timeAgo(item.created_at)}</div>
      </div>
    </div>
  );
}

export function ReferenceColumn({ productId, onSelectReference }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showLeague, setShowLeague] = useState(false);
  const [showMeta, setShowMeta] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = React.useRef(null);

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
    if (!window.confirm(`Remove "${item.reference_name || item.source_label || 'this reference'}" from Reference?`)) return;
    try {
      await api.delete(`/statics-generation/reference-ads/${item.id}`);
      setItems(prev => prev.filter(i => i.id !== item.id));
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Delete failed');
    }
  };

  const handleSelect = (item) => {
    onSelectReference?.(item);
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
            <br /><br />
            Click <span className="text-[#d4b55a]">League</span> to import from followed brands or <span className="text-cyan-300">Meta</span> for your own winners.
          </div>
        )}
        {items.map((it) => (
          <ReferenceCard key={it.id} item={it} onSelect={handleSelect} onDelete={handleDelete} />
        ))}
      </div>

      {showLeague && (
        <LeagueImportModal
          onClose={() => setShowLeague(false)}
          onImported={() => { setShowLeague(false); load(); }}
        />
      )}
      {showMeta && (
        <MetaImportModal
          onClose={() => setShowMeta(false)}
          onImported={() => { setShowMeta(false); load(); }}
        />
      )}
    </div>
  );
}

export default ReferenceColumn;
