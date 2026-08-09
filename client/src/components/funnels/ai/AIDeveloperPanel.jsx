// AI DEVELOPER — right-side dark chat panel inside the page builder.
//
// Talks to POST /api/v1/ai-developer/chat (SSE) and applies the returned ops
// to the builder's in-memory blocks through the SAME commit path user edits
// use (undo/redo compatible). Nothing here writes pages server-side — the
// draft persists only through the builder's existing Save / Re-publish.
//
// Higgsfield generations arrive as async JOB CARDS (spinner → preview);
// "Use it" sends a follow-up chat message with the asset URL so Claude swaps
// it into the targeted block via a normal edit op.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot, X, Lightbulb, RotateCcw, Send, Loader2, Image as ImageIcon,
  Film, ChevronDown, AlertCircle, Paperclip,
} from 'lucide-react';
import api from '../../../services/api';

// FALLBACK ONLY. The picker is populated from GET /ai-developer/models — the
// server owns the allowlist and enforces it on every chat call. This list is
// what the dropdown shows if that fetch fails, so a transient error leaves a
// usable picker rather than an empty one; a stale entry here still cannot get
// past the server's check.
const FALLBACK_MODELS = [
  { id: 'claude-fable-5', label: 'Fable 5 · frontier' },
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
];

const EXAMPLES = [
  'Make the hero headline bigger and center the CTA button',
  'Match the section colors to this screenshot',
  'Tighten the spacing on mobile — everything feels cramped',
  'Generate a hero image of the product on a mountain ledge',
];

// Mirrors the server's caps (aiDeveloper.js MAX_IMAGES / MAX_IMAGE_BYTES). The
// client copy exists so an oversized paste is refused instantly with a readable
// message instead of after a 5MB round-trip — the SERVER is the enforcement.
const MAX_IMAGES = 2;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_HISTORY = 39; // server caps at 40 incl. the new user turn
const POLL_MS = 3000; // normal poll cadence
const POLL_SLOW_MS = 10_000; // backoff after repeated failures
const POLL_BACKOFF_AFTER = 5; // consecutive failures before backing off
const MAX_POLL_ATTEMPTS = 100; // then the card goes "status unavailable"

let itemCounter = 0;
const newItemId = () => `it_${Date.now().toString(36)}_${(itemCounter += 1)}`;

// Parse an SSE stream from fetch() — yields {event, data} objects.
async function consumeSse(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (data) {
        // AWAITED: the done handler snapshots the page before applying ops,
        // and the next frame must not be processed while that is in flight.
        try { await onEvent(event, JSON.parse(data)); } catch { /* skip bad frame */ }
      }
    }
  }
}

