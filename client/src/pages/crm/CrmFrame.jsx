/**
 * CrmFrame — renders the Funnel OS CRM inside Puure Software's shell.
 *
 * WHY A FRAME AND NOT A PORT
 * The CRM is a separate application (Python/FastAPI + MongoDB) deployed at its
 * own origin. Embedding it means the operator sees ONE product — Puure's
 * sidebar on the left, the CRM in the content area — without us re-writing
 * ~86K lines of his React into this client.
 *
 * The CRM must send `Content-Security-Policy: frame-ancestors` naming this
 * origin, otherwise the browser blocks the embed. That is driven by the
 * FRAME_ANCESTORS env var on the CRM service. If it is missing the frame
 * renders blank — which is why `onLoad` failure is surfaced to the operator
 * as a real message rather than an empty panel.
 *
 * AUTH: the CRM keeps its own session at its own origin. The first visit shows
 * its login page inside the frame; after that the session persists. We do not
 * pass tokens across the boundary — Puure's JWT means nothing to the CRM.
 */
import { useEffect, useRef, useState } from 'react';
import { ExternalLink, AlertTriangle } from 'lucide-react';

const CRM_ORIGIN =
  import.meta.env.VITE_CRM_ORIGIN || 'https://puure-crm.onrender.com';

// How long we wait for the frame to report a load before assuming the browser
// refused it. A cold Render instance can take a while, so this is generous —
// a false "blocked" message is worse than a slow one.
const LOAD_TIMEOUT_MS = 25000;

export default function CrmFrame({ path = '/app', title = 'CRM' }) {
  const src = `${CRM_ORIGIN}${path}`;
  const [state, setState] = useState('loading'); // loading | ok | blocked
  const timer = useRef(null);

  // Reset on navigation between CRM pages. Adjusting state during render is the
  // sanctioned React pattern for "derive from props" — doing it in an effect
  // would render one frame with the previous page's status.
  const [renderedSrc, setRenderedSrc] = useState(src);
  if (renderedSrc !== src) {
    setRenderedSrc(src);
    setState('loading');
  }

  useEffect(() => {
    clearTimeout(timer.current);
    // setState runs inside the timeout callback, never synchronously here.
    timer.current = setTimeout(
      () => setState((s) => (s === 'loading' ? 'blocked' : s)),
      LOAD_TIMEOUT_MS,
    );
    return () => clearTimeout(timer.current);
  }, [src]);

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      <div className="flex items-center justify-between px-1 pb-2">
        <h1 className="text-lg font-medium text-text-primary">{title}</h1>
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 text-xs text-text-faint hover:text-text-muted"
        >
          Open in new tab <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>

      {state === 'blocked' && (
        <div className="mb-2 flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            The CRM did not load in the panel. Either it is still waking up, or
            it is refusing to be embedded — that needs{' '}
            <code className="text-xs">FRAME_ANCESTORS</code> set on the CRM
            service. Use “Open in new tab” meanwhile.
          </div>
        </div>
      )}

      <iframe
        key={src}
        src={src}
        title={title}
        onLoad={() => setState('ok')}
        className="min-h-0 w-full flex-1 rounded-lg border border-border-subtle bg-white"
      />
    </div>
  );
}
