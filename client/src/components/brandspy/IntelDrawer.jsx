/**
 * IntelDrawer — full-detail modal for a single ad.
 * Opens when clicking any card in BrandDetail (Overview grid or
 * Intelligence table) or any aggregation row.
 *
 * Layout (reference screenshot):
 *  Left  ~55%  — Facebook-style ad preview (profile, body copy, creative)
 *  Right ~45%  — SIGNAL panel (rank, tier, velocity, momentum, history)
 */

import { useEffect, useRef, useState } from 'react';
import {
  X, ExternalLink, Copy, Download, Play, FileText, Loader2,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIER_COLORS = {
  BANGER: 'text-rose-400',
  CHAMP:  'text-amber-400',
  A:      'text-emerald-400',
  B:      'text-sky-400',
  C:      'text-zinc-400',
  MID:    'text-text-faint',
  TEST:   'text-text-faint',
};

const TIER_BG = {
  BANGER: 'bg-rose-500/15 border-rose-500/30',
  CHAMP:  'bg-amber-500/15 border-amber-500/30',
  A:      'bg-emerald-500/15 border-emerald-500/30',
  B:      'bg-sky-500/15 border-sky-500/30',
  C:      'bg-zinc-700/40 border-zinc-700',
  MID:    'bg-bg-elevated border-border-default',
  TEST:   'bg-bg-card border-border-subtle',
};

const TIER_ICONS = { BANGER: '🔥', CHAMP: '🏆' };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function velocityPct(velocity, currentRank) {
  if (velocity == null || !currentRank) return null;
  const prev = currentRank + velocity; // rank before the change
  if (prev <= 0 || currentRank <= 0) return null;
  // Use the larger (worse) rank as denominator so +20 and -20 show the same
  // absolute percentage — avoids the asymmetry where +20 from 50→30 shows +40%
  // but -20 from 30→50 would show -200%.
  const base = Math.max(currentRank, prev);
  return Math.round((velocity / base) * 100);
}

function computeMomentum(v7d, v21d) {
  if (v7d == null && v21d == null) return null;
  return +(((v7d || 0) * 2 + (v21d || 0)) / 3).toFixed(1);
}

function computeQuality(ad) {
  const fields = [
    ad.thumbnailUrl,
    ad.headline,
    ad.bodyText,
    ad.startDate,
    ad.tier,
    ad.linkUrl,
    ad.currentRank,
    ad.displayFormat,
    ad.pageName,
  ];
  const score = Math.round((fields.filter(Boolean).length / fields.length) * 100);
  let label = 'Low';
  let color = 'text-red-400';
  let barColor = 'bg-red-500';
  if (score >= 86) { label = 'Excellent'; color = 'text-emerald-400'; barColor = 'bg-emerald-500'; }
  else if (score >= 71) { label = 'Good'; color = 'text-sky-400'; barColor = 'bg-sky-500'; }
  else if (score >= 51) { label = 'Moderate'; color = 'text-amber-400'; barColor = 'bg-amber-500'; }
  else if (score >= 31) { label = 'Fair'; color = 'text-orange-400'; barColor = 'bg-orange-500'; }
  return { score, label, color, barColor };
}

function detectTechStack(url) {
  if (!url) return [];
  const stack = [];
  if (url.includes('myshopify.com') || url.includes('/products/') || url.includes('shopify')) stack.push('Shopify');
  if (url.includes('clickfunnels')) stack.push('ClickFunnels');
  if (url.includes('kajabi')) stack.push('Kajabi');
  if (url.includes('kartra')) stack.push('Kartra');
  if (url.includes('leadpages')) stack.push('LeadPages');
  if (url.includes('gohighlevel') || url.includes('highlevel')) stack.push('GoHighLevel');
  return stack;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PageProfilePic({ ad, pages, size = 40 }) {
  const [failed, setFailed] = useState(false);
  // Try to find the page profile pic from the brand pages list
  const page = pages?.find((p) => p.metaPageId === ad.metaPageId);
  const src = page?.pageProfilePic;

  const colors = [
    'bg-violet-500/30 text-violet-300',
    'bg-sky-500/30 text-sky-300',
    'bg-emerald-500/30 text-emerald-300',
    'bg-amber-500/30 text-amber-300',
    'bg-rose-500/30 text-rose-300',
  ];
  const color = colors[(ad.pageName?.charCodeAt(0) ?? 0) % colors.length];

  if (src && !failed) {
    return (
      <img
        src={src} alt=""
        className="rounded-full object-cover shrink-0"
        style={{ width: size, height: size }}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <div
      className={`rounded-full flex items-center justify-center font-bold shrink-0 ${color}`}
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {(ad.pageName ?? '?').charAt(0).toUpperCase()}
    </div>
  );
}

function truncateAtWord(text, maxChars) {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  // Only snap to word boundary if the space is within the last 25% of the slice
  // (avoids a very short truncation if the last word is long).
  return lastSpace > maxChars * 0.75 ? cut.slice(0, lastSpace) : cut;
}

function ExpandableText({ text, maxChars = 200 }) {
  const [expanded, setExpanded] = useState(false);
  if (!text) return null;
  if (text.length <= maxChars) return <p className="text-sm text-[#e4e6eb] leading-relaxed">{text}</p>;
  return (
    <div>
      <p className="text-sm text-[#e4e6eb] leading-relaxed">
        {expanded ? text : `${truncateAtWord(text, maxChars)}…`}
        {' '}
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-[#1877f2] hover:underline text-sm font-medium"
        >
          {expanded ? 'see less' : 'see more'}
        </button>
      </p>
    </div>
  );
}

function SignalMetricCard({ label, children, className = '' }) {
  return (
    <div className={`rounded-xl p-3 flex flex-col gap-1 ${className}`} style={{ background: '#252525', border: '1px solid #333' }}>
      <p className="text-[10px] uppercase tracking-wider font-medium" style={{ color: '#6b7280' }}>{label}</p>
      {children}
    </div>
  );
}

function RankHistoryCard({ label, value }) {
  return (
    <div className="flex-1 rounded-lg py-2 px-1 text-center" style={{ background: '#1e1e1e', border: '1px solid #2a2a2a' }}>
      <p className="text-[9px] uppercase tracking-wider mb-1" style={{ color: '#6b7280' }}>{label}</p>
      <p className="text-sm font-bold text-white tabular-nums">{value ?? '—'}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main IntelDrawer
// ---------------------------------------------------------------------------

// Currently-active heuristic — kept in sync with BrandDetail.isAdActive and
// the backend status=ACTIVE SQL clause. is_active flag is unreliable while
// the worker spuriously flips it; last_seen_at within 2 days is the source
// of truth for "we just saw this ad in the ad library".
function isAdActive(ad) {
  if (ad?.isActive === true) return true;
  if (!ad?.lastSeenAt) return false;
  return Date.now() - new Date(ad.lastSeenAt).getTime() <= 2 * 86400000;
}

function liveActiveDays(ad) {
  // Three signals, pick the highest:
  //   1. totalActiveTime (seconds, from upstream API)
  //   2. activeDays (whole-day count, from upstream API)
  //   3. date-range: startDate → end-marker, where end-marker is now (active),
  //      endDate (ended w/ date), or lastSeenAt (ended, no end date)
  // Falling back through all three means we don't render "0d" just because
  // the brand.is_active flag is stale (separate worker bug) — we still have
  // startDate + lastSeenAt to reason about.
  const tatDays  = ad.totalActiveTime != null ? Math.floor(ad.totalActiveTime / 86400) : null;
  const apiDays  = ad.activeDays != null ? ad.activeDays : null;

  let rangeDays = null;
  if (ad.startDate) {
    const startMs = new Date(ad.startDate).getTime();
    let endMs = null;
    if (ad.isActive)        endMs = Date.now();
    else if (ad.endDate)    endMs = new Date(ad.endDate).getTime();
    else if (ad.lastSeenAt) endMs = new Date(ad.lastSeenAt).getTime();
    if (endMs != null && endMs > startMs) {
      rangeDays = Math.floor((endMs - startMs) / 86400000);
    }
  }

  const candidates = [tatDays, apiDays, rangeDays].filter((v) => v != null && v > 0);
  return candidates.length ? Math.max(...candidates) : null;
}

/**
 * @param {object}  props
 * @param {object}  props.ad      Ad detail (from getAdDetail / listAds).
 * @param {object}  props.brand   Owning brand record (provides pages[] for profile pics).
 * @param {() => void} props.onClose
 * @param {boolean} [props.pageMode=false]
 *   false → renders as a centered modal with backdrop (original UX).
 *   true  → renders inline as a full-viewport page; caller owns the chrome,
 *           the backdrop is skipped, sizing fills the parent.
 * @param {boolean} [props.scriptPanelOpen=false]
 *   When pageMode is true, controls whether the right-side Video Script
 *   panel is visible. Click "Transcribe script" to open. Owned by the
 *   page wrapper so the route can persist the state across re-renders.
 * @param {(open: boolean) => void} [props.onScriptPanelToggle]
 */
export default function IntelDrawer({
  ad, brand, onClose,
  pageMode = false,
  scriptPanelOpen = false,
  onScriptPanelToggle,
  // When pageMode is true the page wrapper owns transcript state and
  // passes the live values down via these `external*` props. The drawer
  // then renders its in-panel "Transcribe script" card off those values
  // instead of running its own fetch. In modal mode all externals are
  // undefined and the drawer falls back to its self-managed state.
  externalTranscript,
  externalSegments,
  externalTranscribing,
  externalTranscriptError,
  externalTranscriptCached,
}) {
  // ESC to close
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const [copied, setCopied]           = useState(false);
  const [videoStarted, setVideoStarted] = useState(false);
  const videoRef = useRef(null);

  // Transcribe state — when the user clicks "Transcribe", we POST to the
  // backend which downloads the video and runs OpenAI Whisper on it. Result
  // is cached in brand_spy.ads.transcript so subsequent clicks are instant.
  const [internalTranscript,         setTranscript]         = useState(null);
  const [internalTranscriptSegments, setTranscriptSegments] = useState(null);
  const [internalTranscribing,       setTranscribing]       = useState(false);
  const [internalTranscriptError,    setTranscriptError]    = useState(null);
  const [internalTranscriptCached,   setTranscriptCached]   = useState(false);

  // In pageMode the page wrapper owns the state — use the external props.
  // In modal mode (or if the wrapper omitted them) fall back to internal.
  const transcript        = externalTranscript        !== undefined ? externalTranscript        : internalTranscript;
  const transcriptSegments = externalSegments        !== undefined ? externalSegments         : internalTranscriptSegments;
  const transcribing      = externalTranscribing     !== undefined ? externalTranscribing     : internalTranscribing;
  const transcriptError   = externalTranscriptError  !== undefined ? externalTranscriptError  : internalTranscriptError;
  const transcriptCached  = externalTranscriptCached !== undefined ? externalTranscriptCached : internalTranscriptCached;

  // Hydrate from ad.transcript if the backend already returned a cached
  // transcript with getAdDetail — saves a click in pageMode where the page
  // wrapper does that fetch on mount.
  useEffect(() => {
    if (ad?.transcript) {
      setTranscript(ad.transcript);
      setTranscriptSegments(Array.isArray(ad.transcriptSegments) ? ad.transcriptSegments : null);
      setTranscriptCached(true);
    }
  }, [ad?.id, ad?.transcript, ad?.transcriptSegments]);

  // Reset transient state whenever the modal is opened on a different ad
  useEffect(() => {
    setVideoStarted(false);
    setTranscript(null);
    setTranscriptSegments(null);
    setTranscribing(false);
    setTranscriptError(null);
    setTranscriptCached(false);
  }, [ad?.id]);

  async function handleTranscribe() {
    if (!ad?.id) return;
    // In pageMode the page owns both the state and the fetch — just toggle
    // the side panel open and let the wrapper do the work. The page's
    // onScriptPanelToggle(true) callback triggers its own handleTranscribe.
    if (pageMode) {
      if (onScriptPanelToggle) onScriptPanelToggle(true);
      return;
    }
    if (transcribing) return;
    setTranscribing(true);
    setTranscriptError(null);
    try {
      const res = await fetch(`/api/v1/brand-spy/ads/${ad.id}/transcribe`, {
        method: 'POST',
        credentials: 'include',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Transcription failed (HTTP ${res.status})`);
      setTranscript(body.transcript || '');
      setTranscriptSegments(Array.isArray(body.segments) ? body.segments : null);
      setTranscriptCached(!!body.cached);
    } catch (err) {
      setTranscriptError(err.message || 'Transcription failed');
    } finally {
      setTranscribing(false);
    }
  }

  async function copyTranscript() {
    if (!transcript) return;
    await navigator.clipboard.writeText(transcript).catch(() => {});
  }

  if (!ad) return null;

  const pages = brand?.pages ?? [];
  const activeDays = liveActiveDays(ad);
  const quality = computeQuality(ad);
  const momentum = computeMomentum(ad.velocity7d, ad.velocity21d);
  const pct7d  = velocityPct(ad.velocity7d,  ad.currentRank);
  const pct21d = velocityPct(ad.velocity21d, ad.currentRank);
  const techStack = detectTechStack(ad.linkUrl);

  const adLibUrl = ad.adArchiveId
    ? `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=US&id=${ad.adArchiveId}`
    : null;

  async function handleCopy() {
    const text = [ad.headline, ad.bodyText].filter(Boolean).join('\n\n');
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleSave() {
    const url = ad.videoUrl || ad.thumbnailUrl;
    if (!url) return;
    const ext = ad.videoUrl ? '.mp4' : '.jpg';
    const filename = `ad-${ad.adArchiveId || 'creative'}${ext}`;
    // Attempt blob fetch so the browser saves rather than navigating (handles CDN CORS).
    // Fall back to window.open if fetch fails (CORS block, etc.).
    try {
      const res  = await fetch(url);
      const blob = await res.blob();
      const burl = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = burl; a.download = filename;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(burl), 1000);
    } catch {
      window.open(url, '_blank');
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  // Outer chrome: in modal mode we render a backdrop + centered card; in page
  // mode we just render the inner panel filling its parent (the page route
  // owns the chrome around it).
  const innerStyle = pageMode
    ? { background: '#161618', minHeight: 0, height: '100%' }
    : { maxWidth: 1080, maxHeight: '88vh', background: '#161618', border: '1px solid #2a2a2a' };
  const innerClass = pageMode
    ? 'relative flex w-full rounded-none overflow-hidden'
    : 'pointer-events-auto relative flex w-full rounded-2xl overflow-hidden shadow-2xl';

  const content = (
    <div className={innerClass} style={innerStyle} onClick={(e) => e.stopPropagation()}>

          {/* ======================================================= */}
          {/* LEFT PANEL — Ad Preview                                   */}
          {/* ======================================================= */}
          <div
            className="flex flex-col overflow-y-auto"
            style={{ width: '55%', borderRight: '1px solid #2a2a2a', background: '#111113' }}
          >
            {/* Post header */}
            <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="relative shrink-0">
                  <PageProfilePic ad={ad} pages={pages} size={42} />
                  {/* Blue verified/sponsored dot */}
                  <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-[#1877f2] flex items-center justify-center ring-2 ring-[#111113]">
                    <span className="text-white text-[8px] font-bold">f</span>
                  </div>
                </div>
                <div className="min-w-0">
                  <p className="text-[15px] font-semibold text-white truncate">{ad.pageName ?? 'Unknown Page'}</p>
                  <p className="text-xs mt-0.5" style={{ color: '#9ca3af' }}>
                    Sponsored
                    {ad.startDate && (
                      <> · Launched {new Date(ad.startDate).toISOString().split('T')[0]}</>
                    )}
                    {activeDays != null && (
                      <> · <span className="text-emerald-400 font-medium">{activeDays}d active</span></>
                    )}
                  </p>
                </div>
              </div>
              {adLibUrl && (
                <a
                  href={adLibUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors"
                  style={{ background: '#2a2a2e', color: '#9ca3af', border: '1px solid #3a3a3e' }}
                  onMouseEnter={e => e.currentTarget.style.color = '#fff'}
                  onMouseLeave={e => e.currentTarget.style.color = '#9ca3af'}
                >
                  Ad Library
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>

            {/* Body copy */}
            {(ad.headline || ad.bodyText) && (
              <div className="px-5 pb-3 space-y-2">
                {ad.headline && (
                  <ExpandableText text={ad.headline} maxChars={120} />
                )}
                {ad.bodyText && ad.bodyText !== ad.headline && (
                  <ExpandableText text={ad.bodyText} maxChars={200} />
                )}
                <button
                  onClick={handleCopy}
                  className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-colors mt-1"
                  style={{ background: '#2a2a2e', color: copied ? '#34d399' : '#9ca3af', border: '1px solid #3a3a3e' }}
                >
                  <Copy className="w-3 h-3" />
                  {copied ? 'Copied!' : 'Copy text'}
                </button>
              </div>
            )}

            {/* Creative — container shrink-wraps to the image/video so no dark
                letterbox space appears around the actual creative. */}
            <div className="relative mx-5 mb-0 rounded-xl overflow-hidden" style={{ border: '1px solid #2a2a2a' }}>
              {/* Save button */}
              <button
                onClick={handleSave}
                className="absolute bottom-3 right-3 z-10 flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors"
                style={{ background: 'rgba(0,0,0,0.7)', color: '#fff', backdropFilter: 'blur(4px)', border: '1px solid rgba(255,255,255,0.15)' }}
              >
                <Download className="w-3 h-3" />
                Save
              </button>

              {/* Media — block + w-full + max-h:70vh sizes the element to the
                  image's natural aspect inside the panel without letterboxing.
                  The container shrink-wraps because there's no flex-1 / min-h. */}
              {ad.videoUrl ? (
                <div className="relative">
                  <video
                    ref={videoRef}
                    src={ad.videoUrl}
                    poster={ad.thumbnailUrl ?? undefined}
                    controls
                    className="block w-full"
                    style={{ maxHeight: '70vh', background: '#000' }}
                    onPlay={() => setVideoStarted(true)}
                  />
                  {/* Transcribe pill — only rendered in modal mode. In
                      pageMode the Atria-style "Transcribe script" card in
                      the signal column is the primary trigger and opens
                      the right-side Video Script panel. */}
                  {!pageMode && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleTranscribe(); }}
                      disabled={transcribing}
                      className="absolute top-3 right-3 z-20 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-opacity disabled:opacity-70"
                      style={{
                        background: '#f97316',
                        color: '#fff',
                        boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
                      }}
                      title="Transcribe video with OpenAI Whisper"
                    >
                      {transcribing ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          Transcribing…
                        </>
                      ) : (
                        <>
                          <FileText className="w-3.5 h-3.5" />
                          {transcript ? 'View Transcript' : 'Transcribe'}
                        </>
                      )}
                    </button>
                  )}
                  {/* Play-button overlay — visible until the user starts
                      the video so they have a clear "this is playable"
                      affordance. Native controls take over after play. */}
                  {!videoStarted && (
                    <button
                      type="button"
                      onClick={() => {
                        const v = videoRef.current;
                        if (v) {
                          v.play().catch(() => {});
                          setVideoStarted(true);
                        }
                      }}
                      className="absolute inset-0 flex items-center justify-center transition-opacity hover:bg-black/15"
                      title="Play video"
                    >
                      <div
                        className="w-16 h-16 rounded-full flex items-center justify-center backdrop-blur-sm transition-transform hover:scale-110"
                        style={{ background: 'rgba(0,0,0,0.65)', border: '2px solid rgba(255,255,255,0.25)' }}
                      >
                        <Play className="w-7 h-7 text-white ml-1" fill="white" />
                      </div>
                    </button>
                  )}
                </div>
              ) : ad.thumbnailUrl ? (
                <img
                  src={ad.thumbnailUrl}
                  alt=""
                  className="block w-full"
                  style={{ maxHeight: '70vh', objectFit: 'contain' }}
                />
              ) : (
                /* No creative stored (common for DCO/collation ads — each variant
                   has its own image that isn't captured in the snapshot).
                   Point users to Meta Ad Library to see the actual creative. */
                <div className="w-full flex flex-col items-center justify-center gap-3 py-14" style={{ background: '#0d0d0f' }}>
                  <p className="text-sm font-medium" style={{ color: '#6b7280' }}>Creative not available</p>
                  <p className="text-xs text-center max-w-[220px]" style={{ color: '#4b5563' }}>
                    This ad has multiple variants (DCO). View the full creative on Meta Ad Library.
                  </p>
                  {adLibUrl && (
                    <a
                      href={adLibUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium mt-1"
                      style={{ background: '#1877f2', color: '#fff' }}
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      View on Meta Ad Library
                    </a>
                  )}
                </div>
              )}
            </div>

            {/* Transcript panel below the creative — modal-only. The
                pageMode route renders the transcript in a dedicated
                right-side Video Script panel instead, so we skip this
                block to avoid showing the same content twice. */}
            {!pageMode && ad.videoUrl && (transcript || transcriptError) && (
              <div
                className="mx-5 mt-3 rounded-xl px-4 py-3"
                style={{ background: '#1a1a1c', border: '1px solid #2a2a2a' }}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <FileText className="w-3.5 h-3.5 text-orange-400" />
                    <span className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
                      Transcript
                    </span>
                    {transcriptCached && (
                      <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                        Cached
                      </span>
                    )}
                  </div>
                  {transcript && (
                    <button
                      onClick={copyTranscript}
                      className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-200 transition-colors"
                      title="Copy transcript"
                    >
                      <Copy className="w-3 h-3" /> Copy
                    </button>
                  )}
                </div>
                {transcriptError ? (
                  <p className="text-xs text-rose-400 leading-relaxed">
                    {transcriptError}
                  </p>
                ) : (
                  <p
                    className="text-sm text-zinc-200 leading-relaxed whitespace-pre-wrap"
                    style={{ maxHeight: '24vh', overflowY: 'auto' }}
                  >
                    {transcript}
                  </p>
                )}
              </div>
            )}

            {/* Ad destination bar */}
            {(ad.linkUrl || ad.ctaText) && (
              <div
                className="mx-5 mt-0 mb-5 flex items-center justify-between px-4 py-3 rounded-b-xl"
                style={{ background: '#1e1e20', border: '1px solid #2a2a2a', borderTop: 'none' }}
              >
                <div className="min-w-0">
                  {ad.linkUrl && (
                    <p className="text-[11px] uppercase tracking-wide font-medium" style={{ color: '#6b7280' }}>
                      {(() => {
                        try { return new URL(ad.linkUrl.startsWith('http') ? ad.linkUrl : `https://${ad.linkUrl}`).hostname.replace('www.', '').toUpperCase(); }
                        catch { return ad.linkUrl.split('/')[0].toUpperCase(); }
                      })()}
                    </p>
                  )}
                  {ad.headline && (
                    <p className="text-sm font-semibold text-white truncate mt-0.5">{ad.headline}</p>
                  )}
                </div>
                {ad.ctaText && (
                  ad.linkUrl ? (
                    <a
                      href={ad.linkUrl.startsWith('http') ? ad.linkUrl : `https://${ad.linkUrl}`}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0 ml-3 px-3 py-1.5 rounded-lg text-xs font-semibold transition-opacity hover:opacity-80"
                      style={{ background: '#3a3b3c', color: '#e4e6eb' }}>
                      {ad.ctaText}
                    </a>
                  ) : (
                    <div className="shrink-0 ml-3 px-3 py-1.5 rounded-lg text-xs font-semibold"
                      style={{ background: '#3a3b3c', color: '#e4e6eb' }}>
                      {ad.ctaText}
                    </div>
                  )
                )}
              </div>
            )}
          </div>

          {/* ======================================================= */}
          {/* RIGHT PANEL — SIGNAL                                      */}
          {/* ======================================================= */}
          <div
            className="flex flex-col overflow-y-auto"
            style={{ width: pageMode ? '40%' : '45%', background: '#161618' }}
          >
            {/* SIGNAL header */}
            <div className="flex items-center justify-between px-5 pt-5 pb-4 shrink-0">
              <p className="text-[11px] uppercase tracking-[0.15em] font-semibold" style={{ color: '#6b7280' }}>
                Signal
              </p>
              <div className="flex items-center gap-1">
                {/* In pageMode the page wrapper renders the chrome close; this
                    in-panel × would just be a duplicate. */}
                {!pageMode && (
                  <button onClick={onClose} className="p-1.5 rounded-lg transition-colors"
                    style={{ color: '#6b7280' }}
                    onMouseEnter={e => e.currentTarget.style.color = '#fff'}
                    onMouseLeave={e => e.currentTarget.style.color = '#6b7280'}
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>

            <div className="px-5 pb-5 space-y-3 flex-1">
              {/* Atria-style "Atria AI" card — only in pageMode. Triggers the
                  right-side Video Script panel. Disabled when the ad has no
                  video URL (e.g. image / DCO with page-logo fallback). */}
              {pageMode && (
                <div
                  className="rounded-xl p-3.5 flex flex-col gap-2.5"
                  style={{ background: '#1c1c1f', border: '1px solid #2a2a2a' }}
                >
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] uppercase tracking-[0.15em] font-semibold" style={{ color: '#9ca3af' }}>
                      Atria AI
                    </p>
                    <span className="text-[10px] text-zinc-500 tabular-nums">
                      {ad.videoUrl ? 'whisper-1' : 'no video'}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (!ad.videoUrl) return;
                      handleTranscribe();
                    }}
                    disabled={!ad.videoUrl || transcribing}
                    className="flex flex-col items-center justify-center gap-1.5 py-3 rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{
                      background: ad.videoUrl ? '#ffedd5' : '#2a2a2a',
                      color: ad.videoUrl ? '#9a3412' : '#6b7280',
                      border: ad.videoUrl ? '1px solid #fed7aa' : '1px solid #333',
                    }}
                    title={ad.videoUrl ? 'Transcribe with OpenAI Whisper' : 'This ad has no video to transcribe'}
                  >
                    {transcribing ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      <FileText className="w-5 h-5" />
                    )}
                    <span className="text-xs font-semibold">
                      {transcribing
                        ? 'Transcribing…'
                        : transcript
                          ? 'View transcript'
                          : 'Transcribe script'}
                    </span>
                  </button>
                  {transcriptError && (
                    <p className="text-[11px] text-rose-400 leading-snug">
                      {transcriptError}
                    </p>
                  )}
                </div>
              )}

              {/* Metric cards row: RANK · TIER · STATUS · ACTIVE */}
              <div className="grid grid-cols-4 gap-2">
                {/* RANK */}
                <SignalMetricCard label="Rank">
                  <p className="text-2xl font-bold text-white leading-none">
                    {ad.currentRank != null ? `#${ad.currentRank}` : '—'}
                  </p>
                  {ad.poolSize != null && (
                    <p className="text-[11px]" style={{ color: '#6b7280' }}>of {ad.poolSize}</p>
                  )}
                </SignalMetricCard>

                {/* TIER */}
                <SignalMetricCard label="Tier">
                  {ad.tier ? (
                    <p className={`text-xl font-bold leading-none ${TIER_COLORS[ad.tier] ?? 'text-white'}`}>
                      {TIER_ICONS[ad.tier] ? `${TIER_ICONS[ad.tier]} ` : ''}{ad.tier}
                    </p>
                  ) : (
                    <p className="text-xl font-bold text-text-faint leading-none">—</p>
                  )}
                </SignalMetricCard>

                {/* STATUS */}
                <SignalMetricCard label="Status">
                  {(() => {
                    const active = isAdActive(ad);
                    return (
                      <div className="flex items-center gap-1.5">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${active ? 'bg-emerald-400' : 'bg-zinc-500'}`} />
                        <span className={`text-sm font-semibold ${active ? 'text-emerald-400' : 'text-text-faint'}`}>
                          {active ? 'Active' : 'Ended'}
                        </span>
                      </div>
                    );
                  })()}
                </SignalMetricCard>

                {/* ACTIVE days */}
                <SignalMetricCard label="Active">
                  <p className={`text-2xl font-bold leading-none ${(activeDays ?? 0) >= 30 ? 'text-emerald-400' : 'text-white'}`}>
                    {activeDays != null ? `${activeDays}d` : '—'}
                  </p>
                </SignalMetricCard>
              </div>

              {/* DATA QUALITY */}
              <div className="rounded-xl p-4" style={{ background: '#252525', border: '1px solid #333' }}>
                <p className="text-[10px] uppercase tracking-wider mb-2 font-medium" style={{ color: '#6b7280' }}>
                  Data Quality
                </p>
                <div className="flex items-end justify-between mb-2">
                  <p className={`text-3xl font-bold ${quality.color}`}>{quality.score}%</p>
                  <p className="text-xs pb-1" style={{ color: '#6b7280' }}>{quality.label}</p>
                </div>
                <div className="h-1 rounded-full overflow-hidden" style={{ background: '#333' }}>
                  <div
                    className={`h-full rounded-full transition-all ${quality.barColor}`}
                    style={{ width: `${quality.score}%` }}
                  />
                </div>
              </div>

              {/* VELOCITY 7D + 21D */}
              <div className="grid grid-cols-2 gap-2">
                <SignalMetricCard label="Velocity 7D">
                  {ad.velocity7d != null ? (
                    <>
                      <p className={`text-xl font-bold leading-none ${ad.velocity7d > 0 ? 'text-emerald-400' : ad.velocity7d < 0 ? 'text-rose-400' : 'text-text-faint'}`}>
                        {ad.velocity7d > 0 ? `+${ad.velocity7d} ↑` : ad.velocity7d < 0 ? `${ad.velocity7d} ↓` : `0 →`}
                      </p>
                      {pct7d != null && (
                        <p className="text-[11px] mt-1" style={{ color: '#6b7280' }}>
                          {pct7d > 0 ? `+${pct7d}` : pct7d}% change
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="text-xl font-bold text-text-faint leading-none">—</p>
                  )}
                </SignalMetricCard>

                <SignalMetricCard label="Velocity 21D">
                  {ad.velocity21d != null ? (
                    <>
                      <p className={`text-xl font-bold leading-none ${ad.velocity21d > 0 ? 'text-emerald-400' : ad.velocity21d < 0 ? 'text-rose-400' : 'text-text-faint'}`}>
                        {ad.velocity21d > 0 ? `+${ad.velocity21d} ↑` : ad.velocity21d < 0 ? `${ad.velocity21d} ↓` : `0 →`}
                      </p>
                      {pct21d != null && (
                        <p className="text-[11px] mt-1" style={{ color: '#6b7280' }}>
                          {pct21d > 0 ? `+${pct21d}` : pct21d}% change
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="text-xl font-bold text-text-faint leading-none">—</p>
                  )}
                </SignalMetricCard>
              </div>

              {/* MOMENTUM */}
              <div className="rounded-xl p-4 text-center" style={{ background: '#252525', border: '1px solid #333' }}>
                <p className="text-[10px] uppercase tracking-wider mb-2 font-medium" style={{ color: '#6b7280' }}>
                  Momentum
                </p>
                {momentum != null ? (
                  <p className={`text-3xl font-bold ${momentum > 0 ? 'text-emerald-400' : momentum < 0 ? 'text-rose-400' : 'text-text-faint'}`}>
                    {momentum > 0 ? `+${momentum}` : momentum}
                  </p>
                ) : (
                  <p className="text-3xl font-bold text-text-faint">—</p>
                )}
              </div>

              {/* RANK HISTORY */}
              <div>
                <p className="text-[10px] uppercase tracking-wider mb-2 font-medium" style={{ color: '#6b7280' }}>
                  Rank History
                </p>
                <div className="flex gap-1.5">
                  <RankHistoryCard label="21D" value={ad.rank21d} />
                  <RankHistoryCard label="7D"  value={ad.rank7d} />
                  <RankHistoryCard label="3D"  value={ad.rank3d} />
                  <RankHistoryCard label="NOW" value={ad.currentRank} />
                </div>
              </div>

              {/* CHARTS — placeholder */}
              <div>
                <p className="text-[10px] uppercase tracking-wider mb-2 font-medium" style={{ color: '#6b7280' }}>
                  Charts
                </p>
                <div className="rounded-xl py-8 flex items-center justify-center text-xs"
                  style={{ background: '#1e1e20', border: '1px solid #2a2a2a', color: '#4b5563' }}>
                  Coming soon
                </div>
              </div>

              {/* TECH STACK */}
              {techStack.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider mb-2 font-medium" style={{ color: '#6b7280' }}>
                    Tech Stack
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {techStack.map((t) => (
                      <span key={t}
                        className="px-3 py-1 rounded-lg text-xs font-medium"
                        style={{ background: '#252525', border: '1px solid #3a3a3a', color: '#e4e6eb' }}>
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Meta Ad Library link */}
              {adLibUrl ? (
                <a
                  href={adLibUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-center gap-1.5 w-full py-2.5 rounded-xl text-xs font-medium transition-colors"
                  style={{ background: '#1877f2', color: '#fff' }}
                  onMouseEnter={e => e.currentTarget.style.opacity = '0.9'}
                  onMouseLeave={e => e.currentTarget.style.opacity = '1'}
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  View on Meta Ad Library
                </a>
              ) : (
                <div
                  className="flex items-center justify-center gap-1.5 w-full py-2.5 rounded-xl text-xs font-medium opacity-40"
                  style={{ background: '#1877f2', color: '#fff', cursor: 'not-allowed' }}
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  No Ad Library ID
                </div>
              )}
            </div>
          </div>
    </div>
  );

  if (pageMode) {
    // Page route owns its own chrome; we just render the inner panel.
    return content;
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm"
        onClick={onClose}
      />
      {/* Modal container */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        {content}
      </div>
    </>
  );
}
