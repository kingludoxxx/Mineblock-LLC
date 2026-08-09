// CLONE A PAGE — paste code or import a file, scan & clean it, pick the
// sections to keep, and create a new draft page from them.
//
// The scan runs SERVER-SIDE (/api/v1/page-clone/scan) and is deterministic
// string surgery: scripts, Meta/Google/TikTok/Snap pixels, comments and the
// source title/meta are stripped, then the page is split on the direct
// children of <body> (or <main>). The optional "original URL" is used only
// to absolutize relative image/link paths — the server never fetches it.
//
// "Generate with AI" is live (AiGenerateTab — brief in, streamed sections
// out, creation through the same /page-clone/create). "From Shopify" is live
// too (ShopifyTab — pick an Online Store page; the server runs the SAME scan
// pipeline on its body_html and hands back the same { sections, stats }, so
// the picker and /page-clone/create below are shared verbatim).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X, ClipboardPaste, FileUp, Sparkles, ShoppingBag, ScanLine,
  Check, ArrowLeft, UploadCloud, WandSparkles,
} from 'lucide-react';
import api from '../../services/api';
import Button from '../ui/Button';
import { formatHtml, formatCss, highlightHtml, highlightCss } from './codeFormat';
import AiGenerateTab from './ai-generate/AiGenerateTab';
import ShopifyTab from './shopify/ShopifyTab';

const TABS = [
  { value: 'paste', label: 'Paste code', icon: ClipboardPaste },
  { value: 'file', label: 'Import file', icon: FileUp },
  { value: 'ai', label: 'Generate with AI', icon: Sparkles },
  { value: 'shopify', label: 'From Shopify', icon: ShoppingBag },
];

// Token colors for the paste-pane highlighter (light panes, GitHub-light-ish).
const HL_CSS = `
.cf-hl .cf-t{color:#116329}
.cf-hl .cf-a{color:#0550ae}
.cf-hl .cf-s{color:#0a3069}
.cf-hl .cf-c{color:#6e7781;font-style:italic}
.cf-hl .cf-p{color:#57606a}
`;

const fmtBytes = (n) => {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
};

// Read a File as base64 (data-URL route handles binary safely).
const fileToBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] || '');
    reader.onerror = () => reject(reader.error || new Error('Failed to read the file'));
    reader.readAsDataURL(file);
  });

