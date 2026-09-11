// CLICKUP PIPELINE — the store's video-launcher tool, embedded.
//
// W9 / R20. This file used to hold two literals: the launcher's host and its
// admin access token, the second of them appended to the iframe src as
// `?access=…`. Both were compiled into the public javascript bundle, so the
// token was readable by anyone who could fetch the built asset, and the host
// was a per-store functional URL in shared engine code (R5 / R15) — on any
// other store this page pointed at the first store's tool.
//
// There is now NO url and NO token in this file, and nothing here can learn
// either one. The page asks its own server two questions:
//
//   GET /api/v1/video-launcher/status     → { configured, healthy }
//   GET /api/v1/video-launcher/open/app   → 302 into the launcher, token
//                                           attached server-side
//
// The iframe's src is that second SAME-ORIGIN path, so the browser carries the
// operator's own session cookie to it; the server checks authentication and
// brief-pipeline:access before it redirects anywhere. A store with no launcher
// configured gets the disabled panel below — never a broken frame, never a
// failed request, nothing in the console.
import { useRef, useState, useEffect, useCallback } from 'react';
import { ExternalLink, RefreshCw, AlertCircle, PlugZap } from 'lucide-react';
import api from '../../services/api';

// Same-origin paths. Not a host, not a token, nothing store-specific.
const EMBED_PATH = '/api/v1/video-launcher/open/app';
const POLL_MS = 15_000;

export default function ClickupPipeline() {
  const iframeRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [serviceDown, setServiceDown] = useState(false);
  // null = the first status answer has not arrived yet. Until it does we render
  // neither the frame nor the disabled panel: showing "not configured" for a
  // moment on a store that IS configured is its own bug.
  const [configured, setConfigured] = useState(null);
  const [missing, setMissing] = useState(null);
  const [statusError, setStatusError] = useState(null);

  /** Force a fresh iframe load. */
  const triggerLoad = useCallback(() => {
    setLoading(true);
    setServiceDown(false);
    if (iframeRef.current) {
      // A cache-busting stamp on our OWN route: the redirect target must not be
      // served from the bfcache after a launcher restart.
      iframeRef.current.src = `${EMBED_PATH}?r=${Date.now()}`;
    }
  }, []);

  /**
   * Status loop — the server does the health call now, so this page never
   * touches the launcher's origin directly and never needs to know it.
   *
   *  - not configured  → stop polling, render the disabled panel.
   *  - healthy         → force-reload the frame so a stale page left over from
   *                      a deploy restart is never what the operator sees.
   *  - unhealthy       → overlay, keep polling, auto-recover.
   */
  useEffect(() => {
    let cancelled = false;
    let prevHealthy = null; // null = no answer yet
    let id = null;

    async function ping() {
      let data = null;
      let failed = null;
      try {
        const r = await api.get('/video-launcher/status');
        data = r?.data || null;
      } catch (err) {
        // 401/403 are real answers about this operator, not about the tool.
        const code = err?.response?.status;
        failed = code === 403 ? 'forbidden' : code === 401 ? 'unauthenticated' : 'unreachable';
      }
      if (cancelled) return;

      if (failed) {
        setStatusError(failed);
        setServiceDown(true);
        return;
      }
      setStatusError(null);

      if (data && data.configured === false) {
        setConfigured(false);
        setMissing(data.missing || null);
        setServiceDown(false);
        setLoading(false);
        if (id) { clearInterval(id); id = null; } // nothing to poll for
        return;
      }

      setConfigured(true);
      const healthy = Boolean(data && data.healthy);
      if (healthy) {
        // Reload on the first healthy answer (flush a stale frame) and on every
        // down → up recovery. Not on every poll.
        if (prevHealthy !== true) triggerLoad();
        setServiceDown(false);
      } else {
        setServiceDown(true);
      }
      prevHealthy = healthy;
    }

    ping();
    id = setInterval(ping, POLL_MS);
    return () => { cancelled = true; if (id) clearInterval(id); };
  }, [triggerLoad]);

  // ── Disabled: this store has no launcher ────────────────────────────────
  if (configured === false) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex flex-shrink-0 items-center justify-between border-b border-gray-800 bg-[#0f1117] px-4 py-2">
          <span className="text-xs font-medium uppercase tracking-wide text-gray-500">
            ClickUp Pipeline
          </span>
        </div>
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="max-w-md text-center">
            <PlugZap size={28} className="mx-auto mb-3 text-gray-600" />
            <p className="mb-1 text-sm text-gray-300">
              The video launcher is not configured for this store
            </p>
            <p className="text-xs leading-relaxed text-gray-500">
              This page embeds a store&apos;s own video-launcher tool. Set{' '}
              <code className="text-gray-400">VIDEO_LAUNCHER_URL</code> and{' '}
              <code className="text-gray-400">VIDEO_LAUNCHER_TOKEN</code> on this
              service and the page turns on with no deploy.
            </p>
            {missing && (
              <p className="mt-3 text-xs text-gray-600">
                Missing here:{' '}
                {Object.entries(missing)
                  .filter(([, isMissing]) => isMissing)
                  .map(([key]) => key)
                  .join(' and ') || 'nothing'}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Waiting for the first status answer ─────────────────────────────────
  if (configured === null && !statusError) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex flex-shrink-0 items-center justify-between border-b border-gray-800 bg-[#0f1117] px-4 py-2">
          <span className="text-xs font-medium uppercase tracking-wide text-gray-500">
            ClickUp Pipeline
          </span>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
          <span className="text-xs text-gray-500">Checking the pipeline…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex flex-shrink-0 items-center justify-between border-b border-gray-800 bg-[#0f1117] px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-gray-500">
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
            className="rounded p-1 text-gray-500 transition hover:text-gray-300"
            title="Reload"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
          {/* Same-origin. The server checks the session, then redirects. */}
          <a
            href={EMBED_PATH}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded p-1 text-gray-500 transition hover:text-gray-300"
            title="Open in new tab"
          >
            <ExternalLink size={14} />
          </a>
        </div>
      </div>

      {/* Iframe + overlays */}
      <div className="relative flex-1">
        {serviceDown && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-[#0f1117]">
            <AlertCircle size={28} className="text-yellow-500" />
            <div className="text-center">
              <p className="mb-1 text-sm text-gray-300">
                {statusError === 'forbidden'
                  ? 'Your role does not open the pipeline'
                  : statusError === 'unauthenticated'
                    ? 'Your session expired'
                    : 'Pipeline is restarting'}
              </p>
              <p className="text-xs text-gray-500">
                {statusError === 'forbidden'
                  ? 'Ask an admin for brief-pipeline access.'
                  : statusError === 'unauthenticated'
                    ? 'Sign in again to reconnect.'
                    : 'Will reconnect automatically'}
              </p>
            </div>
            {!statusError && (
              <button
                onClick={triggerLoad}
                className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white transition hover:bg-blue-500"
              >
                Retry now
              </button>
            )}
          </div>
        )}

        {!serviceDown && loading && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-[#0f1117]">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
            <span className="text-xs text-gray-500">Loading pipeline…</span>
          </div>
        )}

        {/* Mounted only once the server has said this store HAS a launcher.
            Mounting it while the answer is a 401/403 would put an error
            document in the frame behind the overlay for no reason. */}
        {configured === true && (
          <iframe
            ref={iframeRef}
            src={EMBED_PATH}
            title="ClickUp Pipeline"
            className="h-full w-full border-0"
            onLoad={() => setLoading(false)}
            allow="fullscreen"
          />
        )}
      </div>
    </div>
  );
}
