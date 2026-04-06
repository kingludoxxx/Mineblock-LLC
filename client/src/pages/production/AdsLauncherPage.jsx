import { useState, useEffect, useRef } from 'react';
import {
  Rocket, Upload, Link2, Video, Trash2, Check, X, Loader2,
  ChevronDown, AlertCircle, RefreshCw,
  FileVideo, Film, Target, Megaphone, Copy, Settings, Eye,
  CheckCircle2, XCircle, Clock, ArrowRight,
} from 'lucide-react';
import api from '../../services/api';

// ── Constants ────────────────────────────────────────────────────────────

const STATUS_COLORS = {
  uploaded: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  ready: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  approved: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  launching: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  launched: 'bg-green-500/20 text-green-300 border-green-500/30',
  failed: 'bg-red-500/20 text-red-400 border-red-500/30',
};

const STATUS_ICONS = {
  uploaded: Clock,
  ready: CheckCircle2,
  approved: CheckCircle2,
  launching: Loader2,
  launched: Rocket,
  failed: XCircle,
};

// ── Helpers ──────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds) {
  if (!seconds) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── Shared UI Atoms ──────────────────────────────────────────────────────

function SectionLabel({ icon: Icon, children }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      {Icon && <Icon className="w-3.5 h-3.5 text-[#c9a84c]" />}
      <h4 className="font-mono text-[10px] text-[#c9a84c] uppercase tracking-[0.15em] font-semibold">
        {children}
      </h4>
    </div>
  );
}

function Card({ children, className = '' }) {
  return (
    <div className={`glass-card border border-white/[0.05] rounded-xl p-5 ${className}`}>
      {children}
    </div>
  );
}

