// GENERATE WITH AI — the Clone modal's AI tab. Brief in → streamed page
// build out (NDJSON from /api/v1/ai-generate/page) → pick sections → create
// through the EXISTING /page-clone/create, so the result is a normal cloned
// page. Image slots stay placeholders (<div class="lb-ai-image">…) — clicking
// one toasts that generation lands with the AI Developer rollout.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Sparkles, Paperclip, Check, ArrowLeft, Image as ImageIcon, Loader2,
} from 'lucide-react';
import api from '../../../services/api';
import Button from '../../ui/Button';

// Placeholder is the reference's example brief, verbatim.
const BRIEF_PLACEHOLDER = `e.g. A listicle landing page for tired moms aged 30–45 shopping a $49 magnesium sleep supplement.
Audience: parents who tried melatonin and hated the morning grogginess.
Offer: "SleepReset" — buy 3 get 1 free, 60-day money-back guarantee.
Sections: bold hero, "5 reasons melatonin fails you" list, a before/after story, ingredient breakdown, 3 customer reviews, an FAQ, and a sticky CTA.
Tone: warm, science-backed, zero hype.`;

const MODELS = [
  { value: 'claude-sonnet-5', label: 'Sonnet 5 · best balance' },
  { value: 'claude-fable-5', label: 'Fable 5 · frontier' },
  { value: 'claude-opus-5', label: 'Opus 5 · deepest' },
];

const IMAGE_TOAST = 'Image generation connects with the AI Developer rollout';

// Sandboxed, scaled, non-interactive live preview of one section's HTML.
// sandbox="" blocks scripts (the server strips them anyway) and all nav.
function SectionPreview({ html }) {
  const doc = useMemo(
    () => `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#fff;}
body{transform:scale(0.32);transform-origin:0 0;width:312.5%;}
.lb-ai-image{display:flex;align-items:center;justify-content:center;min-height:200px;background:#f1f5f9;border:1.5px dashed #cbd5e1;border-radius:10px;color:#64748b;font:500 15px/1.4 system-ui,sans-serif;text-align:center;}
</style></head><body>${html}</body></html>`,
    [html]
  );
  return (
    <iframe
      sandbox=""
      srcDoc={doc}
      title="Section preview"
      loading="lazy"
      scrolling="no"
      className="w-full h-36 bg-white pointer-events-none select-none"
    />
  );
}