// One paste pane: label + subtitle + Format button over a monospace,
// dark-on-light, no-soft-wrap code editor (no code-editor dep in
// package.json). Highlighting is the classic overlay technique: a <pre>
// highlight layer under a transparent-text textarea, scroll-synced, plus a
// line-number gutter. Past 300KB (or on any tokenizer hiccup) the pane
// silently degrades to the plain textarea.
function CodePane({ label, subtitle, value, onChange, onFormat, placeholder, mode }) {
  const taRef = useRef(null);
  const preRef = useRef(null);
  const gutterRef = useRef(null);

  const highlighted = useMemo(() => {
    try {
      return mode === 'css' ? highlightCss(value) : highlightHtml(value);
    } catch {
      return null; // pathological input — degrade silently
    }
  }, [value, mode]);
  const degraded = highlighted === null;
  const lineCount = useMemo(
    () => (degraded ? 1 : String(value).split('\n').length || 1),
    [value, degraded]
  );

  const syncScroll = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    if (preRef.current) {
      preRef.current.scrollTop = ta.scrollTop;
      preRef.current.scrollLeft = ta.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop;
  }, []);

  const codeText = 'text-xs font-mono leading-5 whitespace-pre';

  return (
    <div className="min-w-0 flex flex-col rounded-lg border border-border-default overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-bg-elevated border-b border-border-subtle">
        <div className="min-w-0">
          <span className="block text-xs font-semibold text-text-primary">{label}</span>
          <span className="block text-[10px] text-text-faint truncate">{subtitle}</span>
        </div>
        <button
          type="button"
          onClick={onFormat}
          disabled={!value.trim()}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border-default text-[11px] text-text-muted hover:text-text-primary hover:bg-bg-hover disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer shrink-0"
          title={`Re-indent the ${label} (cosmetic only)`}
        >
          <WandSparkles className="w-3 h-3" />
          Format
        </button>
      </div>
      <div className="flex flex-1 h-[340px] min-h-[200px] bg-white resize-y overflow-hidden">
        {!degraded && (
          <div
            ref={gutterRef}
            aria-hidden
            className={`w-10 shrink-0 overflow-hidden bg-neutral-50 border-r border-neutral-200 text-right text-neutral-400 ${codeText} py-2.5 pr-2 select-none`}
          >
            {Array.from({ length: lineCount }, (_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
            {/* overscroll parity with the textarea's bottom padding */}
            <div className="h-5" />
          </div>
        )}
        <div className="relative flex-1 min-w-0">
          {!degraded && (
            <pre
              ref={preRef}
              aria-hidden
              className={`cf-hl absolute inset-0 m-0 px-3 py-2.5 ${codeText} text-neutral-800 overflow-hidden pointer-events-none`}
              // Tokenizer output is built exclusively from escaped source text
              // (see codeFormat.js) — nothing user-controlled lands unescaped.
              dangerouslySetInnerHTML={{ __html: `${highlighted}\n` }}
            />
          )}
          <textarea
            ref={taRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onScroll={syncScroll}
            placeholder={placeholder}
            spellCheck={false}
            wrap="off"
            className={`absolute inset-0 w-full h-full px-3 py-2.5 ${codeText} overflow-auto placeholder:text-neutral-400 focus:outline-none resize-none ${
              degraded
                ? 'bg-white text-neutral-800'
                : 'bg-transparent text-transparent caret-neutral-800'
            }`}
          />
        </div>
      </div>
    </div>
  );
}

function ResultChip({ children }) {
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 text-[11px]">
      <Check className="w-3 h-3" />
      {children}
    </span>
  );
}

export default function ClonePageModal({ open, onClose, funnelId, onCreated }) {
  const [tab, setTab] = useState('paste');
  const [pasteHtml, setPasteHtml] = useState('');
  const [pasteCss, setPasteCss] = useState('');
  const [originalUrl, setOriginalUrl] = useState('');
  const [file, setFile] = useState(null); // { name, base64, size }
  const [dragOver, setDragOver] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState(null); // { sections, stats }
  const [selected, setSelected] = useState(new Set());
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);
  // The Shopify page list lives HERE, not in the tab: Back from the picker
  // unmounts the tab, and a tab-owned list would re-hit the Shopify Admin API
  // (the bucket shared with live checkout pricing) on every Back.
  const [shopifyCache, setShopifyCache] = useState(null);
  const fileInputRef = useRef(null);

  // Fresh state every time the modal opens.
  useEffect(() => {
    if (!open) return;
    setTab('paste');
    setPasteHtml('');
    setPasteCss('');
    setOriginalUrl('');
    setFile(null);
    setDragOver(false);
    setScanning(false);
    setResult(null);
    setSelected(new Set());
    setTitle('');
    setCreating(false);
    setError(null);
    setShopifyCache(null); // a fresh open re-reads the store
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    document.body.style.overflow = 'hidden';
    const onEsc = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onEsc);
    return () => { document.body.style.overflow = ''; window.removeEventListener('keydown', onEsc); };
  }, [open, onClose]);

  const pickFile = useCallback(async (f) => {
    if (!f) return;
    setError(null);
    try {
      const base64 = await fileToBase64(f);
      setFile({ name: f.name, base64, size: f.size });
    } catch {
      setError('Could not read that file — try again or paste the code instead.');
    }
  }, []);

  const canScan = tab === 'paste' ? pasteHtml.trim().length > 0 : Boolean(file);

  const scan = useCallback(async () => {
    if (scanning) return;
    setScanning(true);
    setError(null);
    try {
      const body = { original_url: originalUrl.trim() || undefined };
      if (tab === 'paste') {
        body.html = pasteHtml;
        if (pasteCss.trim()) body.css = pasteCss;
      } else {
        body.file_base64 = file?.base64;
        body.filename = file?.name;
      }
      const res = await api.post('/page-clone/scan', body);
      const data = res.data?.data || {};
      const sections = data.sections || [];
      if (!sections.length) {
        setError('The scan found no content sections in that page — check the markup and try again.');
        return;
      }
      setResult(data);
      setSelected(new Set(sections.map((s) => s.index)));
      setTitle(
        data.stats?.title ||
        (file?.name ? file.name.replace(/\.[a-z0-9]+$/i, '') : '') ||
        'Cloned page'
      );
    } catch (err) {
      setError(err.response?.data?.error || 'Scan failed — try again.');
    } finally {
      setScanning(false);
    }
  }, [scanning, tab, pasteHtml, pasteCss, file, originalUrl]);

  // The Shopify tab's import answers the SAME { sections, stats } payload as
  // /page-clone/scan — it runs the same server-side pipeline — so it lands in
  // the same picker state below. One code path, not a parallel one. The only
  // extra is `page.title`: body_html carries no <title>, so the Shopify page
  // title is the honest default (the paste path keeps using stats.title).
  //
  // Returns a message string on refusal, NEVER setError: this modal renders
  // `error` only in the paste/file body and in the picker, so a message set
  // from here while the Shopify tab is mounted would be invisible. The tab
  // owns its own error surface, so the tab is told.
  const adoptShopifyScan = useCallback((data) => {
    const sections = data?.sections || [];
    if (!sections.length) {
      return 'The scan found no content sections in that page — try the Paste code tab.';
    }
    setResult(data);
    setSelected(new Set(sections.map((s) => s.index)));
    setTitle(data.page?.title || data.stats?.title || 'Cloned page');
    return null;
  }, []);

  const toggleSection = useCallback((idx) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }, []);

  const create = useCallback(async () => {
    if (creating || !result || !selected.size) return;
    setCreating(true);
    setError(null);
    try {
      const sections = result.sections
        .filter((s) => selected.has(s.index))
        .map((s) => s.html);
      const res = await api.post('/page-clone/create', {
        funnel_id: funnelId,
        title: title.trim() || 'Cloned page',
        sections,
        // The optional CSS pane rode the scan result back; it lands on the
        // new page's custom_css and is applied on top by the renderer.
        ...(result.css ? { css: result.css } : {}),
      });
      const page = res.data?.data;
      onCreated?.(page);
      onClose?.();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create the page.');
    } finally {
      setCreating(false);
    }
  }, [creating, result, selected, funnelId, title, onCreated, onClose]);

  const stats = result?.stats;
  const total = result?.sections?.length || 0;
  const nSelected = selected.size;
  const metaRemoved = useMemo(
    () => Boolean(stats && (stats.title || stats.comments_removed > 0 || stats.scripts_removed > 0 || stats.pixels_stripped > 0)),
    [stats]
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className={`w-full ${!result && tab === 'paste' ? 'max-w-5xl' : 'max-w-3xl'} max-h-[88vh] flex flex-col bg-bg-card border border-border-default rounded-xl shadow-2xl overflow-hidden`}>
        <style>{HL_CSS}</style>
        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="shrink-0 flex items-start justify-between px-5 py-3.5 border-b border-border-subtle">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-text-primary">
              {result || (tab !== 'ai' && tab !== 'shopify')
                ? 'Clone a page — paste code or import a file'
                : tab === 'ai'
                  ? 'Generate with AI — describe the page'
                  : 'Clone from Shopify — pick a page from your store'}
            </h2>
            <p className="mt-0.5 text-xs text-text-faint">
              {result || (tab !== 'ai' && tab !== 'shopify')
                ? 'Scan strips junk scripts & tracking pixels (Meta, Google, ...), inline event handlers, javascript: links and non-video iframes, the source title & meta — then splits it into sections.'
                : tab === 'ai'
                  ? 'Claude designs the architecture, writes each section live, and leaves image slots as placeholders.'
                  : 'Your Online Store pages, read straight from the Shopify Admin API — the picked one runs through the same scan.'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {!result ? (
          <>
            {/* ── Tabs ──────────────────────────────────────────── */}
            <div className="shrink-0 flex gap-1 px-5 pt-2 border-b border-border-subtle">
              {TABS.map((t) => {
                const Icon = t.icon;
                return (
                  <button
                    key={t.value}
                    onClick={() => { setTab(t.value); setError(null); }}
                    className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors border-b-2 -mb-px cursor-pointer ${
                      tab === t.value
                        ? 'border-accent text-text-primary'
                        : 'border-transparent text-text-muted hover:text-text-primary'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {t.label}
                  </button>
                );
              })}
            </div>

            {tab === 'ai' ? (
              <AiGenerateTab funnelId={funnelId} onCreated={onCreated} onClose={onClose} />
            ) : tab === 'shopify' ? (
              <ShopifyTab
                cache={shopifyCache}
                onLoaded={setShopifyCache}
                onScanned={adoptShopifyScan}
                onClose={onClose}
              />
            ) : (
            <>
            {/* ── Input body ────────────────────────────────────── */}
            <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
              {tab === 'paste' ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <CodePane
                    label="HTML"
                    subtitle={'full page · inline <style> kept'}
                    value={pasteHtml}
                    onChange={setPasteHtml}
                    onFormat={() => setPasteHtml((v) => formatHtml(v))}
                    placeholder={'<!doctype html> … paste the full page source here'}
                    mode="html"
                  />
                  <CodePane
                    label="CSS"
                    subtitle="optional · applied on top"
                    value={pasteCss}
                    onChange={setPasteCss}
                    onFormat={() => setPasteCss((v) => formatCss(v))}
                    placeholder={'/* extra styles applied on top of the page */'}
                    mode="css"
                  />
                </div>
              ) : (
                <div
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(false);
                    pickFile(e.dataTransfer.files?.[0]);
                  }}
                  className={`h-56 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed cursor-pointer transition-colors ${
                    dragOver
                      ? 'border-accent bg-accent/5'
                      : 'border-border-default hover:border-border-strong bg-bg-elevated'
                  }`}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".html,.htm,.zip"
                    className="hidden"
                    onChange={(e) => pickFile(e.target.files?.[0])}
                  />
                  <UploadCloud className="w-7 h-7 text-text-faint" />
                  {file ? (
                    <>
                      <span className="text-sm text-text-primary">{file.name}</span>
                      <span className="text-xs text-text-faint">{fmtBytes(file.size)} — click to swap</span>
                    </>
                  ) : (
                    <>
                      <span className="text-sm text-text-primary">Drop a file here, or click to browse</span>
                      <span className="text-xs text-text-faint">HTML or a Claude Design .zip export</span>
                    </>
                  )}
                </div>
              )}

              <div>
                <label className="block text-xs text-text-muted mb-1">
                  Original URL <span className="text-text-faint">(optional — fixes relative image/link paths)</span>
                </label>
                <input
                  type="url"
                  value={originalUrl}
                  onChange={(e) => setOriginalUrl(e.target.value)}
                  placeholder="https://example.com/pages/source"
                  className="w-full px-3 py-2 rounded-lg bg-bg-elevated border border-border-default text-text-primary text-sm placeholder:text-text-faint focus:outline-none focus:border-accent/60"
                />
              </div>

              {error && (
                <div className="px-3 py-2 rounded-lg bg-danger/10 border border-danger/30 text-danger text-xs">
                  {error}
                </div>
              )}
            </div>

            {/* ── Input footer ──────────────────────────────────── */}
            <div className="shrink-0 flex items-center justify-between gap-3 px-5 py-3.5 border-t border-border-subtle">
              <p className="text-[11px] text-text-faint">
                Scan removes scripts, pixels &amp; trackers, inline event handlers,
                <code className="font-mono"> javascript: </code>
                links and non-video iframes, and disarms off-site form actions.
              </p>
              <div className="flex items-center gap-2 shrink-0">
                <Button variant="secondary" onClick={onClose}>Cancel</Button>
                <Button onClick={scan} disabled={!canScan} loading={scanning}>
                  {!scanning && <ScanLine className="w-4 h-4" />}
                  Scan &amp; clean
                </Button>
              </div>
            </div>
            </>
            )}
          </>
        ) : (
          <>
            {/* ── Result: chips + section picker ────────────────── */}
            <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
              <div className="flex flex-wrap gap-1.5">
                {stats?.scripts_removed > 0 && (
                  <ResultChip>{stats.scripts_removed} junk script{stats.scripts_removed === 1 ? '' : 's'} removed</ResultChip>
                )}
                {stats?.pixels_stripped > 0 && (
                  <ResultChip>Meta + Google pixels stripped ({stats.pixels_stripped})</ResultChip>
                )}
                {/* Active content the scan disarmed. Silent hardening is
                    indistinguishable from a scan that did nothing, so every
                    count the cleaner reports is shown. */}
                {stats?.handlers_stripped > 0 && (
                  <ResultChip>{stats.handlers_stripped} inline event handler{stats.handlers_stripped === 1 ? '' : 's'} removed</ResultChip>
                )}
                {stats?.unsafe_urls_stripped > 0 && (
                  <ResultChip>{stats.unsafe_urls_stripped} javascript: link{stats.unsafe_urls_stripped === 1 ? '' : 's'} neutralized</ResultChip>
                )}
                {stats?.iframes_removed > 0 && (
                  <ResultChip>{stats.iframes_removed} non-video iframe{stats.iframes_removed === 1 ? '' : 's'} removed</ResultChip>
                )}
                {stats?.forms_neutralized > 0 && (
                  <ResultChip>{stats.forms_neutralized} off-site form action{stats.forms_neutralized === 1 ? '' : 's'} disarmed</ResultChip>
                )}
                {stats?.wrapper_bytes_stripped > 0 && (
                  <ResultChip>{fmtBytes(stats.wrapper_bytes_stripped)} of stray page wrappers removed</ResultChip>
                )}
                <ResultChip>Split into {total} section{total === 1 ? '' : 's'}</ResultChip>
                {metaRemoved && <ResultChip>Source title &amp; meta removed</ResultChip>}
              </div>

              <div>
                <label className="block text-xs text-text-muted mb-1">Page title</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-bg-elevated border border-border-default text-text-primary text-sm focus:outline-none focus:border-accent/60"
                />
              </div>

              <div className="space-y-2">
                {result.sections.map((s) => {
                  const on = selected.has(s.index);
                  return (
                    <label
                      key={s.index}
                      className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-colors ${
                        on
                          ? 'border-accent/50 bg-accent/5'
                          : 'border-border-default bg-bg-elevated opacity-60 hover:opacity-100'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggleSection(s.index)}
                        className="mt-0.5 accent-[#c9a84c] cursor-pointer"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="text-xs font-medium text-text-primary">Section {s.index + 1}</span>
                          <span className="text-[10px] text-text-faint">{fmtBytes(s.approx_bytes)}</span>
                        </span>
                        <span className="block text-xs text-text-muted truncate">
                          {s.text_preview || <span className="italic text-text-faint">no visible text</span>}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>

              {error && (
                <div className="px-3 py-2 rounded-lg bg-danger/10 border border-danger/30 text-danger text-xs">
                  {error}
                </div>
              )}
            </div>

            {/* ── Picker footer ─────────────────────────────────── */}
            <div className="shrink-0 flex items-center justify-between gap-3 px-5 py-3.5 border-t border-border-subtle">
              <div className="flex items-center gap-3 min-w-0">
                <button
                  onClick={() => { setResult(null); setError(null); }}
                  className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text-primary cursor-pointer"
                >
                  <ArrowLeft className="w-3.5 h-3.5" /> Back
                </button>
                <span className="text-xs text-text-faint">
                  {nSelected} of {total} section{total === 1 ? '' : 's'} selected
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button variant="secondary" onClick={onClose}>Cancel</Button>
                <Button onClick={create} disabled={!nSelected} loading={creating}>
                  Create page · {nSelected} section{nSelected === 1 ? '' : 's'}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
