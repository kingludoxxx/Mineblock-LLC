import { useEffect, useState } from 'react';
import api from '../../services/api';

// ---------------------------------------------------------------------------
// Shared page-thumbnail loader (extracted from PageNode so the split surfaces
// — SplitGroupNode arm tiles, SplitSetupModal arm cards, the quick-create
// modal — reuse ONE cache instead of each refetching the same screenshot).
//
// <img src> can't carry the Bearer header, so the thumbnail is fetched
// through the app's api client and served to the <img> as an object URL.
// URLs are refcounted per cache key (pageId + updated_at): shared across
// consumers while mounted, revoked when the last user unmounts.
// The server allows only 2 concurrent screenshots, so a big funnel loading
// all its nodes at once would herd into lockstep 202 storms. Two defenses:
// each consumer's FIRST fetch is staggered by a random 0-1500ms, and 202
// retries back off (~2s/5s/10s/10s, each +0-1s jitter, up to 4 retries).
// A 204 or any failure resolves null and the caller's placeholder stays.
// ---------------------------------------------------------------------------
const thumbCache = new Map(); // key -> { promise, url, refs }

const RETRY_DELAYS_MS = [2000, 5000, 10000, 10000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function thumbKey(page) {
  const ms = new Date(page?.updated_at || 0).getTime() || 0;
  return `${page?.funnel_id}/${page?.id}/${ms}`;
}

async function fetchThumbUrl(page, attempt = 0) {
  try {
    if (attempt === 0) await sleep(Math.random() * 1500); // de-herd the initial burst
    const res = await api.get(
      `/page-thumbnails/${page.funnel_id}/${page.id}.png`,
      { responseType: 'blob' }
    );
    if (res.status === 202) {
      if (attempt >= RETRY_DELAYS_MS.length) return null;
      await sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] + Math.random() * 1000);
      return fetchThumbUrl(page, attempt + 1);
    }
    if (res.status !== 200 || !res.data || !res.data.size) return null; // 204 → placeholder
    return URL.createObjectURL(res.data);
  } catch {
    return null; // network/auth failure → placeholder
  }
}

function acquireThumb(page) {
  const key = thumbKey(page);
  let entry = thumbCache.get(key);
  if (!entry) {
    entry = { promise: null, url: null, refs: 0 };
    entry.promise = fetchThumbUrl(page).then((url) => {
      // Nobody left waiting (all unmounted) — don't leak the object URL. The
      // identity check matters under StrictMode's mount/unmount/mount: by the
      // time THIS entry's fetch resolves dead, the key may already map to the
      // remount's fresh entry, and deleting blindly would clobber it.
      if (entry.refs <= 0 && url) {
        URL.revokeObjectURL(url);
        if (thumbCache.get(key) === entry) thumbCache.delete(key);
        return null;
      }
      entry.url = url;
      return url;
    });
    thumbCache.set(key, entry);
  }
  entry.refs += 1;
  return { key, entry };
}

function releaseThumb(key) {
  const entry = thumbCache.get(key);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs <= 0) {
    if (entry.url) URL.revokeObjectURL(entry.url);
    thumbCache.delete(key);
  }
}

/**
 * Live thumbnail object URL for a page, or null while pending / when the
 * server has nothing (the caller keeps its placeholder). `page` needs
 * { id, funnel_id } and, when available, `updated_at` (an edit bumps the
 * cache key → refetch).
 */
export default function usePageThumbnail(page) {
  const [url, setUrl] = useState(null);
  const key = thumbKey(page);
  useEffect(() => {
    if (!page?.id || !page?.funnel_id) return undefined;
    // Cancellation is PER EFFECT RUN (a local, not a shared ref): when the key
    // changes, the old run's flag stays cancelled forever, so a slow OLD-key
    // resolution can never clobber the fresh key's URL after remount.
    let cancelled = false;
    const { key: k, entry } = acquireThumb(page);
    entry.promise.then((u) => { if (!cancelled) setUrl(u); });
    return () => {
      cancelled = true;
      setUrl(null);
      releaseThumb(k);
    };
    // key changes when the page is edited (updated_at bump) → refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return url;
}