export default function AiGenerateTab({ funnelId, onCreated, onClose }) {
  // form
  const [brief, setBrief] = useState('');
  const [brand, setBrand] = useState('');
  const [model, setModel] = useState('claude-sonnet-5');
  const [dragOver, setDragOver] = useState(false);
  // build stream
  const [building, setBuilding] = useState(false);
  const [arch, setArch] = useState(null); // { page_title, sections:[{name,…}] }
  const [built, setBuilt] = useState([]); // [{index,name,html,images}]
  const [finished, setFinished] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  // picker
  const [selected, setSelected] = useState(new Set());
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const fileInputRef = useRef(null);
  const abortRef = useRef(null);
  const toastTimer = useRef(null);

  useEffect(() => () => {
    abortRef.current?.abort();
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  // Elapsed-seconds chip while the architecture is being designed.
  useEffect(() => {
    if (!building) return undefined;
    setElapsed(0);
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [building]);

  const showToast = useCallback((msg) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  const readBriefFile = useCallback(async (f) => {
    if (!f) return;
    if (!/\.(txt|md|markdown)$/i.test(f.name) && !/^text\//.test(f.type || '')) {
      setError('Attach a .txt or .md brief.');
      return;
    }
    try {
      const text = await f.text();
      setBrief((prev) => (prev.trim() ? `${prev.trimEnd()}\n\n${text}` : text));
      setError(null);
    } catch {
      setError('Could not read that file — paste the brief instead.');
    }
  }, []);

  const handleEvent = useCallback((ev) => {
    if (ev.type === 'architecture') {
      setArch({ page_title: ev.page_title, sections: ev.sections || [] });
      setTitle(ev.page_title || 'AI generated page');
    } else if (ev.type === 'section') {
      setBuilt((prev) => [...prev, ev]);
      setSelected((prev) => new Set(prev).add(ev.index));
    } else if (ev.type === 'done') {
      setFinished(true);
    } else if (ev.type === 'error') {
      setError(ev.error || 'Generation failed');
      setFinished(true);
    }
  }, []);

  const build = useCallback(async () => {
    if (building || !brief.trim()) return;
    setBuilding(true);
    setArch(null);
    setBuilt([]);
    setSelected(new Set());
    setFinished(false);
    setError(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const token = localStorage.getItem('accessToken');
      const res = await fetch('/api/v1/ai-generate/page', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        credentials: 'include',
        body: JSON.stringify({
          brief,
          ...(brand.trim() ? { brand: brand.trim() } : {}),
          model,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        let msg = 'Build failed — try again.';
        try {
          const j = await res.json();
          if (j?.error) msg = j.error;
        } catch { /* non-JSON error body */ }
        throw new Error(msg);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            handleEvent(JSON.parse(line));
          } catch { /* skip malformed line */ }
        }
      }
      setFinished(true);
    } catch (err) {
      if (err?.name !== 'AbortError') setError(err.message || 'Build failed — try again.');
      setFinished(true);
    } finally {
      setBuilding(false);
    }
  }, [building, brief, brand, model, handleEvent]);

  const toggleSection = useCallback((idx) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }, []);

  const create = useCallback(async () => {
    if (creating || !built.length || !selected.size) return;
    setCreating(true);
    setError(null);
    try {
      const sections = built.filter((s) => selected.has(s.index)).map((s) => s.html);
      const res = await api.post('/page-clone/create', {
        funnel_id: funnelId,
        title: title.trim() || arch?.page_title || 'AI generated page',
        sections,
      });
      onCreated?.(res.data?.data);
      onClose?.();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create the page.');
    } finally {
      setCreating(false);
    }
  }, [creating, built, selected, funnelId, title, arch, onCreated, onClose]);

  const back = useCallback(() => {
    abortRef.current?.abort();
    setBuilding(false);
    setArch(null);
    setBuilt([]);
    setSelected(new Set());
    setFinished(false);
    setError(null);
  }, []);

  const started = building || arch || built.length > 0;
  const total = arch?.sections?.length || 0;
  const nDone = built.length;
  const nSelected = selected.size;
  const buildingK = Math.min(nDone + 1, Math.max(total, 1));

  // ── FORM ────────────────────────────────────────────────────────────────
  if (!started) {
    return (
      <>
        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
          {/* BRIEF card */}
          <div
            className={`rounded-lg border overflow-hidden transition-colors ${
              dragOver ? 'border-accent bg-accent/5' : 'border-border-default'
            }`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              readBriefFile(e.dataTransfer.files?.[0]);
            }}
          >
            <div className="flex items-center justify-between gap-2 px-3 py-2 bg-bg-elevated border-b border-border-subtle">
              <div className="min-w-0">
                <span className="block text-xs font-semibold text-text-primary uppercase tracking-wide">Brief</span>
                <span className="block text-[10px] text-text-faint truncate">describe the page — Claude builds the sections</span>
              </div>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border-default text-[11px] text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer shrink-0"
              >
                <Paperclip className="w-3 h-3" />
                Attach .txt / .md brief — or drop it here
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.md,.markdown,text/plain,text/markdown"
                className="hidden"
                onChange={(e) => { readBriefFile(e.target.files?.[0]); e.target.value = ''; }}
              />
            </div>
            <textarea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder={BRIEF_PLACEHOLDER}
              spellCheck={false}
              className="w-full min-h-[260px] px-3 py-2.5 bg-bg-card text-text-primary text-xs leading-5 placeholder:text-text-faint focus:outline-none resize-y"
            />
          </div>

          {/* brand + model */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input
              type="text"
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              placeholder="brand colors, fonts, vibe… (optional)"
              className="w-full px-3 py-2 rounded-lg bg-bg-elevated border border-border-default text-text-primary text-sm placeholder:text-text-faint focus:outline-none focus:border-accent/60"
            />
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-bg-elevated border border-border-default text-text-primary text-sm focus:outline-none focus:border-accent/60 cursor-pointer"
            >
              {MODELS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>

          {error && (
            <div className="px-3 py-2 rounded-lg bg-danger/10 border border-danger/30 text-danger text-xs">
              {error}
            </div>
          )}
        </div>

        <div className="shrink-0 flex items-center justify-between gap-3 px-5 py-3.5 border-t border-border-subtle">
          <p className="text-[11px] text-text-faint">
            Claude designs the architecture first, then writes each section — image slots stay placeholders.
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={build} disabled={!brief.trim()}>
              <Sparkles className="w-4 h-4" />
              Build
            </Button>
          </div>
        </div>
      </>
    );
  }

  // ── BUILD / PICKER ──────────────────────────────────────────────────────
  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4 relative">
        {!arch ? (
          // Progress card — architecture phase
          <div className="flex items-center gap-3 px-4 py-4 rounded-lg border border-border-default bg-bg-elevated">
            <Loader2 className="w-5 h-5 text-accent animate-spin shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-text-primary">Claude is building your page…</p>
              <p className="text-xs text-text-faint">Designing the page architecture…</p>
            </div>
            <span className="px-2 py-1 rounded-full bg-bg-card border border-border-subtle text-[11px] text-text-muted tabular-nums shrink-0">
              {elapsed}s
            </span>
          </div>
        ) : (
          <>
            {/* Header: generated title + K/N + progress bar */}
            <div className="px-4 py-3 rounded-lg border border-border-default bg-bg-elevated space-y-2">
              <div className="flex items-center justify-between gap-3">
                <p className="min-w-0 text-sm font-semibold text-text-primary truncate">{arch.page_title}</p>
                <span className="text-[11px] text-text-muted tabular-nums shrink-0">
                  {building && !finished
                    ? `Building section ${buildingK}/${total}`
                    : `${nDone}/${total} sections built`}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-bg-card overflow-hidden">
                <div
                  className="h-full bg-accent transition-all duration-500"
                  style={{ width: `${total ? Math.round((nDone / total) * 100) : 0}%` }}
                />
              </div>
            </div>

            {finished && !building && (
              <div>
                <label className="block text-xs text-text-muted mb-1">Page title</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-bg-elevated border border-border-default text-text-primary text-sm focus:outline-none focus:border-accent/60"
                />
              </div>
            )}

            {/* Section cards */}
            <div className="space-y-2">
              {arch.sections.map((s, i) => {
                const done = built.find((b) => b.index === i);
                const on = selected.has(i);
                if (!done) {
                  return (
                    <div
                      key={i}
                      className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border-default bg-bg-elevated opacity-60"
                    >
                      <span className="w-5 text-xs text-text-faint tabular-nums shrink-0">{i + 1}</span>
                      <span className="flex-1 min-w-0 text-xs text-text-muted truncate">{s.name}</span>
                      {building && i === nDone ? (
                        <span className="inline-flex items-center gap-1.5 text-[11px] text-text-faint shrink-0">
                          <Loader2 className="w-3 h-3 animate-spin" /> Generating…
                        </span>
                      ) : (
                        <span className="text-[10px] uppercase text-text-faint shrink-0">queued</span>
                      )}
                    </div>
                  );
                }
                return (
                  <label
                    key={i}
                    className={`block rounded-lg border cursor-pointer transition-colors overflow-hidden ${
                      on ? 'border-accent/50 bg-accent/5' : 'border-border-default bg-bg-elevated opacity-70 hover:opacity-100'
                    }`}
                  >
                    <div className="flex items-center gap-3 px-3 py-2">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggleSection(i)}
                        className="accent-[#c9a84c] cursor-pointer"
                      />
                      <span className="w-5 text-xs text-text-faint tabular-nums shrink-0">{i + 1}</span>
                      <span className="flex-1 min-w-0 text-xs font-medium text-text-primary truncate">{done.name}</span>
                      {done.images?.length > 0 && (
                        <button
                          type="button"
                          onClick={(e) => { e.preventDefault(); showToast(IMAGE_TOAST); }}
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-sky-500/10 border border-sky-500/25 text-sky-400 text-[10px] shrink-0 cursor-pointer"
                          title="Image slots in this section"
                        >
                          <ImageIcon className="w-3 h-3" />
                          {done.images.length} image{done.images.length === 1 ? '' : 's'}
                        </button>
                      )}
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 text-[10px] shrink-0">
                        <Check className="w-3 h-3" /> Done
                      </span>
                    </div>
                    <div
                      className="border-t border-border-subtle"
                      onClick={(e) => {
                        if (done.images?.length) {
                          e.preventDefault();
                          showToast(IMAGE_TOAST);
                        }
                      }}
                    >
                      <SectionPreview html={done.html} />
                    </div>
                  </label>
                );
              })}
            </div>
          </>
        )}

        {error && (
          <div className="px-3 py-2 rounded-lg bg-danger/10 border border-danger/30 text-danger text-xs">
            {error}
          </div>
        )}

        {toast && (
          <div className="sticky bottom-2 flex justify-center pointer-events-none">
            <span className="px-3 py-1.5 rounded-full bg-neutral-900/90 text-white text-xs shadow-lg">
              {toast}
            </span>
          </div>
        )}
      </div>

      {/* Footer — same shape as the clone picker */}
      <div className="shrink-0 flex items-center justify-between gap-3 px-5 py-3.5 border-t border-border-subtle">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={back}
            className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text-primary cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Back
          </button>
          <span className="text-xs text-text-faint">
            {nSelected} of {nDone} section{nDone === 1 ? '' : 's'} selected
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={create} disabled={!nSelected || building} loading={creating}>
            Create page · {nSelected} section{nSelected === 1 ? '' : 's'}
          </Button>
        </div>
      </div>
    </>
  );
}
