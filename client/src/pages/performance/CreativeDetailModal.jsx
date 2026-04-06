import { useState, useEffect, useRef } from 'react';
import {
  X, ExternalLink, Video, RefreshCw, Play, Eye,
  ThumbsUp, AlertTriangle, ChevronRight,
  TrendingUp, ShoppingCart, Target, BarChart3,
} from 'lucide-react';
import {
  ResponsiveContainer, ComposedChart, AreaChart, Area,
  Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import api from '../../services/api';

// ── Formatters ────────────────────────────────────────────────────────

const fmtMoney = (n) => '$' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtRoas = (n) => Number(n || 0).toFixed(2) + 'x';
const fmtPct = (n) => Number(n || 0).toFixed(2) + '%';
const fmtInt = (n) => Number(n || 0).toLocaleString();
const fmtDuration = (s) => { if (!s) return '0s'; return s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Number(s).toFixed(1)}s`; };

// ── Section Component ─────────────────────────────────────────────────

function SectionHeader({ icon: Icon, children, color = 'text-blue-400' }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      {Icon && <Icon className={`w-3.5 h-3.5 ${color}`} />}
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">{children}</h4>
    </div>
  );
}

function MetricCard({ label, value, highlight, small }) {
  return (
    <div className={`bg-white/[0.03] border border-white/[0.06] rounded-lg ${small ? 'p-2.5' : 'p-3'}`}>
      <p className="text-gray-500 text-[10px] uppercase tracking-wider mb-0.5">{label}</p>
      <p className={`font-semibold ${small ? 'text-xs' : 'text-sm'} ${highlight || 'text-white'}`}>{value}</p>
    </div>
  );
}

// ── Reaction emoji components ─────────────────────────────────────────

function ReactionIcon({ type, count }) {
  const icons = {
    like: { emoji: '👍', bg: 'bg-blue-500/20' },
    love: { emoji: '❤️', bg: 'bg-red-500/20' },
    care: { emoji: '🥰', bg: 'bg-pink-500/20' },
    haha: { emoji: '😂', bg: 'bg-yellow-500/20' },
    wow: { emoji: '😮', bg: 'bg-orange-500/20' },
    sad: { emoji: '😢', bg: 'bg-blue-500/20' },
    angry: { emoji: '😡', bg: 'bg-red-500/20' },
  };
  const config = icons[type] || { emoji: '👍', bg: 'bg-gray-500/20' };
  return (
    <div className="flex flex-col items-center gap-1">
      <div className={`w-8 h-8 rounded-full ${config.bg} flex items-center justify-center text-sm`}>
        {config.emoji}
      </div>
      <span className="text-white font-semibold text-xs">{count}</span>
      <span className="text-gray-500 text-[9px] capitalize">{type}</span>
    </div>
  );
}

// ── Retention Chart ───────────────────────────────────────────────────

function RetentionChart({ insights, impressions: totalImpressions }) {
  if (!insights) return null;

  const views3s = Number(insights.video_3s_views) || Number(insights.video_views) || 0;
  const viewsTotal = Number(insights.video_views) || Number(insights.video_3s_views) || 0;
  if (!views3s) return null;

  // Build retention curve data points
  // 3s uses impressions as denominator (hook rate), percentiles use total plays as denominator
  const data = [
    { label: '0s', pct: 100, position: 0 },
    { label: '3s', pct: totalImpressions > 0 ? Math.min(100, Math.round((views3s / totalImpressions) * 100)) : 100, position: 5 },
    { label: '25%', pct: viewsTotal > 0 ? Math.min(100, Math.round((insights.video_p25 / viewsTotal) * 100)) : 0, position: 25 },
    { label: '50%', pct: viewsTotal > 0 ? Math.min(100, Math.round((insights.video_p50 / viewsTotal) * 100)) : 0, position: 50 },
    { label: '75%', pct: viewsTotal > 0 ? Math.min(100, Math.round((insights.video_p75 / viewsTotal) * 100)) : 0, position: 75 },
    { label: '95%', pct: viewsTotal > 0 ? Math.min(100, Math.round((insights.video_p95 / viewsTotal) * 100)) : 0, position: 95 },
    { label: '100%', pct: viewsTotal > 0 ? Math.min(100, Math.round((insights.video_p100 / viewsTotal) * 100)) : 0, position: 100 },
  ];

  const hookRate = insights.hook_rate ? (Number(insights.hook_rate) * 100).toFixed(1) : '0.0';
  const holdRate = insights.hold_rate ? (Number(insights.hold_rate) * 100).toFixed(1) : '0.0';

  return (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
      <SectionHeader icon={Eye} color="text-purple-400">Audience Retention</SectionHeader>

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
        <MetricCard label="Views" value={fmtInt(views3s)} small />
        <MetricCard label="Hook Rate" value={`${hookRate}%`} highlight={parseFloat(hookRate) > 30 ? 'text-emerald-400' : 'text-amber-400'} small />
        <MetricCard label="Hold Rate" value={`${holdRate}%`} highlight={parseFloat(holdRate) > 10 ? 'text-emerald-400' : 'text-amber-400'} small />
        <MetricCard label="Avg Watch" value={fmtDuration(insights.video_avg_time)} small />
      </div>

      {/* Retention curve */}
      <ResponsiveContainer width="100%" height={180}>
        <AreaChart data={data} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
          <defs>
            <linearGradient id="retentionGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#a78bfa" stopOpacity={0.4} />
              <stop offset="100%" stopColor="#a78bfa" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
          <XAxis dataKey="label" tick={{ fill: '#6b7280', fontSize: 10 }} axisLine={{ stroke: 'rgba(255,255,255,0.06)' }} tickLine={false} />
          <YAxis domain={[0, 100]} tick={{ fill: '#6b7280', fontSize: 10 }} axisLine={{ stroke: 'rgba(255,255,255,0.06)' }} tickLine={false} tickFormatter={v => `${v}%`} />
          <Tooltip
            contentStyle={{ background: '#1c1c1c', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, color: '#fff', fontSize: 12 }}
            formatter={(value) => [`${value}%`, 'Retention']}
          />
          <Area type="monotone" dataKey="pct" fill="url(#retentionGrad)" stroke="#a78bfa" strokeWidth={2} dot={{ r: 4, fill: '#a78bfa', stroke: '#1c1c1c', strokeWidth: 2 }} />
        </AreaChart>
      </ResponsiveContainer>

      {/* Drop-off analysis */}
      {data[2].pct > 0 && (
        <div className="mt-3 space-y-1.5">
          {data[1].pct - data[2].pct > 30 && (
            <div className="flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              Significant drop between 3s and 25% — hook may not be converting into sustained attention.
            </div>
          )}
          {data[3].pct > 0 && data[3].pct < 20 && (
            <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              Under 20% retention at 50% — mid-section pacing or content may need work.
            </div>
          )}
          {data[6].pct > 20 && (
            <div className="flex items-center gap-2 text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">
              <TrendingUp className="w-3.5 h-3.5 flex-shrink-0" />
              Strong completion rate — audience stays engaged through the entire video.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Date range helper (module scope) ─────────────────────────────────

const rangeToDate = (range) => {
  const fmt = (d) => d.toISOString().slice(0, 10);
  const today = new Date();
  const sub = (days) => { const d = new Date(); d.setDate(d.getDate() - days); return d; };
  switch (range) {
    case 'last_7': return { startDate: fmt(sub(6)), endDate: fmt(today) };
    case 'last_14': return { startDate: fmt(sub(13)), endDate: fmt(today) };
    case 'last_30': return { startDate: fmt(sub(29)), endDate: fmt(today) };
    case 'lifetime': return { startDate: fmt(sub(364)), endDate: fmt(today) };
    default: return { startDate: fmt(sub(29)), endDate: fmt(today) };
  }
};

const RANGES = [
  { key: 'last_7', label: '7D' },
  { key: 'last_14', label: '14D' },
  { key: 'last_30', label: '30D' },
  { key: 'lifetime', label: 'Lifetime' },
];

// ── Main Modal ────────────────────────────────────────────────────────

export default function CreativeDetailModal({ creative, onClose }) {
  const [metaInsights, setMetaInsights] = useState(null);
  const [metaLoading, setMetaLoading] = useState(false);
  const [metaAdId, setMetaAdId] = useState(creative?.meta_ad_id || null);
  const [twData, setTwData] = useState(null);
  const [twLoading, setTwLoading] = useState(false);
  const [chartRange, setChartRange] = useState('last_30');
  const twCacheRef = useRef({}); // { [cid__range]: twData }
  const [videoUrl, setVideoUrl] = useState(creative?.video_url || null);
  const [thumbnailUrl, setThumbnailUrl] = useState(creative?.thumbnail_url || null);
  const [videoFailed, setVideoFailed] = useState(false);
  const videoRef = useRef(null);

  // ── Derived values (before effects, after hooks) ─────────────────────
  const cid = creative?._creativeId || creative?.creative_id || '';
  const adName = creative?.ad_name || cid;
  const isVideo = (creative?.type || '').toLowerCase() === 'video';

  // ── Sync state when creative prop changes (defensive) ───────────────
  useEffect(() => {
    if (!creative) return;
    setMetaAdId(creative.meta_ad_id || null);
    setVideoUrl(creative.video_url || null);
    setThumbnailUrl(creative.thumbnail_url || null);
    setMetaInsights(null);
    setTwData(null);
    setChartRange('last_30');
    setVideoFailed(false);
    twCacheRef.current = {};
  }, [creative]);

  // ── Fetch Meta data on mount / creative change ──────────────────────

  useEffect(() => {
    if (!creative) return;
    let cancelled = false;

    const resolveAndFetchMeta = async () => {
      let adId = creative.meta_ad_id;

      if (!adId) {
        try {
          const { data } = await api.get(`/creative-analysis/meta-lookup/${cid}`);
          if (cancelled) return;
          if (data.data?.meta_ad_id) {
            adId = data.data.meta_ad_id;
            setMetaAdId(adId);
            if (data.data.video_url) setVideoUrl(data.data.video_url);
            if (data.data.thumbnail_url) setThumbnailUrl(data.data.thumbnail_url);
          }
        } catch { if (cancelled) return; }
      }

      if (adId && !cancelled) {
        setMetaLoading(true);
        try {
          const { data } = await api.get(`/creative-analysis/meta-insights/${adId}`);
          if (!cancelled) setMetaInsights(data.data || null);
        } catch { if (!cancelled) setMetaInsights(null); }
        finally { if (!cancelled) setMetaLoading(false); }
      }
    };
    resolveAndFetchMeta();
    return () => { cancelled = true; };
  }, [creative]);

  // ── Refetch TW daily on range change (with client-side cache) ───────

  useEffect(() => {
    if (!cid) return;
    const cacheKey = `${cid}__${chartRange}`;

    // Instant cache hit — no API call needed
    if (twCacheRef.current[cacheKey]) {
      setTwData(twCacheRef.current[cacheKey]);
      setTwLoading(false);
      return;
    }

    const controller = new AbortController();
    const fetchDaily = async () => {
      setTwLoading(true);
      try {
        const { startDate, endDate } = rangeToDate(chartRange);
        const { data } = await api.get('/creative-analysis/creative-daily', {
          params: { creative_id: cid, startDate, endDate },
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          const result = data.data || null;
          if (result) twCacheRef.current[cacheKey] = result;
          setTwData(result);
        }
      } catch (err) {
        if (!controller.signal.aborted) setTwData(null);
      } finally {
        if (!controller.signal.aborted) setTwLoading(false);
      }
    };
    fetchDaily();
    return () => controller.abort();
  }, [chartRange, cid]);

  // ── Close on Escape ─────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // ── Lock body scroll while modal is open ───────────────────────────

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // ── Pause & cleanup video on unmount ───────────────────────────────

  useEffect(() => {
    return () => {
      if (videoRef.current) {
        videoRef.current.pause();
        videoRef.current.removeAttribute('src');
        videoRef.current.load();
      }
    };
  }, []);

  // ── Early return AFTER all hooks ────────────────────────────────────
  if (!creative) return null;

  // ── Derived values ──────────────────────────────────────────────────

  const totals = twData?.totals || {};
  const daily = twData?.daily || [];
  const spend = totals.total_spend ?? creative.spend ?? 0;
  const revenue = totals.total_revenue ?? creative.revenue ?? 0;
  const roas = totals.roas ?? creative.roas ?? 0;
  const purchases = totals.total_purchases ?? creative.purchases ?? 0;
  const cpa = totals.cpa ?? creative.cpa ?? 0;
  const impressions = totals.total_impressions ?? creative.impressions ?? 0;
  const clicks = totals.total_clicks ?? creative.clicks ?? 0;
  const ctr = totals.ctr ?? creative.ctr ?? 0;
  const cpm = totals.cpm ?? creative.cpm ?? 0;
  const aov = purchases > 0 ? revenue / purchases : creative.aov || 0;

  const mi = metaInsights || {};

  // Chart data
  const chartPoints = daily.map(d => ({
    date: new Date(d.date + 'T00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    spend: d.spend,
    roas: d.spend > 0 ? Math.round((d.revenue / d.spend) * 100) / 100 : 0,
  }));

  // Facebook Ads Manager URL
  const fbUrl = metaAdId
    ? `https://adsmanager.facebook.com/adsmanager/manage/ads?selected_ad_ids=${metaAdId}`
    : null;

  // Distribution signals
  const likeRate = mi.impressions > 0 ? ((mi.total_reactions / mi.impressions) * 100).toFixed(2) : '0.00';
  const commentRate = mi.impressions > 0 ? ((mi.comments / mi.impressions) * 100).toFixed(2) : '0.00';
  const shareRate = mi.impressions > 0 ? ((mi.shares / mi.impressions) * 100).toFixed(2) : '0.00';
  const metaCtr = mi.ctr ? Number(mi.ctr).toFixed(2) : '0.00';

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/70" onClick={onClose} />

      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto py-6 px-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="creative-detail-title"
          className="w-full max-w-6xl bg-[#0d0d0f] border border-white/[0.08] rounded-2xl shadow-2xl overflow-hidden"
          onClick={(e) => e.stopPropagation()}
          style={{ animation: 'modalFadeIn 0.2s ease-out' }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
            <div className="flex items-center gap-3 min-w-0">
              <p id="creative-detail-title" className="text-white font-semibold text-sm truncate" title={adName}>{adName}</p>
              <span className="text-gray-500 text-xs font-mono flex-shrink-0 hidden sm:inline">{cid}</span>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                  isVideo ? 'bg-purple-500/20 text-purple-400' : 'bg-cyan-500/20 text-cyan-400'
                }`}>{isVideo ? 'VIDEO' : 'IMAGE'}</span>
                {creative.is_winner && (
                  <span className="px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-400 text-[10px] font-bold uppercase">Winner</span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {fbUrl && (
                <a
                  href={fbUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600/20 border border-blue-600/30 text-blue-400 text-xs font-medium hover:bg-blue-600/30 transition"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  View on Facebook
                </a>
              )}
              <button
                onClick={onClose}
                aria-label="Close"
                className="w-8 h-8 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] flex items-center justify-center text-gray-400 hover:text-white transition cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Body: Two columns */}
          <div className="flex flex-col lg:flex-row">
            {/* Left: Video + Engagement Summary */}
            <div className="lg:w-[42%] p-4 sm:p-6 border-b lg:border-b-0 lg:border-r border-white/[0.06]">
              {/* Video Player */}
              <div className="relative rounded-xl overflow-hidden bg-black mb-5">
                {(videoUrl || creative.video_url) && !videoFailed ? (
                  <video
                    ref={videoRef}
                    src={videoUrl || creative.video_url}
                    poster={thumbnailUrl || creative.thumbnail_url || undefined}
                    controls
                    className="w-full rounded-xl"
                    style={{ maxHeight: 'min(420px, 50vh)' }}
                    preload="metadata"
                    onError={() => setVideoFailed(true)}
                  />
                ) : (thumbnailUrl || creative.thumbnail_url) ? (
                  <div className="relative">
                    <img
                      src={thumbnailUrl || creative.thumbnail_url}
                      alt=""
                      className="w-full rounded-xl object-contain"
                      style={{ maxHeight: 'min(420px, 50vh)' }}
                    />
                    {videoFailed && (
                      <div className="absolute bottom-2 left-2 right-2 bg-black/70 rounded-lg px-3 py-1.5 flex items-center gap-2 text-xs text-amber-400">
                        <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                        Video preview expired — showing thumbnail instead
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="w-full h-64 rounded-xl bg-gradient-to-br from-purple-900/30 to-indigo-900/20 flex flex-col items-center justify-center gap-2">
                    <Video className="w-12 h-12 text-purple-400/30" />
                    <p className="text-gray-600 text-xs">{videoFailed ? 'Video preview expired' : 'No preview available'}</p>
                  </div>
                )}
              </div>

              {/* Video Insights (if video) */}
              {isVideo && metaInsights && (
                <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 mb-5">
                  <SectionHeader icon={Play} color="text-blue-400">Video Insights</SectionHeader>
                  <div className="grid grid-cols-3 gap-2">
                    <MetricCard label="Views" value={fmtInt(mi.video_views || mi.video_3s_views)} small />
                    <MetricCard label="Hook Rate" value={`${mi.hook_rate ? (Number(mi.hook_rate) * 100).toFixed(1) : '0.0'}%`} highlight={Number(mi.hook_rate) > 0.3 ? 'text-emerald-400' : 'text-amber-400'} small />
                    <MetricCard label="3-Second Views" value={fmtInt(mi.video_3s_views)} small />
                    <MetricCard label="Complete Views" value={fmtInt(mi.video_p100)} small />
                    <MetricCard label="Hold Rate" value={`${mi.hold_rate ? (Number(mi.hold_rate) * 100).toFixed(1) : '0.0'}%`} highlight={Number(mi.hold_rate) > 0.1 ? 'text-emerald-400' : 'text-amber-400'} small />
                    <MetricCard label="Avg Watch" value={fmtDuration(mi.video_avg_time)} small />
                  </div>
                </div>
              )}

              {/* Engagement Section */}
              {metaInsights && (
                <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 mb-5">
                  <SectionHeader icon={ThumbsUp} color="text-blue-400">Engagement</SectionHeader>

                  {/* Reactions by type */}
                  <p className="text-gray-500 text-[10px] uppercase tracking-wider mb-2">Reactions by Type</p>
                  <div className="flex items-center gap-3 mb-4 overflow-x-auto pb-1">
                    <ReactionIcon type="like" count={mi.reactions_like || 0} />
                    <ReactionIcon type="love" count={mi.reactions_love || 0} />
                    <ReactionIcon type="care" count={mi.reactions_care || 0} />
                    <ReactionIcon type="haha" count={mi.reactions_haha || 0} />
                    <ReactionIcon type="wow" count={mi.reactions_wow || 0} />
                    <ReactionIcon type="sad" count={mi.reactions_sad || 0} />
                    <ReactionIcon type="angry" count={mi.reactions_angry || 0} />
                  </div>

                  {/* Engagement totals */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <MetricCard label="Reactions" value={fmtInt(mi.total_reactions)} small />
                    <MetricCard label="Clicks" value={fmtInt(mi.post_clicks || mi.clicks)} small />
                    <MetricCard label="Comments" value={fmtInt(mi.comments)} small />
                    <MetricCard label="Shares" value={fmtInt(mi.shares)} small />
                  </div>
                </div>
              )}

              {/* Distribution Signals */}
              {metaInsights && (
                <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                  <SectionHeader icon={BarChart3} color="text-cyan-400">Distribution Signals</SectionHeader>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <MetricCard label="Like Rate" value={`${likeRate}%`} small />
                    <MetricCard label="Comment Rate" value={`${commentRate}%`} small />
                    <MetricCard label="Share Rate" value={`${shareRate}%`} small />
                    <MetricCard label="CTR" value={`${metaCtr}%`} small />
                  </div>
                </div>
              )}

              {/* Loading state */}
              {metaLoading && (
                <div className="flex items-center justify-center py-8 text-gray-500 text-xs gap-2">
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  Loading Meta insights...
                </div>
              )}

              {/* Tags */}
              {(creative.angle || creative.format || creative.editor) && (
                <div className="flex flex-wrap gap-1.5 mt-5">
                  {creative.angle && <span className="px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-400 text-[10px] font-medium">{creative.angle}</span>}
                  {creative.format && <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 text-[10px] font-medium">{creative.format}</span>}
                  {creative.editor && <span className="px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-400 text-[10px] font-medium">{creative.editor}</span>}
                </div>
              )}
            </div>

            {/* Right: Metrics + Charts */}
            <div className="lg:w-[58%] p-4 sm:p-6 space-y-5">
              {/* Top highlight: CPA, Revenue, ROAS */}
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-4 text-center">
                  <p className="text-gray-500 text-[10px] uppercase tracking-wider mb-1">CPA</p>
                  <p className="text-white font-bold text-xl">{fmtMoney(cpa)}</p>
                </div>
                <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-4 text-center">
                  <p className="text-gray-500 text-[10px] uppercase tracking-wider mb-1">Revenue</p>
                  <p className="text-white font-bold text-xl">{fmtMoney(revenue)}</p>
                </div>
                <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4 text-center">
                  <p className="text-emerald-500 text-[10px] uppercase tracking-wider mb-1">ROAS</p>
                  <p className={`font-bold text-xl ${roas >= 1 ? 'text-emerald-400' : 'text-red-400'}`}>{fmtRoas(roas)}</p>
                </div>
              </div>

              {/* Purchases / CPA / AOV */}
              <div className="grid grid-cols-3 gap-2">
                <MetricCard label="Purchases" value={fmtInt(purchases)} />
                <MetricCard label="CPA" value={fmtMoney(cpa)} />
                <MetricCard label="AOV" value={fmtMoney(aov)} />
              </div>

              {/* Meta Ad Delivery */}
              <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                <SectionHeader icon={Target} color="text-blue-400">Meta Ad Delivery</SectionHeader>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
                  <MetricCard label="Impressions" value={fmtInt(mi.impressions || impressions)} small />
                  <MetricCard label="Reach" value={fmtInt(mi.reach || impressions)} small />
                  <MetricCard label="Clicks" value={fmtInt(mi.clicks || clicks)} small />
                  <MetricCard label="CTR" value={fmtPct(mi.ctr || ctr)} small />
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <MetricCard label="CPC" value={fmtMoney(mi.cpc || (spend > 0 && clicks > 0 ? spend / clicks : 0))} small />
                  <MetricCard label="CPM" value={fmtMoney(mi.cpm || cpm)} small />
                  <MetricCard label="Frequency" value={mi.frequency ? Number(mi.frequency).toFixed(2) : '—'} small />
                  <MetricCard label="Meta Spend" value={fmtMoney(mi.meta_spend || spend)} small />
                </div>
              </div>

              {/* Audience Retention (video only) */}
              {isVideo && metaInsights && (
                <RetentionChart insights={metaInsights} impressions={mi.impressions || impressions} />
              )}

              {/* ROAS & Spend Chart */}
              <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4">
                  <SectionHeader icon={TrendingUp} color="text-emerald-400">Spend & ROAS Over Time</SectionHeader>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {RANGES.map(r => (
                      <button
                        key={r.key}
                        onClick={() => setChartRange(r.key)}
                        className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                          chartRange === r.key
                            ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                            : 'text-gray-500 hover:text-gray-300 border border-transparent'
                        }`}
                      >
                        {r.label}
                      </button>
                    ))}
                  </div>
                </div>

                {twLoading ? (
                  <div className="flex items-center justify-center h-52">
                    <RefreshCw className="w-5 h-5 text-emerald-400 animate-spin" />
                  </div>
                ) : chartPoints.length > 0 ? (
                  <ResponsiveContainer width="100%" height={240}>
                    <ComposedChart data={chartPoints} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
                      <defs>
                        <linearGradient id="modalSpendGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.15} />
                          <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                      <XAxis dataKey="date" tick={{ fill: '#6b7280', fontSize: 10 }} axisLine={{ stroke: 'rgba(255,255,255,0.06)' }} tickLine={false} />
                      <YAxis yAxisId="left" tick={{ fill: '#6b7280', fontSize: 10 }} axisLine={{ stroke: 'rgba(255,255,255,0.06)' }} tickLine={false} tickFormatter={v => `$${v}`} />
                      <YAxis yAxisId="right" orientation="right" tick={{ fill: '#6b7280', fontSize: 10 }} axisLine={{ stroke: 'rgba(255,255,255,0.06)' }} tickLine={false} tickFormatter={v => `${v}x`} />
                      <Tooltip
                        contentStyle={{ background: '#1c1c1c', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, color: '#fff', fontSize: 12 }}
                        formatter={(value, name) => {
                          if (name === 'Spend') return [`$${Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, 'Spend'];
                          return [`${Number(value || 0).toFixed(2)}x`, 'ROAS'];
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: 11, color: '#9ca3af' }} />
                      <Area type="monotone" dataKey="spend" name="Spend" yAxisId="left" fill="url(#modalSpendGrad)" stroke="#3b82f6" strokeWidth={2} />
                      <Line type="monotone" dataKey="roas" name="ROAS" yAxisId="right" stroke="#10b981" strokeWidth={2} dot={{ r: 2, fill: '#10b981' }} />
                    </ComposedChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex items-center justify-center h-52 text-gray-500 text-sm">
                    No daily data available for this period.
                  </div>
                )}
              </div>

              {/* Funnel */}
              <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                <SectionHeader icon={ShoppingCart} color="text-emerald-400">Conversion Funnel</SectionHeader>
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <div className="flex items-center justify-between text-xs mb-1.5">
                      <span className="text-gray-400">Clicks</span>
                      <span className="text-white font-medium">{fmtInt(clicks)}</span>
                    </div>
                    <div className="w-full bg-white/[0.06] rounded-full h-2">
                      <div className="bg-blue-500 h-2 rounded-full" style={{ width: '100%' }} />
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-gray-600 shrink-0" />
                  <div className="flex-1">
                    <div className="flex items-center justify-between text-xs mb-1.5">
                      <span className="text-gray-400">Purchases</span>
                      <span className="text-white font-medium">{fmtInt(purchases)}</span>
                    </div>
                    <div className="w-full bg-white/[0.06] rounded-full h-2">
                      <div className="bg-emerald-500 h-2 rounded-full" style={{ width: `${clicks > 0 ? Math.min(100, (purchases / clicks) * 100) : 0}%` }} />
                    </div>
                  </div>
                </div>
                <p className="text-center text-xs text-gray-500 mt-3">
                  Click-to-Purchase Rate: <span className="text-emerald-400 font-medium">{clicks > 0 ? ((purchases / clicks) * 100).toFixed(2) : '0.00'}%</span>
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes modalFadeIn {
          from { opacity: 0; transform: translateY(20px) scale(0.98); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </>
  );
}
