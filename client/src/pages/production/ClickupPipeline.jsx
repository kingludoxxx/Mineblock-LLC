import { useRef, useState, useEffect } from 'react';
import { ExternalLink, RefreshCw, AlertCircle } from 'lucide-react';

const PIPELINE_URL = 'https://mineblock-video-launcher.onrender.com';
// Admin access token — the pipeline tool treats visitors without it as
// editors (pipeline-only). The dashboard is the admin surface, so the iframe
// always passes it. No sign-in dialog is ever shown either way.
const PIPELINE_EMBED_URL = `${PIPELINE_URL}/?access=mb-bdabeb1589f7160234f33dfb6118ed57`;
const HEALTH_URL   = `${PIPELINE_URL}/health`;
const POLL_MS      = 15_000;

export default function ClickupPipeline() {
  const iframeRef   = useRef(null);
  const [loading, setLoading]         = useState(true);
  const [serviceDown, setServiceDown] = useState(false);

  /** Force a fresh iframe load */
  function triggerLoad() {
    setLoading(true);
    setServiceDown(false);
    if (iframeRef.current) iframeRef.current.src = PIPELINE_EMBED_URL;
  }

  /**
   * Health-check loop.
   *
   * Fires immediately on mount:
   *   - If healthy  → force-reload the iframe so we never show a stale page
   *     left over from a deploy restart.
   *   - If unhealthy → show the "restarting" overlay and keep polling.
   *
   * While running:
   *   - Service goes down → overlay appears.
   *   - Service recovers  → iframe auto-reloads, overlay disappears.
   */
  useEffect(() => {
    let cancelled  = false;
    let prevWasDown = false; // track last known state

    async function ping() {
      let healthy = false;
      try {
        const r = await fetch(HEALTH_URL, { cache: 'no-store' });
        healthy = r.ok;
      } catch { /* network error → treat as down */ }

      if (cancelled) return;

      if (healthy) {
        // First ping (prevWasDown = false, initial mount) always reloads to flush
        // any stale/blank page from a previous deploy restart.
        if (prevWasDown !== true) {
          // reload on: initial mount (undefined→healthy) OR recovery (false→healthy)
          triggerLoad();
        }
        prevWasDown = true; // means "last state was healthy"
        setServiceDown(false);
      } else {
        prevWasDown = false; // means "last state was down"
        setServiceDown(true);
      }
    }

    ping();
    const id = setInterval(ping, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800 bg-[#0f1117] flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 font-medium tracking-wide uppercase">
            ClickUp Pipeline
          </span>
          {serviceDown && (
            <span className="flex items-center gap-1 text-xs text-yellow-500">
              <AlertCircle size={12} /> Reconnecting…
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={triggerLoad}
            className="text-gray-500 hover:text-gray-300 transition p-1 rounded"
            title="Reload"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
          <a
            href={PIPELINE_EMBED_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-500 hover:text-gray-300 transition p-1 rounded"
            title="Open in new tab"
          >
            <ExternalLink size={14} />
          </a>
        </div>
      </div>

      {/* Iframe + overlays */}
      <div className="relative flex-1">

        {/* Service-down overlay */}
        {serviceDown && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-[#0f1117]">
            <AlertCircle size={28} className="text-yellow-500" />
            <div className="text-center">
              <p className="text-sm text-gray-300 mb-1">Pipeline is restarting</p>
              <p className="text-xs text-gray-500">Will reconnect automatically</p>
            </div>
            <button
              onClick={triggerLoad}
              className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition"
            >
              Retry now
            </button>
          </div>
        )}

        {/* Loading spinner (only shown when NOT in service-down state) */}
        {!serviceDown && loading && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-[#0f1117]">
            <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-xs text-gray-500">Loading pipeline…</span>
          </div>
        )}

        <iframe
          ref={iframeRef}
          src={PIPELINE_EMBED_URL}
          title="ClickUp Pipeline"
          className="w-full h-full border-0"
          onLoad={() => setLoading(false)}
          allow="fullscreen"
        />
      </div>
    </div>
  );
}
