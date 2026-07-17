import { useEffect, useRef, useState } from 'react';
import { AlertCircle, RefreshCw, Loader2 } from 'lucide-react';
import api from '../../../services/api';

/**
 * Shared image renderer with 3 states: loading / loaded / error.
 *
 * Was: every `<img>` in the statics UI had its own bare `onError={hide}`,
 * so broken previews silently became black squares — operators couldn't
 * tell "broken" from "loading" from "empty slot" and had no per-card retry.
 *
 * Now: any URL that 404s / 403s shows a red "Broken" badge with a Retry
 * button. Retry re-triggers self-heal AND polls the row for a fresh URL,
 * patching in-place without a page refresh. First error also fires the
 * batched auto-heal (module-scope dedup — same as PipelineView).
 *
 * Props:
 *   src        image URL (falsy → renders error state immediately)
 *   creativeId spy_creatives.id — required for self-heal & retry
 *   alt        img alt text
 *   className  applied to the img element
 *   overlayClassName  applied to the state-overlay container
 *   compact    if true, uses a smaller badge / spinner (for grid thumbnails)
 *   onHealed   callback(freshUrl) — called when retry lands a new URL,
 *              so the parent can update its own state
 *
 * State machine:
 *   src empty ─────→ [error]
 *   src set   ────→ [loading] ──onLoad──→ [loaded]
 *                              ──onError─→ [error] (fires self-heal batch once)
 *   [error] user clicks Retry → [retrying] → [loading|error]
 */
const _autoHealedIds = new Set();
const _pendingHeal = new Set();
let _healScheduled = false;
let _lastHealFireAt = 0;
const HEAL_DEBOUNCE_MS = 800;
const HEAL_MIN_INTERVAL_MS = 15000;
const HEAL_BATCH_CAP = 20;

// Callbacks a caller can register to be notified when a batch completes,
// so parent components can re-fetch or ripple the fresh URL back into state
// without a full page reload.
const _healedCallbacks = new Map(); // creativeId → Set(fn)
function _onHealed(id, fn) {
  if (!id || typeof fn !== 'function') return () => {};
  if (!_healedCallbacks.has(id)) _healedCallbacks.set(id, new Set());
  _healedCallbacks.get(id).add(fn);
  return () => _healedCallbacks.get(id)?.delete(fn);
}

function _fireHealBatch() {
  const now = Date.now();
  const cooldown = _lastHealFireAt + HEAL_MIN_INTERVAL_MS - now;
  if (cooldown > 0) { setTimeout(_fireHealBatch, cooldown + 50); return; }
  _healScheduled = false;
  if (_pendingHeal.size === 0) return;
  const batch = Array.from(_pendingHeal).slice(0, HEAL_BATCH_CAP);
  for (const id of batch) _pendingHeal.delete(id);
  _lastHealFireAt = Date.now();
  api.post('/statics-generation/regenerate-broken-previews', { ids: batch })
    .then(async () => {
      // Batched regen is async server-side; poll each id up to ~90s for a
      // fresh URL, then fire callbacks. We poll one round after 8s and then
      // every 12s; most healed rows show up on the second or third round.
      for (let round = 0; round < 8; round++) {
        await new Promise(r => setTimeout(r, round === 0 ? 8000 : 12000));
        await Promise.all(batch.map(async (id) => {
          if (!_healedCallbacks.get(id)?.size) return; // no listeners → skip
          try {
            const r = await api.get(`/statics-generation/creatives/${id}`);
            const freshUrl = r?.data?.data?.image_url || r?.data?.image_url;
            if (freshUrl && !freshUrl.match(/tempfile\.aiquickdraw|kie\.ai|\/tmp-img\/|\.fbcdn\.net|\.fbsbx\.com|scontent[^/]*\.xx\./i)) {
              for (const fn of _healedCallbacks.get(id) || []) {
                try { fn(freshUrl); } catch { /* isolate */ }
              }
              // Remove from callbacks once fired to avoid double-firing.
              _healedCallbacks.delete(id);
            }
          } catch { /* transient poll error — keep trying */ }
        }));
      }
    })
    .catch(err => {
      console.warn('[CreativeImage self-heal] batch failed:', err?.response?.data?.error?.message || err.message);
    })
    .finally(() => {
      if (_pendingHeal.size > 0 && !_healScheduled) {
        _healScheduled = true;
        setTimeout(_fireHealBatch, HEAL_DEBOUNCE_MS);
      }
    });
}

