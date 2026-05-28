/**
 * Brand Spy Ad Detail — full-page route.
 *
 * Replaces the IntelDrawer modal. URL: /app/brand-spy/:brandId/ads/:adId
 *
 * Layout:
 *   • Top chrome bar: "× Ad Detail" close button, breadcrumb back to brand.
 *   • Main content: same dual-column IntelDrawer panel (creative + signal)
 *     rendered with pageMode=true so it fills the viewport instead of
 *     centering as a modal.
 *
 * Future: right-side "Video Script" slide-out panel triggered by the
 * Transcribe action. Stubbed for now via scriptPanelOpen state plumbed
 * down to IntelDrawer.
 */

import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import IntelDrawer from '../../components/brandspy/IntelDrawer';

const API_BASE = '/api/v1/brand-spy';

export default function BrandSpyAdDetailPage() {
  const { brandId, adId } = useParams();
  const navigate = useNavigate();

  const [ad,         setAd]         = useState(null);
  const [brand,      setBrand]      = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);
  const [scriptOpen, setScriptOpen] = useState(false);

  // Load ad + brand in parallel
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
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
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Failed to load ad detail');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [adId, brandId]);

  // ESC closes the page
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') navigate(-1); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [navigate]);

  function handleClose() {
    // Navigate back to the brand page if we know the brandId, otherwise the
    // browser back stack (which is what `navigate(-1)` would do anyway).
    if (brandId) {
      navigate(`/app/brand-spy/${brandId}`);
    } else {
      navigate(-1);
    }
  }

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

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-hidden">
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
            scriptPanelOpen={scriptOpen}
            onScriptPanelToggle={setScriptOpen}
          />
        ) : (
          <div className="h-full flex items-center justify-center text-sm text-zinc-500">
            Ad not found.
          </div>
        )}
      </div>
    </div>
  );
}
