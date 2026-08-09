// useLiveFeed — the Live View realtime client (NEW FILE).
//
// Port of funnel-os's useLiveViewFeed contract onto Puure's transport:
//   • initial GET /api/v1/live/snapshot                (axios, seeds state)
//   • live    GET /api/v1/live/stream                  (SSE)
//
// TRANSPORT NOTE: this app authenticates with a Bearer token from
// localStorage (AuthContext attaches it via an axios interceptor) — and
// EventSource cannot set headers. So the stream is consumed with fetch() +
// a ReadableStream SSE parser instead of EventSource. The auth cookie (when
// present) rides along too via credentials:'include', matching the axios
// client's withCredentials.
//
// Wire contract (server/src/services/liveViewHub.js):
//   event: snapshot — AUTHORITATIVE, wholesale-replaces counts/by_funnel
//                     (the reference's rule: never increment a snapshot).
//   event: events   — {events:[oldest-first]} delta; prepended to the local
//                     feed, deduped by id, capped.
//   : keepalive / : connected — comments; they only reset the freshness clock.
//
// Reconnect: jittered exponential backoff 1s → 30s, reset on a healthy
// connection. A tab going visible or the browser coming online forces an
// immediate resync (fresh snapshot + reopen), same as the reference.
import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../services/api';

const FEED_MAX = 100;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

function mergeFeed(prev, incoming) {
  // incoming arrives oldest-first; newest must end up on top.
  const seen = new Set(prev.map((e) => e.id));
  const fresh = [];
  for (const ev of incoming) {
    if (!ev || !ev.id || seen.has(ev.id)) continue;
    seen.add(ev.id);
    fresh.push(ev);
  }
  fresh.reverse();
  return [...fresh, ...prev].slice(0, FEED_MAX);
}

/** Parse complete SSE frames out of a text buffer; returns [frames, rest]. */
function drainSseBuffer(buffer) {
  const frames = [];
  let rest = buffer;
  for (;;) {
    const cut = rest.indexOf('\n\n');
    if (cut === -1) break;
    const raw = rest.slice(0, cut);
    rest = rest.slice(cut + 2);
    let event = 'message';
    const dataLines = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith(':')) continue; // comment — freshness only
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    frames.push({ event, data: dataLines.join('\n') });
  }
  return [frames, rest];
}

export default function useLiveFeed() {
  const [status, setStatus] = useState('connecting'); // connecting|live|reconnecting|error
  const [error, setError] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [feed, setFeed] = useState([]);
  const [lastMessageAt, setLastMessageAt] = useState(null);

  const abortRef = useRef(null);
  const timerRef = useRef(null);
  const backoffRef = useRef(BACKOFF_MIN_MS);
  const aliveRef = useRef(true);
  const connectRef = useRef(() => {});

  const applySnapshot = useCallback((snap) => {
    if (!snap || typeof snap !== 'object') return;
    setSnapshot(snap);
    // The snapshot's own events list only SEEDS an empty feed; after that the
    // locally-accumulated rail (deduped deltas) is the richer record.
    setFeed((prev) => (prev.length === 0 && Array.isArray(snap.events)
      ? snap.events.slice(0, FEED_MAX)
      : prev));
    setLastMessageAt(Date.now());
  }, []);

  const connect = useCallback(async () => {
    if (!aliveRef.current) return;
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // 1. Seed with a full snapshot (also proves auth before holding a socket).
      const seed = await api.get('/live/snapshot');
      if (!aliveRef.current || controller.signal.aborted) return;
      applySnapshot(seed.data);
      setError(null);

      // 2. Open the stream. fetch + manual parse (see TRANSPORT NOTE).
      const token = localStorage.getItem('accessToken');
      const res = await fetch('/api/v1/live/stream', {
        headers: {
          Accept: 'text/event-stream',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        credentials: 'include',
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(res.status === 503 ? 'Live board is full (connection cap)' : `stream HTTP ${res.status}`);
      }

      setStatus('live');
      backoffRef.current = BACKOFF_MIN_MS; // healthy connection → reset backoff

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const [frames, rest] = drainSseBuffer(buffer);
        buffer = rest;
        setLastMessageAt(Date.now());
        for (const f of frames) {
          if (!f.data) continue;
          let payload;
          try {
            payload = JSON.parse(f.data);
          } catch {
            continue; // a torn frame is a transport bug, not a crash
          }
          if (f.event === 'snapshot') applySnapshot(payload);
          else if (f.event === 'events' && Array.isArray(payload.events)) {
            setFeed((prev) => mergeFeed(prev, payload.events));
          }
        }
      }
      // Server closed cleanly (deploy/restart) — reconnect.
      throw new Error('stream ended');
    } catch (err) {
      if (!aliveRef.current || controller.signal.aborted) return;
      const msg = err?.response?.data?.error || err?.message || 'connection lost';
      setError(String(msg));
      setStatus('reconnecting');
      const delay = backoffRef.current + Math.floor(Math.random() * 500);
      backoffRef.current = Math.min(backoffRef.current * 2, BACKOFF_MAX_MS);
      timerRef.current = setTimeout(() => connectRef.current(), delay);
    }
  }, [applySnapshot]);
  connectRef.current = connect;

  const reconnect = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    backoffRef.current = BACKOFF_MIN_MS;
    setStatus('connecting');
    connectRef.current();
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    connectRef.current();

    // A tab returning to view / the browser coming back online forces a full
    // resync — the cheapest honest answer to "what did I miss".
    const onVisible = () => {
      if (document.visibilityState === 'visible') reconnect();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', reconnect);

    return () => {
      aliveRef.current = false;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', reconnect);
      if (timerRef.current) clearTimeout(timerRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, [reconnect]);

  return { status, error, snapshot, feed, lastMessageAt, reconnect };
}
