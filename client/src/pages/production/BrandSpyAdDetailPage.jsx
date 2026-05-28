/**
 * Brand Spy Ad Detail — full-page route.
 *
 * Replaces the IntelDrawer modal. URL: /app/brand-spy/:brandId/ads/:adId
 *
 * Layout:
 *   • Top chrome bar: "× Ad Detail" close button, breadcrumb back to brand.
 *   • Main content: dual-column IntelDrawer panel (creative + signal)
 *     rendered with pageMode=true so it fills the viewport.
 *   • Right-side VideoScriptPanel: slides in when the user clicks
 *     "Transcribe script" in the Atria AI card. Owns the transcript
 *     fetch + caching so the side panel and the in-panel card see the
 *     same state.
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import IntelDrawer from '../../components/brandspy/IntelDrawer';
import VideoScriptPanel from '../../components/brandspy/VideoScriptPanel';

const API_BASE = '/api/v1/brand-spy';

export default function BrandSpyAdDetailPage() {
  const { brandId, adId } = useParams();
  const navigate = useNavigate();

  const [ad,         setAd]         = useState(null);
  const [brand,      setBrand]      = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);

  // Script panel + transcript state — lifted here so VideoScriptPanel and
  // IntelDrawer's "Transcribe script" card share a single source of truth.
  const [scriptOpen,       setScriptOpen]       = useState(false);
  const [transcript,       setTranscript]       = useState(null);
  const [segments,         setSegments]         = useState(null);
  const [transcribing,     setTranscribing]     = useState(false);
  const [transcriptError,  setTranscriptError]  = useState(null);
  const [transcriptCached, setTranscriptCached] = useState(false);

  // Load ad + brand in parallel
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setScriptOpen(false);
    setTranscript(null);
    setSegments(null);
    setTranscriptError(null);
    setTranscriptCached(false);
    Promise.all([
      fetch(`${API_BASE}/ads/${adId}`,        { credentials: 'include' }),
      fetch(`${API_BASE}/brands/${brandId}`,  { credentials: 'include' }),
    ])
      .then(async ([adRes, brandRes]) => {
        if (!adRes.ok)    throw new Error(`Ad load failed (HTTP ${adRes.status})`);
        if (!brandRes.ok) throw new Error(`Brand load failed (HTTP ${brandRes.status})`);
        const [adBody, brandBody] = await Promise.all([adRes.json(), brandRes.json()]);
        if (cancelled) return;
        setAd(adBody.ad);
        setBrand(brandBody.brand ?? brandBody);
        // Pre-populate transcript state if the backend already has it
        // cached — the side panel will render instantly when opened.
        if (adBody.ad?.transcript) {
          setTranscript(adBody.ad.transcript);
          setSegments(Array.isArray(adBody.ad.transcriptSegments) ? adBody.ad.transcriptSegments : null);
          setTranscriptCached(true);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Failed to load ad detail');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [adId, brandId]);

  // ESC closes the page (but only when the script panel is closed —
  // otherwise ESC just closes the panel).
  useEffect(() => {
    const h = (e) => {
      if (e.key !== 'Escape') return;
      if (scriptOpen) setScriptOpen(false);
      else navigate(-1);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [navigate, scriptOpen]);

  function handleClose() {
    if (brandId) {
      navigate(`/app/brand-spy/${brandId}`);
    } else {
      navigate(-1);
    }
  }

  // The actual Whisper call. Owned by the page so script-panel state and
  // the in-drawer card state stay in sync. Cached results return instantly.
  const handleTranscribe = useCallback(async () => {
    if (!ad?.id) return;
    setScriptOpen(true);
    if (transcribing || transcript) return; // already running / done
    setTranscribing(true);
    setTranscriptError(null);
    try {
      const res = await fetch(`${API_BASE}/ads/${ad.id}/transcribe`, {
        method: 'POST',
        credentials: 'include',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Transcription failed (HTTP ${res.status})`);
      setTranscript(body.transcript || '');
      setSegments(Array.isArray(body.segments) ? body.segments : null);
      setTranscriptCached(!!body.cached);
    } catch (err) {
      setTranscriptError(err.message || 'Transcription failed');
    } finally {
      setTranscribing(false);
    }
  }, [ad?.id, transcribing, transcript]);

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ background: '#0d0d0f' }}>
      {/* Top chrome bar */}
      <div
        className="flex items-center justify-between px-5 py-3 shrink-0"
        style={{ background: '#161618', borderBottom: '1px solid #2a2a2a' }}
      >
        <button
          onClick={handleClose}
          className="flex items-center gap-2 text-sm text-zinc-300 hover:text-white transition-colors"
        >
          <X className="w-4 h-4" />
          Ad Detail
        </button>
        {brand?.name && (
          <span className="text-xs text-zinc-500">
            <button
              onClick={() => navigate(`/app/brand-spy/${brandId}`)}
              className="hover:text-zinc-300 transition-colors"
            >
              {brand.name}
            </button>
          </span>
        )}
      </div>

      {/* Body: main content + optional right-side script panel */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        <div className="flex-1 min-w-0 overflow-hidden">
          {loading ? (
            <div className="h-full flex items-center justify-center text-sm text-zinc-500">
              Loading ad detail…
            </div>
          ) : error ? (
            <div className="h-full flex flex-col items-center justify-center gap-2">
              <p className="text-sm text-rose-400">{error}</p>
              <button
                onClick={handleClose}
                className="text-xs text-zinc-400 hover:text-zinc-200 underline"
              >
                Go back
              </button>
            </div>
          ) : ad ? (
            <IntelDrawer
              ad={ad}
              brand={brand}
              onClose={handleClose}
              pageMode
              // The Atria-style "Transcribe script" card in the signal
              // column delegates to the page-level handler so state stays
              // unified across the card + the side panel.
              scriptPanelOpen={scriptOpen}
              onScriptPanelToggle={(open) => {
                if (open) handleTranscribe();
                else setScriptOpen(false);
              }}
              externalTranscript={transcript}
              externalSegments={segments}
              externalTranscribing={transcribing}
              externalTranscriptError={transcriptError}
              externalTranscriptCached={transcriptCached}
            />
          ) : (
            <div className="h-full flex items-center justify-center text-sm text-zinc-500">
              Ad not found.
            </div>
          )}
        </div>
        <VideoScriptPanel
          open={scriptOpen}
          onClose={() => setScriptOpen(false)}
          loading={transcribing}
          error={transcriptError}
          transcript={transcript}
          segments={segments}
          cached={transcriptCached}
        />
      </div>
    </div>
  );
}
