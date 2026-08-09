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

const MODELS = [
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

const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
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
        try { onEvent(event, JSON.parse(data)); } catch { /* skip bad frame */ }
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
  const [model, setModel] = useState(MODELS[0].id);
  const [status, setStatus] = useState('idle'); // idle | thinking | streaming | coding
  const [showExamples, setShowExamples] = useState(false);
  const [detached, setDetached] = useState(false);
  const [streamText, setStreamText] = useState('');

  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const blocksRef = useRef(blocks);
  useEffect(() => { blocksRef.current = blocks; }, [blocks]);

  // Re-arm the attachment whenever the builder selection changes.
  useEffect(() => { setDetached(false); }, [selectedBlock?.id]);
  const attachment = !detached && selectedBlock
    ? { block_id: selectedBlock.id, kind: selectedBlock.type, block_path: `blocks[${selectedIndex}]` }
    : null;

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

  const send = useCallback(async (textOverride) => {
    const text = (textOverride ?? input).trim();
    if (!text || busy) return;
    const images = pendingImages.slice(0, MAX_IMAGES);
    setInput('');
    setPendingImages([]);
    setShowExamples(false);

    const userItem = { id: newItemId(), type: 'user', text, images };
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
      await consumeSse(response, (event, data) => {
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
          if (Array.isArray(data.ops) && data.ops.length) onApplyOps(data.ops);
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
  }, [input, busy, pendingImages, items, pageId, funnelId, model, attachment, onApplyOps, startPolling]);

  // ---- "Use it" on a finished job ------------------------------------------
  const useAsset = useCallback((job) => {
    if (!job.url || busy) return;
    const target = attachment
      ? `the attached ${attachment.kind} block (${attachment.block_id})`
      : 'the most appropriate block';
    send(`The generated ${job.kind} is ready: ${job.url} — swap it into ${target} with a block edit.`);
  }, [attachment, busy, send]);

  // ---- paste / drop screenshots --------------------------------------------
  const addImageFiles = useCallback((files) => {
    const list = Array.from(files || []).filter((f) => f.type?.startsWith('image/'));
    for (const file of list) {
      if (file.size > MAX_IMAGE_BYTES) {
        setItems((prev) => [...prev, { id: newItemId(), type: 'error', text: `"${file.name || 'image'}" is over 2MB — resize it and try again.` }]);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        setPendingImages((prev) => (prev.length >= MAX_IMAGES ? prev : [...prev, reader.result]));
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

  const resetChat = useCallback(() => {
    if (busy) return;
    Object.values(pollState.current).forEach((s) => clearTimeout(s.timer));
    pollState.current = {};
    setItems([]);
    setStreamText('');
  }, [busy]);

  const empty = items.length === 0 && !busy;
  const modelLabel = useMemo(() => MODELS.find((m) => m.id === model)?.label || model, [model]);

  return (
    <div
      className="w-[380px] shrink-0 h-full flex flex-col bg-[#0d1117] border-l border-zinc-800 text-zinc-100"
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
            title="Reset conversation"
            className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 cursor-pointer disabled:opacity-40"
            disabled={busy}
          >
            <RotateCcw className="w-3.5 h-3.5" />
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
                          onClick={() => useAsset(it)}
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
        {attachment && (
          <div className="flex items-center gap-1.5 mb-1.5 text-[10.5px] text-emerald-300 bg-emerald-900/30 border border-emerald-800/40 rounded-md px-2 py-1">
            <Paperclip className="w-3 h-3 shrink-0" />
            <span className="truncate">Attached: {attachment.kind} · {attachment.block_path}</span>
            <button onClick={() => setDetached(true)} title="Detach — use whole page context" className="ml-auto cursor-pointer text-emerald-400/70 hover:text-emerald-200">
              <X className="w-3 h-3" />
            </button>
          </div>
        )}

        {pendingImages.length > 0 && (
          <div className="flex gap-1.5 mb-1.5 flex-wrap">
            {pendingImages.map((src, i) => (
              <div key={i} className="relative">
                <img src={src} alt="" className="w-12 h-12 object-cover rounded-md border border-zinc-700" />
                <button
                  onClick={() => setPendingImages((prev) => prev.filter((_, j) => j !== i))}
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
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
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