function StatusBadge({ status }) {
  const colors = STATUS_COLORS[status] || 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30';
  const Icon = STATUS_ICONS[status] || Clock;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-medium border ${colors}`}>
      <Icon className={`w-3 h-3 ${status === 'launching' ? 'animate-spin' : ''}`} />
      {status}
    </span>
  );
}

function GoldButton({ children, onClick, disabled, loading, className = '', variant = 'primary' }) {
  const base = variant === 'primary'
    ? 'bg-gradient-to-r from-[#c9a84c] to-[#d4b55a] text-[#111113] shadow-[0_0_20px_rgba(201,168,76,0.2)]'
    : 'bg-white/[0.04] border border-white/[0.08] text-zinc-300 hover:bg-white/[0.06]';
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className={`flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${base} ${className}`}
    >
      {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
      {children}
    </button>
  );
}

// ── Video Card ───────────────────────────────────────────────────────────

function VideoCard({ video, selected, onToggle, onRemove }) {
  return (
    <div
      className={`relative group rounded-xl border transition-all overflow-hidden cursor-pointer ${
        selected
          ? 'border-[#c9a84c]/40 bg-[#c9a84c]/5 shadow-[0_0_12px_rgba(201,168,76,0.08)]'
          : 'border-white/[0.06] bg-white/[0.02] hover:border-white/[0.12]'
      }`}
      onClick={onToggle}
    >
      {/* Thumbnail / Preview */}
      <div className="relative aspect-video bg-black/40 flex items-center justify-center">
        {video.thumbnail_url ? (
          <img src={video.thumbnail_url} alt={video.original_name} className="w-full h-full object-cover" />
        ) : (
          <Film className="w-8 h-8 text-zinc-600" />
        )}
        {video.duration && (
          <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 bg-black/70 rounded text-[10px] font-mono text-white">
            {formatDuration(video.duration)}
          </span>
        )}
        {/* Selection indicator */}
        <div className={`absolute top-2 left-2 w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all ${
          selected ? 'bg-[#c9a84c] border-[#c9a84c]' : 'border-white/20 bg-black/30'
        }`}>
          {selected && <Check className="w-3 h-3 text-black" />}
        </div>
      </div>

      {/* Info */}
      <div className="p-3 space-y-1.5">
        <p className="text-xs text-white font-medium truncate" title={video.original_name || video.filename}>
          {video.original_name || video.filename}
        </p>
        <div className="flex items-center gap-2 text-[10px] text-zinc-500 font-mono">
          <span>{formatBytes(video.file_size)}</span>
          {video.width && video.height && <span>{video.width}x{video.height}</span>}
          <StatusBadge status={video.status} />
        </div>
        {video.source === 'frame' && (
          <div className="flex items-center gap-1 text-[10px] text-purple-400">
            <Link2 className="w-3 h-3" />
            Frame.io
          </div>
        )}
      </div>

      {/* Remove button */}
      {onRemove && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(video.id); }}
          className="absolute top-2 right-2 w-6 h-6 rounded-md bg-red-500/20 border border-red-500/30 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
        >
          <Trash2 className="w-3 h-3 text-red-400" />
        </button>
      )}
    </div>
  );
}

// ── Template Selector ────────────────────────────────────────────────────

function TemplateSelector({ templates, selectedId, onSelect, loading }) {
  const [open, setOpen] = useState(false);
  const selected = templates.find(t => t.id === selectedId);
  const dropdownRef = useRef(null);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2.5 bg-white/[0.03] border border-white/[0.06] rounded-lg text-sm text-white cursor-pointer hover:border-white/[0.12] transition"
      >
        <span className={selected ? 'text-white' : 'text-zinc-500'}>
          {loading ? 'Loading templates...' : selected ? selected.name : 'Select launch template...'}
        </span>
        <ChevronDown className={`w-4 h-4 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full max-h-60 overflow-y-auto bg-[#1a1a1e] border border-white/[0.08] rounded-lg shadow-xl">
          {templates.length === 0 ? (
            <div className="px-3 py-4 text-xs text-zinc-500 text-center">
              No templates found. Create one in Brief Pipeline first.
            </div>
          ) : templates.map(t => (
            <button
              key={t.id}
              onClick={() => { onSelect(t.id); setOpen(false); }}
              className={`w-full text-left px-3 py-2.5 text-sm transition-colors cursor-pointer ${
                t.id === selectedId
                  ? 'bg-[#c9a84c]/10 text-[#e8d5a3]'
                  : 'text-zinc-300 hover:bg-white/[0.04]'
              }`}
            >
              <div className="font-medium">{t.name}</div>
              <div className="text-[10px] text-zinc-500 font-mono mt-0.5">
                {t.campaign_id ? 'Campaign configured' : 'No campaign'} · {t.ad_account_id || 'No account'}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Ad Copy Editor ───────────────────────────────────────────────────────

function AdCopyEditor({ adCopy, onChange }) {
  const update = (field, value) => onChange({ ...adCopy, [field]: value });

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs text-zinc-400 mb-1.5">Primary Text</label>
        <textarea
          value={adCopy.primary_text || ''}
          onChange={(e) => update('primary_text', e.target.value)}
          placeholder="Main ad copy text..."
          className="w-full h-24 bg-white/[0.03] border border-white/[0.06] rounded-lg p-3 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-[#c9a84c]/30 resize-none"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-zinc-400 mb-1.5">Headline</label>
          <input
            type="text"
            value={adCopy.headline || ''}
            onChange={(e) => update('headline', e.target.value)}
            placeholder="Ad headline..."
            className="w-full px-3 py-2 bg-white/[0.03] border border-white/[0.06] rounded-lg text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-[#c9a84c]/30"
          />
        </div>
        <div>
          <label className="block text-xs text-zinc-400 mb-1.5">Description</label>
          <input
            type="text"
            value={adCopy.description || ''}
            onChange={(e) => update('description', e.target.value)}
            placeholder="Ad description..."
            className="w-full px-3 py-2 bg-white/[0.03] border border-white/[0.06] rounded-lg text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-[#c9a84c]/30"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-zinc-400 mb-1.5">CTA Button</label>
          <select
            value={adCopy.cta || 'SHOP_NOW'}
            onChange={(e) => update('cta', e.target.value)}
            className="w-full px-3 py-2 bg-white/[0.03] border border-white/[0.06] rounded-lg text-sm text-white focus:outline-none focus:ring-1 focus:ring-[#c9a84c]/30 appearance-none cursor-pointer"
          >
            {['SHOP_NOW', 'LEARN_MORE', 'SIGN_UP', 'BUY_NOW', 'GET_OFFER', 'ORDER_NOW', 'SUBSCRIBE', 'WATCH_MORE', 'CONTACT_US'].map(c => (
              <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-zinc-400 mb-1.5">Landing Page URL</label>
          <input
            type="url"
            value={adCopy.landing_page_url || ''}
            onChange={(e) => update('landing_page_url', e.target.value)}
            placeholder="https://..."
            className="w-full px-3 py-2 bg-white/[0.03] border border-white/[0.06] rounded-lg text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-[#c9a84c]/30"
          />
        </div>
      </div>
    </div>
  );
}

// ── Launch Results Panel ─────────────────────────────────────────────────

function LaunchResults({ results: rawResults, adsets }) {
  const results = rawResults || [];
  const launched = results.filter(r => r.status === 'launched');
  const failed = results.filter(r => r.status === 'failed');

  // Group results by adset
  const byAdset = (adsets || []).map(as => ({
    ...as,
    results: results.filter(r => r.adset_id === as.id),
  }));
  const ungrouped = results.filter(r => !adsets?.some(a => a.id === r.adset_id));

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        {failed.length === 0 ? (
          <div className="w-10 h-10 rounded-full bg-emerald-500/20 flex items-center justify-center">
            <CheckCircle2 className="w-5 h-5 text-emerald-400" />
          </div>
        ) : (
          <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center">
            <AlertCircle className="w-5 h-5 text-amber-400" />
          </div>
        )}
        <div>
          <h3 className="text-sm font-medium text-white">
            {failed.length === 0 ? 'All ads launched successfully' : `${launched.length}/${results.length} ads launched`}
          </h3>
          <p className="text-xs text-zinc-500 font-mono">
            {adsets?.length > 1 ? `${adsets.length} ad sets created` : adsets?.[0]?.name ? `Adset: ${adsets[0].name}` : ''}
          </p>
        </div>
      </div>

      {byAdset.length > 1 ? (
        <div className="space-y-4">
          {byAdset.map((as, ai) => (
            <div key={as.id || ai}>
              <div className="text-[10px] font-mono text-[#c9a84c] uppercase tracking-wider mb-2">
                Ad Set #{ai + 1}: {as.name}
              </div>
              <div className="space-y-1.5">
                {as.results.map((r, i) => (
                  <div key={i} className={`flex items-center gap-3 px-3 py-2 rounded-lg border ${
                    r.status === 'launched' ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-red-500/20 bg-red-500/5'
                  }`}>
                    {r.status === 'launched' ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                    ) : (
                      <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-white truncate">{r.ad_name || `Video ${i + 1}`}</p>
                      {r.error && <p className="text-[10px] text-red-400 truncate">{r.error}</p>}
                    </div>
                    {r.meta_ad_id && (
                      <span className="text-[10px] font-mono text-zinc-500">{r.meta_ad_id}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {[...ungrouped, ...(byAdset[0]?.results || [])].map((r, i) => (
            <div key={i} className={`flex items-center gap-3 px-3 py-2 rounded-lg border ${
              r.status === 'launched' ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-red-500/20 bg-red-500/5'
            }`}>
              {r.status === 'launched' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
              ) : (
                <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-xs text-white truncate">{r.ad_name || `Video ${i + 1}`}</p>
                {r.error && <p className="text-[10px] text-red-400 truncate">{r.error}</p>}
              </div>
              {r.meta_ad_id && (
                <span className="text-[10px] font-mono text-zinc-500">{r.meta_ad_id}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ── Main Page ────────────────────────────────────────────────────────────

export default function AdsLauncherPage() {
  // Video state
  const [videos, setVideos] = useState([]);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [loadingVideos, setLoadingVideos] = useState(false);

  // Frame import state
  const [frameUrl, setFrameUrl] = useState('');
  const [importingFrame, setImportingFrame] = useState(false);
  const [frameError, setFrameError] = useState('');

  // Upload state
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState({});
  const fileInputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const launchingRef = useRef(false);

  // Template state
  const [templates, setTemplates] = useState([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState(null);
  const [loadingTemplates, setLoadingTemplates] = useState(false);

  // Ad copy state
  const [adCopy, setAdCopy] = useState({
    primary_text: '',
    headline: '',
    description: '',
    cta: 'SHOP_NOW',
    landing_page_url: '',
  });

  // Launch state
  const [launching, setLaunching] = useState(false);
  const [launchResults, setLaunchResults] = useState(null);
  const [launchError, setLaunchError] = useState('');
  const [adsetCount, setAdsetCount] = useState(1);

  // Active tab
  const [activeTab, setActiveTab] = useState('import'); // 'import' | 'configure' | 'launch'

  // ── Load data on mount ──────────────────────────────────────────────────

  useEffect(() => {
    loadVideos();
    loadTemplates();
  }, []);

  const loadVideos = async () => {
    setLoadingVideos(true);
    try {
      const { data } = await api.get('/video-ads-launcher/videos');
      setVideos(data.data || []);
    } catch (err) {
      console.error('Failed to load videos:', err);
    } finally {
      setLoadingVideos(false);
    }
  };

  const loadTemplates = async () => {
    setLoadingTemplates(true);
    try {
      const { data } = await api.get('/video-ads-launcher/launch-templates');
      setTemplates(data.data || []);
    } catch (err) {
      console.error('Failed to load templates:', err);
    } finally {
      setLoadingTemplates(false);
    }
  };

  // ── Selection ───────────────────────────────────────────────────────────

  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    const launchable = videos.filter(v => ['uploaded', 'ready', 'approved'].includes(v.status));
    setSelectedIds(new Set(launchable.map(v => v.id)));
  };

  const deselectAll = () => setSelectedIds(new Set());

  // ── Frame.io import ─────────────────────────────────────────────────────

  const handleFrameImport = async () => {
    if (!frameUrl.trim()) return;
    setImportingFrame(true);
    setFrameError('');
    try {
      const { data } = await api.post('/video-ads-launcher/import-frame', { frame_url: frameUrl.trim() });
      const imported = data.data?.videos || [];
      if (imported.length === 0) {
        setFrameError(data.data?.message || 'No video files found');
      } else {
        setVideos(prev => [...imported, ...prev]);
        setSelectedIds(prev => {
          const next = new Set(prev);
          imported.forEach(v => next.add(v.id));
          return next;
        });
        setFrameUrl('');
      }
    } catch (err) {
      setFrameError(err.response?.data?.error?.message || err.message || 'Import failed');
    } finally {
      setImportingFrame(false);
    }
  };

  // ── File upload via drag & drop or file picker ──────────────────────────

  const handleFiles = async (files) => {
    const videoFiles = Array.from(files).filter(f =>
      f.type.startsWith('video/') || /\.(mp4|mov|webm|avi|mkv|m4v)$/i.test(f.name)
    );
    if (!videoFiles.length) return;

    setUploading(true);
    const newVideos = [];

    for (const file of videoFiles) {
      setUploadProgress(prev => ({ ...prev, [file.name]: 'uploading' }));
      try {
        // Create a temporary object URL for the video
        const objectUrl = URL.createObjectURL(file);

        // Get video metadata
        const metadata = await new Promise((resolve) => {
          const videoEl = document.createElement('video');
          videoEl.preload = 'metadata';
          videoEl.onloadedmetadata = () => {
            resolve({
              duration: videoEl.duration,
              width: videoEl.videoWidth,
              height: videoEl.videoHeight,
            });
            URL.revokeObjectURL(objectUrl);
          };
          videoEl.onerror = () => {
            resolve({ duration: null, width: null, height: null });
            URL.revokeObjectURL(objectUrl);
          };
          videoEl.src = objectUrl;
        });

        // For now, store with a placeholder URL — real upload to R2/S3 would happen here
        // The video_url will need to be a publicly accessible URL for Meta upload
        const { data } = await api.post('/video-ads-launcher/videos', {
          filename: file.name,
          original_name: file.name,
          file_size: file.size,
          duration: metadata.duration,
          width: metadata.width,
          height: metadata.height,
          content_type: file.type || 'video/mp4',
          source: 'upload',
          video_url: null, // Will need R2/S3 upload for production
        });

        newVideos.push(data.data);
        setUploadProgress(prev => ({ ...prev, [file.name]: 'done' }));
      } catch (err) {
        console.error(`Upload failed for ${file.name}:`, err);
        setUploadProgress(prev => ({ ...prev, [file.name]: 'error' }));
      }
    }

    if (newVideos.length) {
      setVideos(prev => [...newVideos, ...prev]);
      setSelectedIds(prev => {
        const next = new Set(prev);
        newVideos.forEach(v => next.add(v.id));
        return next;
      });
    }

    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setTimeout(() => setUploadProgress({}), 3000);
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer.files);
  };

  const onDragOver = (e) => { e.preventDefault(); setDragOver(true); };
  const onDragLeave = () => setDragOver(false);

  // ── Remove video ────────────────────────────────────────────────────────

  const removeVideo = async (id) => {
    try {
      await api.delete(`/video-ads-launcher/videos/${id}`);
      setVideos(prev => prev.filter(v => v.id !== id));
      setSelectedIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch (err) {
      console.error('Failed to remove video:', err);
    }
  };

  // ── Launch ──────────────────────────────────────────────────────────────

  const handleLaunch = async () => {
    if (!selectedIds.size || !selectedTemplateId || launchingRef.current) return;
    launchingRef.current = true;
    setLaunching(true);
    setLaunchError('');
    setLaunchResults(null);
    try {
      const { data } = await api.post('/video-ads-launcher/launch', {
        video_ids: Array.from(selectedIds),
        template_id: selectedTemplateId,
        ad_copy: adCopy,
        adset_count: adsetCount,
      });
      setLaunchResults(data.data);
      // Refresh videos to get updated statuses
      await loadVideos();
    } catch (err) {
      setLaunchError(err.response?.data?.error?.message || err.message || 'Launch failed');
    } finally {
      setLaunching(false);
      launchingRef.current = false;
    }
  };

  // ── Computed ─────────────────────────────────────────────────────────────

  const launchableVideos = videos.filter(v => ['uploaded', 'ready', 'approved'].includes(v.status));
  const selectedVideos = videos.filter(v => selectedIds.has(v.id));
  const canLaunch = selectedIds.size > 0 && selectedTemplateId && !launching;
  const selectedTemplate = templates.find(t => t.id === selectedTemplateId);

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#c9a84c]/20 to-[#c9a84c]/5 border border-[#c9a84c]/20 flex items-center justify-center">
            <Rocket className="w-5 h-5 text-[#c9a84c]" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-white tracking-tight">Ads Launcher</h1>
            <p className="text-xs text-zinc-500 font-mono">Video ads · Fast launch pipeline</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadVideos}
            className="p-2 rounded-lg border border-white/[0.06] bg-white/[0.02] text-zinc-400 hover:text-white hover:border-white/[0.12] transition cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 ${loadingVideos ? 'animate-spin' : ''}`} />
          </button>
          <div className="px-3 py-1.5 rounded-lg bg-white/[0.03] border border-white/[0.06] text-xs font-mono text-zinc-400">
            {videos.length} videos · {selectedIds.size} selected
          </div>
        </div>
      </div>

      {/* Step Tabs */}
      <div className="flex gap-1 p-1 bg-white/[0.02] rounded-xl border border-white/[0.05]">
        {[
          { key: 'import', icon: Upload, label: '1. Import Videos', count: videos.length },
          { key: 'configure', icon: Settings, label: '2. Configure', count: selectedIds.size },
          { key: 'launch', icon: Rocket, label: '3. Launch', count: null },
        ].map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-xs font-medium transition-all cursor-pointer ${
              activeTab === tab.key
                ? 'bg-white/[0.06] text-white shadow-[0_1px_2px_rgba(0,0,0,0.2)] border border-white/[0.06]'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            <tab.icon className="w-3.5 h-3.5" />
            {tab.label}
            {tab.count !== null && tab.count > 0 && (
              <span className="px-1.5 py-0.5 rounded-full bg-[#c9a84c]/15 text-[#c9a84c] text-[10px] font-mono">
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Tab 1: Import Videos ─────────────────────────────────────────── */}
      {activeTab === 'import' && (
        <div className="space-y-6">
          {/* Frame.io Import */}
          <Card>
            <SectionLabel icon={Link2}>Frame.io Import</SectionLabel>
            <p className="text-xs text-zinc-500 mb-3">
              Paste a Frame.io link to automatically import video creatives.
            </p>
            <div className="flex gap-2">
              <input
                type="url"
                value={frameUrl}
                onChange={(e) => setFrameUrl(e.target.value)}
                placeholder="https://next.frame.io/project/... or https://app.frame.io/reviews/..."
                className="flex-1 px-3 py-2.5 bg-white/[0.03] border border-white/[0.06] rounded-lg text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-[#c9a84c]/30"
                onKeyDown={(e) => e.key === 'Enter' && handleFrameImport()}
              />
              <GoldButton onClick={handleFrameImport} loading={importingFrame} disabled={!frameUrl.trim()}>
                <Link2 className="w-4 h-4" />
                Import
              </GoldButton>
            </div>
            {frameError && (
              <div className="mt-2 flex items-center gap-2 text-xs text-red-400">
                <AlertCircle className="w-3.5 h-3.5" />
                {frameError}
              </div>
            )}
          </Card>

          {/* Mass Upload */}
          <Card>
            <SectionLabel icon={Upload}>Mass Video Upload</SectionLabel>
            <div
              onDrop={onDrop}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onClick={() => fileInputRef.current?.click()}
              className={`relative border-2 border-dashed rounded-xl p-8 text-center transition-all cursor-pointer ${
                dragOver
                  ? 'border-[#c9a84c]/50 bg-[#c9a84c]/5'
                  : 'border-white/[0.08] hover:border-white/[0.15] bg-white/[0.01]'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="video/*,.mp4,.mov,.webm,.avi,.mkv,.m4v"
                className="hidden"
                onChange={(e) => handleFiles(e.target.files)}
              />
              <FileVideo className={`w-10 h-10 mx-auto mb-3 ${dragOver ? 'text-[#c9a84c]' : 'text-zinc-600'}`} />
              <p className="text-sm text-zinc-300 mb-1">
                {uploading ? 'Uploading...' : 'Drop video files here or click to browse'}
              </p>
              <p className="text-xs text-zinc-600">
                MP4, MOV, WebM, AVI, MKV · Multiple files supported
              </p>
            </div>

            {/* Upload progress */}
            {Object.keys(uploadProgress).length > 0 && (
              <div className="mt-3 space-y-1">
                {Object.entries(uploadProgress).map(([name, status]) => (
                  <div key={name} className="flex items-center gap-2 text-xs">
                    {status === 'uploading' ? (
                      <Loader2 className="w-3 h-3 text-[#c9a84c] animate-spin" />
                    ) : status === 'done' ? (
                      <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                    ) : (
                      <XCircle className="w-3 h-3 text-red-400" />
                    )}
                    <span className="text-zinc-400 truncate">{name}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* Video Library */}
          {videos.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <SectionLabel icon={Video}>Video Library ({videos.length})</SectionLabel>
                <div className="flex items-center gap-2">
                  <button
                    onClick={selectAll}
                    className="text-[10px] font-mono text-[#c9a84c] hover:text-[#e8d5a3] transition cursor-pointer"
                  >
                    Select all ({launchableVideos.length})
                  </button>
                  {selectedIds.size > 0 && (
                    <button
                      onClick={deselectAll}
                      className="text-[10px] font-mono text-zinc-500 hover:text-zinc-300 transition cursor-pointer"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                {videos.map(v => (
                  <VideoCard
                    key={v.id}
                    video={v}
                    selected={selectedIds.has(v.id)}
                    onToggle={() => toggleSelect(v.id)}
                    onRemove={removeVideo}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Next step */}
          {selectedIds.size > 0 && (
            <div className="flex justify-end">
              <GoldButton onClick={() => setActiveTab('configure')}>
                Configure {selectedIds.size} video{selectedIds.size > 1 ? 's' : ''}
                <ArrowRight className="w-4 h-4" />
              </GoldButton>
            </div>
          )}
        </div>
      )}

      {/* ── Tab 2: Configure ─────────────────────────────────────────────── */}
      {activeTab === 'configure' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left: Selected videos */}
          <div className="lg:col-span-1 space-y-4">
            <Card>
              <SectionLabel icon={Video}>Selected Videos ({selectedIds.size})</SectionLabel>
              {selectedVideos.length === 0 ? (
                <div className="text-center py-8">
                  <Film className="w-8 h-8 text-zinc-600 mx-auto mb-2" />
                  <p className="text-xs text-zinc-500">No videos selected</p>
                  <button
                    onClick={() => setActiveTab('import')}
                    className="mt-2 text-xs text-[#c9a84c] hover:text-[#e8d5a3] transition cursor-pointer"
                  >
                    Go to Import tab
                  </button>
                </div>
              ) : (
                <div className="space-y-2 max-h-[500px] overflow-y-auto pr-1">
                  {selectedVideos.map(v => (
                    <div key={v.id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.05]">
                      <div className="w-12 h-8 rounded bg-black/40 flex items-center justify-center flex-shrink-0 overflow-hidden">
                        {v.thumbnail_url ? (
                          <img src={v.thumbnail_url} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <Film className="w-4 h-4 text-zinc-600" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-white truncate">{v.original_name || v.filename}</p>
                        <p className="text-[10px] text-zinc-500 font-mono">
                          {formatBytes(v.file_size)} · {formatDuration(v.duration)}
                        </p>
                      </div>
                      <button
                        onClick={() => toggleSelect(v.id)}
                        className="p-1 rounded text-zinc-500 hover:text-red-400 transition cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          {/* Right: Configuration */}
          <div className="lg:col-span-2 space-y-4">
            {/* Launch Template */}
            <Card>
              <SectionLabel icon={Target}>Launch Template</SectionLabel>
              <p className="text-xs text-zinc-500 mb-3">
                Select a pre-configured template with campaign, targeting, and budget settings.
              </p>
              <TemplateSelector
                templates={templates}
                selectedId={selectedTemplateId}
                onSelect={setSelectedTemplateId}
                loading={loadingTemplates}
              />
              {selectedTemplate && (
                <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] font-mono text-zinc-500">
                  <div>Account: <span className="text-zinc-400">{selectedTemplate.ad_account_id || '—'}</span></div>
                  <div>Campaign: <span className="text-zinc-400">{selectedTemplate.campaign_id ? 'Configured' : 'None'}</span></div>
                  <div>Budget: <span className="text-zinc-400">{selectedTemplate.daily_budget ? `$${selectedTemplate.daily_budget}/day` : '—'}</span></div>
                  <div>Optimization: <span className="text-zinc-400">{selectedTemplate.optimization_goal || '—'}</span></div>
                  <div>Countries: <span className="text-zinc-400">{(() => { try { const c = typeof selectedTemplate.countries === 'string' ? JSON.parse(selectedTemplate.countries) : selectedTemplate.countries; return Array.isArray(c) ? c.join(', ') : '—'; } catch { return '—'; } })()}</span></div>
                  <div>Attribution: <span className="text-zinc-400">{selectedTemplate.attribution_window || '—'}</span></div>
                </div>
              )}
            </Card>

            {/* Ad Copy */}
            <Card>
              <SectionLabel icon={Copy}>Ad Copy</SectionLabel>
              <p className="text-xs text-zinc-500 mb-3">
                Set the ad copy for all videos in this batch. Individual copy per video coming soon.
              </p>
              <AdCopyEditor adCopy={adCopy} onChange={setAdCopy} />
            </Card>

            {/* Multi-Adset */}
            <Card>
              <SectionLabel icon={Megaphone}>Ad Set Duplication</SectionLabel>
              <p className="text-xs text-zinc-500 mb-3">
                Launch the same videos into multiple ad sets at once. Each ad set gets its own copy of every video ad.
              </p>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setAdsetCount(prev => Math.max(1, prev - 1))}
                    disabled={adsetCount <= 1}
                    className="w-8 h-8 rounded-lg bg-white/[0.04] border border-white/[0.08] flex items-center justify-center text-zinc-300 hover:bg-white/[0.08] transition cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    −
                  </button>
                  <div className="w-16 text-center">
                    <span className="text-lg font-semibold text-white font-mono">{adsetCount}</span>
                  </div>
                  <button
                    onClick={() => setAdsetCount(prev => Math.min(20, prev + 1))}
                    disabled={adsetCount >= 20}
                    className="w-8 h-8 rounded-lg bg-white/[0.04] border border-white/[0.08] flex items-center justify-center text-zinc-300 hover:bg-white/[0.08] transition cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    +
                  </button>
                </div>
                <div className="text-xs text-zinc-500 font-mono">
                  {adsetCount === 1
                    ? `${selectedIds.size} ad${selectedIds.size > 1 ? 's' : ''} → 1 ad set`
                    : `${selectedIds.size} video${selectedIds.size > 1 ? 's' : ''} × ${adsetCount} ad sets = ${selectedIds.size * adsetCount} ads total`
                  }
                </div>
              </div>
              {adsetCount > 5 && (
                <div className="mt-2 flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                  <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                  High ad set count. Each ad set creates {selectedIds.size} ads. Total: {selectedIds.size * adsetCount} ads.
                </div>
              )}
            </Card>

            {/* Next step */}
            <div className="flex justify-end">
              <GoldButton
                onClick={() => setActiveTab('launch')}
                disabled={!selectedIds.size || !selectedTemplateId}
              >
                Review & Launch
                <ArrowRight className="w-4 h-4" />
              </GoldButton>
            </div>
          </div>
        </div>
      )}

      {/* ── Tab 3: Launch ────────────────────────────────────────────────── */}
      {activeTab === 'launch' && (
        <div className="max-w-2xl mx-auto space-y-6">
          {/* Summary */}
          <Card>
            <SectionLabel icon={Eye}>Launch Summary</SectionLabel>
            <div className="space-y-3">
              <div className="flex items-center justify-between py-2 border-b border-white/[0.05]">
                <span className="text-xs text-zinc-400">Videos</span>
                <span className="text-sm text-white font-medium">{selectedIds.size}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-white/[0.05]">
                <span className="text-xs text-zinc-400">Template</span>
                <span className="text-sm text-white font-medium">{selectedTemplate?.name || '—'}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-white/[0.05]">
                <span className="text-xs text-zinc-400">Campaign</span>
                <span className="text-sm text-white font-medium">{selectedTemplate?.campaign_id ? 'Configured' : 'Not set'}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-white/[0.05]">
                <span className="text-xs text-zinc-400">Ad Copy</span>
                <span className="text-sm text-white font-medium">{adCopy.primary_text ? 'Set' : 'Empty'}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-white/[0.05]">
                <span className="text-xs text-zinc-400">Ad Sets</span>
                <span className="text-sm text-white font-medium">{adsetCount}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-white/[0.05]">
                <span className="text-xs text-zinc-400">Total Ads</span>
                <span className="text-sm text-white font-medium font-mono">{selectedIds.size * adsetCount}</span>
              </div>
              <div className="flex items-center justify-between py-2">
                <span className="text-xs text-zinc-400">Status</span>
                <span className="text-sm text-white font-medium">
                  {launching ? 'Launching...' : launchResults ? 'Complete' : 'Ready'}
                </span>
              </div>
            </div>

            {/* Validation warnings */}
            {!selectedTemplate?.campaign_id && (
              <div className="mt-3 flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                Template has no campaign configured. Launch will fail.
              </div>
            )}
            {!adCopy.primary_text && (
              <div className="mt-2 flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                No ad copy set. Ads will launch with empty text.
              </div>
            )}
            {selectedVideos.some(v => !v.video_url) && (
              <div className="mt-2 flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                Some videos have no URL. They were uploaded locally and need a public URL for Meta. Use Frame.io import or provide a direct video URL.
              </div>
            )}
          </Card>

          {/* Launch button */}
          {!launchResults && (
            <GoldButton
              onClick={handleLaunch}
              loading={launching}
              disabled={!canLaunch}
              className="w-full py-3.5 text-sm font-mono font-semibold tracking-wide uppercase"
            >
              <Rocket className="w-4 h-4" />
              {launching
                ? `Launching ${selectedIds.size * adsetCount} ad${selectedIds.size * adsetCount > 1 ? 's' : ''}...`
                : `Launch ${selectedIds.size * adsetCount} Ad${selectedIds.size * adsetCount > 1 ? 's' : ''}${adsetCount > 1 ? ` into ${adsetCount} Ad Sets` : ''}`
              }
            </GoldButton>
          )}

          {/* Launch error */}
          {launchError && (
            <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
              {launchError}
            </div>
          )}

          {/* Launch results */}
          {launchResults && (
            <LaunchResults results={launchResults.results} adsets={launchResults.adsets} />
          )}
        </div>
      )}
    </div>
  );
}
