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
// connection. A hidden tab CLOSES the stream (status "paused") and a tab
// going visible / the browser coming online forces an immediate resync
// (fresh snapshot + reopen), same as the reference's visibility contract.
// An `auth_expired` frame (server ended the stream on JWT expiry) reconnects
// IMMEDIATELY — the reconnect's snapshot GET rides the app's axios
// interceptors, which is where the token refresh lives.
import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../services/api';

const FEED_MAX = 100;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

function mergeFeed(prev, incoming) {
  // incoming arrives oldest-first; dedupe by id, then keep the rail in strict
  // ts-desc order (a reconnect gap backfilled from a snapshot may interleave
  // between rows already on the rail, not only above them).
  const seen = new Set(prev.map((e) => e.id));
  const fresh = [];
  for (const ev of incoming) {
    if (!ev || !ev.id || seen.has(ev.id)) continue;
    seen.add(ev.id);
    fresh.push(ev);
  }
  if (fresh.length === 0) return prev;
  return [...fresh, ...prev]
    .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))
    .slice(0, FEED_MAX);
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
  const [status, setStatus] = useState('connecting'); // connecting|live|reconnecting|paused|error
  const [error, setError] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [feed, setFeed] = useState([]);
  const [lastMessageAt, setLastMessageAt] = useState(null);

  const abortRef = useRef(null);
  const timerRef = useRef(null);
  const backoffRef = useRef(BACKOFF_MIN_MS);
  const aliveRef = useRef(true);
  const immediateRef = useRef(false); // auth_expired ⇒ skip the backoff delay
  const connectRef = useRef(() => {});

  const applySnapshot = useCallback((snap) => {
    if (!snap || typeof snap !== 'object') return;
    setSnapshot(snap);
    // Snapshot events are MERGED into the rail (dedupe by id) — this is what
    // backfills a reconnect gap the delta stream never saw. They arrive
    // newest-first; mergeFeed expects oldest-first.
    if (Array.isArray(snap.events)) {
      setFeed((prev) => (prev.length === 0
        ? snap.events.slice(0, FEED_MAX)
        : mergeFeed(prev, [...snap.events].reverse())));
    }
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
          if (f.event === 'auth_expired') {
            // Server ended the stream because the JWT lapsed (review M4).
            // Reconnect NOW — the snapshot GET on the way back in goes
            // through the axios interceptors where the token refresh lives.
            immediateRef.current = true;
            throw new Error('session refreshed — resyncing');
          }
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
      // "error" (review L4) = the backoff is saturated: still retrying, but
      // the connection has been failing for a while and the UI should say so
      // louder than a transient "reconnecting".
      setStatus(backoffRef.current >= BACKOFF_MAX_MS ? 'error' : 'reconnecting');
      const delay = immediateRef.current
        ? 0
        : backoffRef.current + Math.floor(Math.random() * 500);
      immediateRef.current = false;
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

    // Hidden tab ⇒ CLOSE the stream (review L1) — a wall of background tabs
    // must not hold server connections. Visible again / back online ⇒ full
    // resync, the cheapest honest answer to "what did I miss".
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        reconnect();
      } else {
        if (timerRef.current) clearTimeout(timerRef.current);
        if (abortRef.current) abortRef.current.abort();
        setStatus('paused');
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', reconnect);

    return () => {
      aliveRef.current = false;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', reconnect);
      if (timerRef.current) clearTimeout(timerRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, [reconnect]);

  return { status, error, snapshot, feed, lastMessageAt, reconnect };
}