export default function AIDeveloperPanel({
  funnelId, pageId, blocks, selectedBlock, selectedIndex, onApplyOps, onClose,
}) {
  const [items, setItems] = useState([]); // {id, type:'user'|'assistant'|'job'|'error', ...}
  const [input, setInput] = useState('');
  const [pendingImages, setPendingImages] = useState([]); // dataURLs
  const [models, setModels] = useState(FALLBACK_MODELS);
  const [model, setModel] = useState(FALLBACK_MODELS[0].id);
  const [status, setStatus] = useState('idle'); // idle | thinking | streaming | coding
  const [showExamples, setShowExamples] = useState(false);
  const [detached, setDetached] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [threadLoading, setThreadLoading] = useState(true);

  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  // How many screenshots are QUEUED OR LOADED — not the same as
  // pendingImages.length, which lags by one async FileReader read. The cap has
  // to be judged against the former or a fast double-paste slips past it.
  const pendingCountRef = useRef(0);
  // Bumped on every send. A FileReader from a previous batch checks it and drops
  // its result rather than appending to the composer the operator has moved on
  // from. (Reads are fast, but a large screenshot on a slow disk is not free.)
  const imageGenRef = useRef(0);
  const blocksRef = useRef(blocks);
  useEffect(() => { blocksRef.current = blocks; }, [blocks]);

  // ---- server-owned model allowlist ---------------------------------------
  useEffect(() => {
    let alive = true;
    api.get('/ai-developer/models')
      .then((res) => {
        const list = res.data?.data?.models;
        if (!alive || !Array.isArray(list) || !list.length) return;
        const clean = list.filter((m) => m && typeof m.id === 'string');
        if (!clean.length) return;
        setModels(clean);
        // Snap the selection onto the server's default (or its first entry) so
        // the picker can never sit on an id the server would refuse.
        const preferred = res.data?.data?.default;
        setModel((cur) => (clean.some((m) => m.id === cur)
          ? cur
          : (clean.some((m) => m.id === preferred) ? preferred : clean[0].id)));
      })
      .catch(() => { /* keep the fallback list — the server still enforces */ });
    return () => { alive = false; };
  }, []);

  // ---- persisted thread ----------------------------------------------------
  // Rehydrate this page's conversation on mount. Stored turns carry no image
  // bytes (the server never persists them) — a rehydrated user turn shows a
  // "N screenshots" chip instead of thumbnails, which is the honest rendering.
  useEffect(() => {
    let alive = true;
    if (!pageId || !funnelId) { setThreadLoading(false); return undefined; }
    setThreadLoading(true);
    api.get('/ai-developer/chat', { params: { page_id: pageId, funnel_id: funnelId } })
      .then((res) => {
        if (!alive) return;
        const msgs = res.data?.data?.messages;
        if (!Array.isArray(msgs)) return;
        setItems(msgs.map((m) => ({
          id: newItemId(),
          type: m.role === 'user' ? 'user' : 'assistant',
          text: typeof m.content === 'string' ? m.content : '',
          images: [],
          imageCount: Number(m.image_count) || 0,
          opsCount: Number(m.ops_count) || 0,
          attachment: m.attachment || null,
          restored: true,
        })));
      })
      .catch(() => { /* an unreadable thread must not block a new conversation */ })
      .finally(() => { if (alive) setThreadLoading(false); });
    return () => { alive = false; };
  }, [pageId, funnelId]);

  // Re-arm the attachment whenever the builder selection changes.
  useEffect(() => { setDetached(false); }, [selectedBlock?.id]);
  // MEMOIZED, and keyed on the block's IDENTITY FIELDS rather than the block
  // object. `selectedBlock` gets a new identity on every prop edit, so keying on
  // it rebuilt this memo — and therefore send() and applyAsset() — on every
  // keystroke the operator typed into the inspector, which is exactly what the
  // memo exists to prevent. Only id/type/index actually feed the value.
  const selectedBlockId = selectedBlock?.id ?? null;
  const selectedBlockType = selectedBlock?.type ?? null;
  const attachment = useMemo(() => (
    !detached && selectedBlockId
      ? { block_id: selectedBlockId, kind: selectedBlockType, block_path: `blocks[${selectedIndex}]` }
      : null
  ), [detached, selectedBlockId, selectedBlockType, selectedIndex]);
  // A short excerpt of the anchored block, read off the live draft so the chip
  // describes what is on the canvas right now rather than what it said when the
  // selection was made.
  const attachmentExcerpt = useMemo(() => {
    if (!attachment || !selectedBlock) return '';
    const p = selectedBlock.props || {};
    for (const k of ['headline', 'title', 'text', 'label', 'block_name', 'subheadline', 'body']) {
      if (typeof p[k] === 'string' && p[k].trim()) return p[k].trim().replace(/\s+/g, ' ').slice(0, 60);
    }
    return '';
  }, [attachment, selectedBlock]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, streamText, status]);

  // ---- job polling ---------------------------------------------------------
  // setTimeout chain (not setInterval) so the cadence can back off: 3s
  // normally, 10s after 5 consecutive failures; after ~100 attempts the card
  // flips to a retryable "generation status unavailable" state.
  const pollState = useRef({}); // jobId -> { timer, attempts, failures, token }
  useEffect(() => () => {
    Object.values(pollState.current).forEach((s) => clearTimeout(s.timer));
  }, []);

  const patchJob = useCallback((jobId, patch) => {
    setItems((prev) => prev.map((it) => (
      it.type === 'job' && it.jobId === jobId ? { ...it, ...patch } : it
    )));
  }, []);

  const startPolling = useCallback((jobId, token) => {
    const existing = pollState.current[jobId];
    if (existing?.timer) clearTimeout(existing.timer);
    const st = { attempts: 0, failures: 0, token: token ?? existing?.token, timer: null };
    pollState.current[jobId] = st;

    const poll = async () => {
      st.attempts += 1;
      try {
        const res = await api.get(`/ai-developer/jobs/${jobId}`, {
          // Job→user binding: the HMAC tag issued with the job, in a HEADER.
          headers: st.token ? { 'X-Job-Token': st.token } : {},
        });
        st.failures = 0;
        const d = res.data?.data;
        if (d && (d.status === 'completed' || d.status === 'failed')) {
          delete pollState.current[jobId];
          patchJob(jobId, { status: d.status, url: d.url || null, error: d.error || null });
          return;
        }
      } catch {
        st.failures += 1; // transient — back off below
      }
      if (st.attempts >= MAX_POLL_ATTEMPTS) {
        delete pollState.current[jobId];
        patchJob(jobId, { status: 'stale' });
        return;
      }
      st.timer = setTimeout(poll, st.failures >= POLL_BACKOFF_AFTER ? POLL_SLOW_MS : POLL_MS);
    };
    st.timer = setTimeout(poll, POLL_MS);
  }, [patchJob]);

  const retryPolling = useCallback((job) => {
    patchJob(job.jobId, { status: 'running' });
    startPolling(job.jobId, job.token);
  }, [patchJob, startPolling]);

  // ---- send ----------------------------------------------------------------
  const busy = status !== 'idle';

  // Serializes op batches: a second batch waits for the first to finish
  // applying (snapshot included) before it touches the blocks.
  const applyChainRef = useRef(null);

  const send = useCallback(async (textOverride) => {
    const text = (textOverride ?? input).trim();
    if (!text || busy) return;
    const images = pendingImages.slice(0, MAX_IMAGES);
    setInput('');
    setPendingImages([]);
    pendingCountRef.current = 0;
    imageGenRef.current += 1; // orphan any FileReader still resolving
    setShowExamples(false);

    const userItem = {
      id: newItemId(), type: 'user', text, images, imageCount: images.length,
      attachment: attachment
        ? { block_id: attachment.block_id, block_type: attachment.kind, excerpt: attachmentExcerpt }
        : null,
    };
    setItems((prev) => [...prev, userItem]);
    setStatus('thinking');
    setStreamText('');

    // Conversation history for the API: user/assistant text turns only.
    const history = [];
    for (const it of items) {
      if (it.type === 'user') history.push({ role: 'user', content: it.text });
      else if (it.type === 'assistant') history.push({ role: 'assistant', content: it.text });
    }
    const messages = [...history.slice(-MAX_HISTORY), { role: 'user', content: text }];

    let sawDone = false;
    try {
      const token = localStorage.getItem('accessToken');
      const response = await fetch('/api/v1/ai-developer/chat', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          page_id: pageId,
          funnel_id: funnelId,
          model,
          messages,
          attachment,
          images,
          blocks: blocksRef.current,
        }),
      });

      if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
        let msg = 'AI request failed';
        try { msg = (await response.json()).error || msg; } catch { /* keep default */ }
        throw new Error(msg);
      }

      let acc = '';
      await consumeSse(response, async (event, data) => {
        if (event === 'text' && typeof data.text === 'string') {
          acc += data.text;
          setStreamText(acc);
          setStatus('streaming');
        } else if (event === 'ops' || event === 'job') {
          setStatus('coding');
          if (event === 'job' && data.id) {
            setItems((prev) => [...prev, {
              id: newItemId(), type: 'job', jobId: data.id, token: data.token || null,
              kind: data.kind || 'image', prompt: data.prompt || '', status: 'running', url: null,
            }]);
            startPolling(data.id, data.token || null);
          }
        } else if (event === 'done') {
          sawDone = true;
          if (Array.isArray(data.ops) && data.ops.length) {
            // AWAITED, and serialized against any earlier batch. onApplyOps
            // now snapshots the page before it commits, so the "N edits
            // applied" bubble must not appear until the ops are actually on
            // the canvas — a bubble that leads the change tells the operator
            // the edit landed while the rollback point is still being taken.
            const chain = (applyChainRef.current || Promise.resolve())
              .catch(() => {})
              .then(() => onApplyOps(data.ops));
            applyChainRef.current = chain;
            await chain;
          }
          setItems((prev) => [...prev, {
            id: newItemId(), type: 'assistant',
            text: data.reply || acc || 'Done.',
            opsCount: Array.isArray(data.ops) ? data.ops.length : 0,
          }]);
        } else if (event === 'error') {
          throw new Error(data.error || 'AI request failed');
        }
      });
      if (!sawDone && acc) {
        // Stream cut before the done frame — keep the text, apply nothing.
        setItems((prev) => [...prev, { id: newItemId(), type: 'assistant', text: acc, opsCount: 0 }]);
      }
    } catch (err) {
      setItems((prev) => [...prev, { id: newItemId(), type: 'error', text: err.message || 'AI request failed' }]);
    } finally {
      setStreamText('');
      setStatus('idle');
    }
  }, [input, busy, pendingImages, items, pageId, funnelId, model, attachment, attachmentExcerpt, onApplyOps, startPolling]);

  // ---- "Use it" on a finished job ------------------------------------------
  // NOT named useAsset — a `use`-prefixed const reads as a hook to the linter
  // (rules-of-hooks) and to the next reader, and this is an event handler.
  const applyAsset = useCallback((job) => {
    if (!job.url || busy) return;
    const target = attachment
      ? `the attached ${attachment.kind} block (${attachment.block_id})`
      : 'the most appropriate block';
    send(`The generated ${job.kind} is ready: ${job.url} — swap it into ${target} with a block edit.`);
  }, [attachment, busy, send]);

  // ---- paste / drop screenshots --------------------------------------------
  const addImageFiles = useCallback((files) => {
    const list = Array.from(files || []).filter((f) => f.type?.startsWith('image/'));
    // The cap is resolved BEFORE any read starts, against a ref that tracks
    // what is already queued. Deciding inside the setState updater would be a
    // side effect in an updater — React re-invokes those, and the operator
    // would see the "not attached" notice twice.
    const errors = [];
    const accepted = [];
    for (const file of list) {
      if (file.size > MAX_IMAGE_BYTES) {
        errors.push(`"${file.name || 'image'}" is over 4MB — resize it and try again.`);
      } else if (pendingCountRef.current + accepted.length >= MAX_IMAGES) {
        errors.push(`Only ${MAX_IMAGES} screenshots per message — "${file.name || 'image'}" was not attached.`);
      } else {
        accepted.push(file);
      }
    }
    pendingCountRef.current += accepted.length;
    if (errors.length) {
      setItems((prev) => [...prev, ...errors.map((text) => ({ id: newItemId(), type: 'error', text }))]);
    }
    // The generation this batch belongs to. send() bumps it, so a FileReader
    // that resolves AFTER the operator has already sent cannot drop its image
    // into the NEXT message's composer.
    const gen = imageGenRef.current;
    for (const file of accepted) {
      const reader = new FileReader();
      reader.onload = () => {
        if (gen !== imageGenRef.current) return; // this batch was already sent
        // The cap is re-applied INSIDE the updater as well as before the read.
        // The pre-check alone trusts pendingCountRef to be in perfect sync with
        // the list, and it cannot be: removals, send() resets and failed reads
        // all move one without the other. This is a pure guard (no side effect),
        // so React re-invoking the updater is harmless — and it is the one that
        // actually bounds the array.
        setPendingImages((prev) => (prev.length >= MAX_IMAGES ? prev : [...prev, reader.result]));
      };
      reader.onerror = () => {
        if (gen === imageGenRef.current) {
          pendingCountRef.current = Math.max(0, pendingCountRef.current - 1);
        }
        setItems((prev) => [...prev, {
          id: newItemId(), type: 'error', text: `Could not read "${file.name || 'image'}".`,
        }]);
      };
      reader.readAsDataURL(file);
    }
  }, []);

  const onPaste = useCallback((e) => {
    const files = Array.from(e.clipboardData?.items || [])
      .filter((it) => it.kind === 'file')
      .map((it) => it.getAsFile())
      .filter(Boolean);
    if (files.length) { e.preventDefault(); addImageFiles(files); }
  }, [addImageFiles]);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    addImageFiles(e.dataTransfer?.files);
  }, [addImageFiles]);

  const onKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }, [send]);

  const prefill = useCallback((text) => {
    setInput(text);
    inputRef.current?.focus();
  }, []);

  // Clears the on-screen transcript AND the persisted thread. The server call
  // is awaited so the panel cannot show an empty chat that a refresh refills;
  // if it fails the transcript is left alone and the operator is told, rather
  // than being handed a blank panel over a thread that still exists.
  //
  // Clearing MID-TURN is safe: the server bumps the thread's epoch, and the
  // in-flight turn's persist checks the epoch it opened with and stands down.
  // The button is disabled while `busy` anyway, but the guarantee does not
  // depend on that — another tab, or the same page open twice, can issue the
  // DELETE while this one streams.
  const [clearing, setClearing] = useState(false);
  const resetChat = useCallback(async () => {
    if (busy || clearing) return;
    setClearing(true);
    try {
      if (pageId && funnelId) {
        await api.delete('/ai-developer/chat', { params: { page_id: pageId, funnel_id: funnelId } });
      }
      Object.values(pollState.current).forEach((s) => clearTimeout(s.timer));
      pollState.current = {};
      setItems([]);
      setStreamText('');
    } catch {
      setItems((prev) => [...prev, {
        id: newItemId(), type: 'error',
        text: 'Could not clear the saved conversation — it is still on the server. Try again.',
      }]);
    } finally {
      setClearing(false);
    }
  }, [busy, clearing, pageId, funnelId]);

  const empty = items.length === 0 && !busy && !threadLoading;
  const modelLabel = useMemo(() => models.find((m) => m.id === model)?.label || model, [models, model]);

  // Docks on the LEFT of the canvas (the reference tool's layout), so the
  // divider is the RIGHT border. The builder renders it IN PLACE OF the
  // Elements/Outline rail rather than beside it — three fixed rails plus a
  // fixed inspector left the canvas nothing to live in.
  return (
    <div
      className="w-[380px] shrink-0 h-full flex flex-col bg-[#0d1117] border-r border-zinc-800 text-zinc-100"
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
    >
      {/* ---------------- Header ---------------- */}
      <div className="px-4 pt-3 pb-2 border-b border-zinc-800 shrink-0">
        <div className="flex items-center gap-2">
          <Bot className="w-4 h-4 text-emerald-400" />
          <span className="text-sm font-semibold">AI Developer</span>
          <span className="px-1.5 py-0.5 rounded text-[9px] font-bold tracking-widest uppercase bg-[#d97757]/20 text-[#e8a188] border border-[#d97757]/40">
            Claude
          </span>
          <div className="flex-1" />
          <button
            onClick={() => setShowExamples((s) => !s)}
            title="Quick examples"
            className={`p-1.5 rounded-md cursor-pointer ${showExamples ? 'text-amber-300 bg-zinc-800' : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800'}`}
          >
            <Lightbulb className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={resetChat}
            title="Clear the saved conversation for this page"
            className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 cursor-pointer disabled:opacity-40"
            disabled={busy || clearing}
          >
            {clearing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={onClose}
            title="Close"
            className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="text-[11px] text-zinc-500 mt-0.5">Describe a change — Claude writes the code</div>
      </div>

      {/* ---------------- Transcript ---------------- */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3">
        {threadLoading && items.length === 0 && (
          <div className="flex items-center gap-2 text-[11.5px] text-zinc-500 px-1 pt-4">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading this page&apos;s conversation…
          </div>
        )}
        {empty && (
          <div className="pt-8 px-2 text-center">
            <Bot className="w-8 h-8 text-zinc-700 mx-auto mb-3" />
            <div className="text-sm font-semibold text-zinc-200 mb-1.5">Build with Claude</div>
            <p className="text-[11.5px] leading-relaxed text-zinc-500 mb-4">
              Describe any change in plain words. Click a section on the canvas to target it,
              drop or paste screenshots of what you want — Claude writes the code, you review
              the draft on the canvas, then Save &amp; publish.
            </p>
            <div className="space-y-1.5">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  onClick={() => prefill(ex)}
                  className="w-full text-left text-[11.5px] px-3 py-2 rounded-lg border border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-900 cursor-pointer"
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}

        {!empty && showExamples && (
          <div className="space-y-1.5">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                onClick={() => { prefill(ex); setShowExamples(false); }}
                className="w-full text-left text-[11.5px] px-3 py-2 rounded-lg border border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:border-zinc-600 cursor-pointer"
              >
                {ex}
              </button>
            ))}
          </div>
        )}

        {items.map((it) => {
          if (it.type === 'user') {
            return (
              <div key={it.id} className="flex justify-end">
                <div className="max-w-[85%] rounded-xl rounded-br-sm bg-emerald-900/40 border border-emerald-800/40 px-3 py-2">
                  {it.images?.length > 0 && (
                    <div className="flex gap-1.5 mb-1.5 flex-wrap">
                      {it.images.map((src, i) => (
                        <img key={i} src={src} alt="" className="w-14 h-14 object-cover rounded-md border border-zinc-700" />
                      ))}
                    </div>
                  )}
                  {/* A REHYDRATED turn has no thumbnails to show — the server
                      stores the count, never the bytes. Say so rather than
                      rendering nothing, which reads as "no screenshot". */}
                  {!it.images?.length && it.imageCount > 0 && (
                    <div className="flex items-center gap-1 mb-1.5 text-[10px] text-emerald-300/80">
                      <ImageIcon className="w-3 h-3" />
                      {it.imageCount} screenshot{it.imageCount === 1 ? '' : 's'} (not stored)
                    </div>
                  )}
                  {it.attachment?.block_id && (
                    <div className="flex items-center gap-1 mb-1.5 text-[10px] text-emerald-300/80 truncate">
                      <Paperclip className="w-3 h-3 shrink-0" />
                      <span className="truncate">
                        {it.attachment.block_type || 'block'}
                        {it.attachment.excerpt ? ` · “${it.attachment.excerpt}”` : ` · ${it.attachment.block_id}`}
                      </span>
                    </div>
                  )}
                  <div className="text-[12.5px] whitespace-pre-wrap text-zinc-100">{it.text}</div>
                </div>
              </div>
            );
          }
          if (it.type === 'assistant') {
            return (
              <div key={it.id} className="flex">
                <div className="max-w-[92%] rounded-xl rounded-bl-sm bg-zinc-900 border border-zinc-800 px-3 py-2">
                  <div className="text-[12.5px] whitespace-pre-wrap text-zinc-200">{it.text}</div>
                  {it.opsCount > 0 && (
                    <div className="mt-1.5 text-[10.5px] text-emerald-400">
                      ✓ {it.opsCount} edit{it.opsCount === 1 ? '' : 's'} applied to the draft — review on the canvas
                    </div>
                  )}
                </div>
              </div>
            );
          }
          if (it.type === 'job') {
            return (
              <div key={it.id} className="flex">
                <div className="w-[92%] rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2.5">
                  <div className="flex items-center gap-2 text-[11px] text-zinc-400">
                    {it.kind === 'video' ? <Film className="w-3.5 h-3.5" /> : <ImageIcon className="w-3.5 h-3.5" />}
                    <span className="font-medium text-zinc-300">
                      {it.kind === 'video' ? 'Video' : 'Image'} generation
                    </span>
                    <span className="text-zinc-600 font-mono text-[9.5px] truncate">{it.jobId}</span>
                  </div>
                  {it.prompt && <div className="text-[11px] text-zinc-500 mt-1 line-clamp-2">{it.prompt}</div>}
                  <div className="mt-2">
                    {it.status === 'running' && (
                      <div className="flex items-center gap-2 text-[11.5px] text-zinc-400">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Generating…
                      </div>
                    )}
                    {it.status === 'failed' && (
                      <div className="flex items-center gap-2 text-[11.5px] text-red-400">
                        <AlertCircle className="w-3.5 h-3.5" /> {it.error || 'Generation failed'}
                      </div>
                    )}
                    {it.status === 'stale' && (
                      <div className="flex items-center gap-2 text-[11.5px] text-amber-400">
                        <AlertCircle className="w-3.5 h-3.5 shrink-0" /> Generation status unavailable
                        <button
                          onClick={() => retryPolling(it)}
                          className="ml-auto px-2 py-0.5 rounded-md border border-amber-500/40 text-amber-300 hover:bg-amber-500/10 cursor-pointer"
                        >
                          Retry
                        </button>
                      </div>
                    )}
                    {it.status === 'completed' && it.url && (
                      <div>
                        {it.kind === 'video' ? (
                          <video src={it.url} controls muted className="w-full rounded-lg border border-zinc-700 max-h-44" />
                        ) : (
                          <img src={it.url} alt={it.prompt} className="w-full rounded-lg border border-zinc-700 max-h-44 object-cover" />
                        )}
                        <button
                          onClick={() => applyAsset(it)}
                          disabled={busy}
                          className="mt-2 w-full text-[11.5px] font-semibold px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer disabled:opacity-50"
                        >
                          Use it
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          }
          return (
            <div key={it.id} className="flex items-start gap-2 text-[11.5px] text-red-400 px-1">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {it.text}
            </div>
          );
        })}

        {/* live stream / progress bubbles */}
        {status === 'thinking' && (
          <div className="flex items-center gap-2 text-[11.5px] text-zinc-500 px-1">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Thinking…
          </div>
        )}
        {status === 'coding' && (
          <div className="flex items-center gap-2 text-[11.5px] text-emerald-400/90 px-1">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Claude is coding…
          </div>
        )}
        {(status === 'streaming' || status === 'coding') && streamText && (
          <div className="flex">
            <div className="max-w-[92%] rounded-xl rounded-bl-sm bg-zinc-900 border border-zinc-800 px-3 py-2">
              <div className="text-[12.5px] whitespace-pre-wrap text-zinc-300">{streamText}</div>
            </div>
          </div>
        )}
      </div>

      {/* ---------------- Composer ---------------- */}
      <div className="border-t border-zinc-800 px-3 pt-2 pb-2.5 shrink-0">
        {/* ATTACHED-CONTEXT CHIP — what this conversation is anchored to.
            Removable (detach → whole-page scope) and re-armable without having
            to reselect on the canvas, so detaching is never a one-way door. */}
        {attachment && (
          <div className="flex items-center gap-1.5 mb-1.5 text-[10.5px] text-emerald-300 bg-emerald-900/30 border border-emerald-800/40 rounded-md px-2 py-1">
            <Paperclip className="w-3 h-3 shrink-0" />
            <span className="truncate">
              Attached: {attachment.kind} · {attachment.block_path}
              {attachmentExcerpt ? ` · “${attachmentExcerpt}”` : ''}
            </span>
            <button onClick={() => setDetached(true)} title="Detach — use whole page context" className="ml-auto shrink-0 cursor-pointer text-emerald-400/70 hover:text-emerald-200">
              <X className="w-3 h-3" />
            </button>
          </div>
        )}
        {!attachment && selectedBlock && (
          <div className="flex items-center gap-1.5 mb-1.5 text-[10.5px] text-zinc-500 bg-zinc-900/60 border border-zinc-800 rounded-md px-2 py-1">
            <Paperclip className="w-3 h-3 shrink-0" />
            <span className="truncate">Whole page in scope</span>
            <button onClick={() => setDetached(false)} title={`Attach the selected ${selectedBlock.type} block`} className="ml-auto shrink-0 cursor-pointer text-zinc-400 hover:text-emerald-300">
              Attach {selectedBlock.type}
            </button>
          </div>
        )}

        {pendingImages.length > 0 && (
          <div className="flex gap-1.5 mb-1.5 flex-wrap">
            {pendingImages.map((src, i) => (
              <div key={i} className="relative">
                <img src={src} alt="" className="w-12 h-12 object-cover rounded-md border border-zinc-700" />
                <button
                  onClick={() => {
                    pendingCountRef.current = Math.max(0, pendingCountRef.current - 1);
                    setPendingImages((prev) => prev.filter((_, j) => j !== i));
                  }}
                  className="absolute -top-1.5 -right-1.5 bg-zinc-800 border border-zinc-600 rounded-full p-0.5 cursor-pointer"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={2}
          placeholder="Describe a change… (Enter to send · Shift+Enter newline · paste/drop screenshots)"
          className="w-full resize-none text-[12.5px] bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
        />

        <div className="flex items-center gap-1.5 mt-1.5">
          <button
            onClick={() => prefill('Generate an image of ')}
            title="Generate an image"
            className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 cursor-pointer"
          >
            <ImageIcon className="w-4 h-4" />
          </button>
          <button
            onClick={() => prefill('Generate a video of ')}
            title="Generate a video"
            className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 cursor-pointer"
          >
            <Film className="w-4 h-4" />
          </button>

          <div className="relative ml-1">
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              title="Model"
              className="appearance-none text-[10.5px] bg-zinc-900 border border-zinc-700 rounded-md pl-2 pr-6 py-1 text-zinc-300 cursor-pointer focus:outline-none"
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.label || m.id}</option>
              ))}
            </select>
            <ChevronDown className="w-3 h-3 absolute right-1.5 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
          </div>

          <div className="flex-1" />
          <button
            onClick={() => send()}
            disabled={busy || !input.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11.5px] font-semibold bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            {busy ? 'Thinking…' : 'Send'}
          </button>
        </div>

        <div className="text-center text-[9.5px] text-zinc-600 mt-1.5">
          Powered by Claude · changes stay a draft until you Save &amp; publish
          <span className="text-zinc-700"> · {modelLabel}</span>
        </div>
      </div>
    </div>
  );
}