function _queueSelfHeal(id) {
  if (!id || _autoHealedIds.has(id)) return;
  _autoHealedIds.add(id);
  _pendingHeal.add(id);
  if (!_healScheduled) {
    _healScheduled = true;
    setTimeout(_fireHealBatch, HEAL_DEBOUNCE_MS);
  }
}

export default function CreativeImage({
  src,
  creativeId,
  alt = '',
  className = '',
  overlayClassName = '',
  compact = false,
  onHealed,
  // Extra img attrs (loading, decoding, etc.)
  imgProps = {},
}) {
  // Start in `loading` if we have a src, otherwise straight to `error`.
  const [status, setStatus] = useState(src ? 'loading' : 'error');
  const [currentSrc, setCurrentSrc] = useState(src);
  // Track whether the initial auto-heal has fired for this id so we don't
  // re-fire on transient re-mounts.
  const firstErrorHandled = useRef(false);

  // React to src prop changes (e.g., parent state ripple after heal completes).
  useEffect(() => {
    if (src === currentSrc) return;
    setCurrentSrc(src);
    setStatus(src ? 'loading' : 'error');
    firstErrorHandled.current = false;
  }, [src]);

  // Register healed callback so a background heal updates our state in-place.
  useEffect(() => {
    if (!creativeId) return undefined;
    return _onHealed(creativeId, (freshUrl) => {
      setCurrentSrc(freshUrl);
      setStatus('loading');
      firstErrorHandled.current = false;
      onHealed?.(freshUrl);
    });
  }, [creativeId, onHealed]);

  const handleError = () => {
    setStatus('error');
    if (!firstErrorHandled.current && creativeId) {
      firstErrorHandled.current = true;
      _queueSelfHeal(creativeId);
    }
  };

  const handleRetry = async () => {
    if (!creativeId) return;
    setStatus('loading');
    // Bypass the batch debounce for user-initiated retry — fire immediately.
    _autoHealedIds.delete(creativeId); // allow re-queue
    _queueSelfHeal(creativeId);
    // Also poll ourselves so the retry click feels responsive even without
    // the batch's polling loop.
    for (let round = 0; round < 6; round++) {
      await new Promise(r => setTimeout(r, round === 0 ? 5000 : 10000));
      try {
        const r = await api.get(`/statics-generation/creatives/${creativeId}`);
        const freshUrl = r?.data?.data?.image_url || r?.data?.image_url;
        if (freshUrl && freshUrl !== currentSrc) {
          setCurrentSrc(freshUrl);
          setStatus('loading');
          firstErrorHandled.current = false;
          onHealed?.(freshUrl);
          return;
        }
      } catch { /* keep polling */ }
    }
    // Nothing landed — give up gracefully. State stays `loading` for a beat
    // then flips back to error on the next natural img load attempt.
    setStatus('error');
  };

  const showLoading = status === 'loading' && currentSrc;
  const showError = status === 'error' || !currentSrc;
  const showImg = !!currentSrc;

  return (
    <div className={`relative w-full h-full ${overlayClassName}`}>
      {showImg && (
        <img
          src={currentSrc}
          alt={alt}
          onLoad={() => setStatus('loaded')}
          onError={handleError}
          className={`${className} ${showError ? 'opacity-0' : ''} transition-opacity`}
          {...imgProps}
        />
      )}
      {showLoading && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <Loader2 className={`${compact ? 'w-3.5 h-3.5' : 'w-5 h-5'} animate-spin text-zinc-500`} />
        </div>
      )}
      {showError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 backdrop-blur-[1px] gap-1.5">
          <div className="flex items-center gap-1 text-red-300">
            <AlertCircle className={compact ? 'w-3 h-3' : 'w-4 h-4'} />
            <span className={`${compact ? 'text-[9px]' : 'text-[10px]'} font-mono uppercase tracking-wider`}>Broken</span>
          </div>
          {creativeId && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); handleRetry(); }}
              className={`inline-flex items-center gap-1 ${compact ? 'text-[9px] px-1.5 py-0.5' : 'text-[10px] px-2 py-1'} font-mono uppercase tracking-wider text-zinc-300 border border-white/[0.15] rounded hover:bg-white/[0.1] cursor-pointer`}
              title="Retry — regenerate this thumbnail"
            >
              <RefreshCw className={compact ? 'w-2.5 h-2.5' : 'w-3 h-3'} />
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  );
}
