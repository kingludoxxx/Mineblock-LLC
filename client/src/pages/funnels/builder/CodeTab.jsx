// PAGE BUILDER — Code view.
//
// STRUCTURE MIRRORS THE REFERENCE TOOL (funnel-os LBCodeTab.jsx):
//   · two sub-tabs, "Full HTML" and "CSS"
//   · ONE editable document each, blocks delimited by @block comment markers
//     (document model + parse-back live in codeDoc.js)
//   · typing writes local state UNDEBOUNCED; nothing persists on keystroke
//   · dirty = string compare against the document as built
//   · explicit Save button + ⌘/Ctrl+S; Refresh confirms before discarding
//   · Format button re-indents in place
//
// TWO SUBSTITUTIONS, both required here:
//   1. The reference embeds Monaco. This repo stays dependency-free, so the
//      editor is a textarea with a highlighted <pre> painted underneath it,
//      using the existing highlightHtml/highlightCss tokenizers from the
//      ai-page-generate lane (components/funnels/codeFormat.js). Past
//      HIGHLIGHT_MAX those return null and the pane degrades to a plain
//      textarea — which is why the overlay is optional, never assumed.
//   2. Saving goes through the SAME validateBlocks-guarded pages PATCH every
//      Builder-tab edit uses (onCommitBlocks / onChange -> scheduleSave), not
//      a code-specific endpoint. Nothing here can bypass the block cap, the
//      2MB bound, or the prototype-key scan.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, FileCode, Braces, Loader2, RotateCcw, Wand2, Save, Check,
} from 'lucide-react';
import {
  buildHtmlDoc, buildCssDoc, docBlockIds, parseCodeDocs, makeNonce, CodeDocRefusal,
} from './codeDoc';
import { newBlockId } from './blockRegistry';
import {
  formatHtml, formatCss, highlightHtml, highlightCss,
} from '../../../components/funnels/codeFormat';

const TABS = [
  { value: 'full', label: 'Full HTML', icon: FileCode },
  { value: 'css', label: 'CSS', icon: Braces },
];

// Shared metrics — the textarea and the highlight layer MUST agree on every
// one of these or the painted text drifts out from under the caret.
const EDITOR_TEXT =
  'font-mono text-xs leading-relaxed whitespace-pre-wrap break-words p-3 m-0 border-0';

// Token colours for the highlighter. Same class names the clone-a-page panes
// use (codeFormat.js emits them); this palette is the DARK counterpart, since
// the builder's editor sits on bg-elevated rather than a white paste pane.
const HL_CSS = `
.cf-code .cf-t{color:#7ee787}
.cf-code .cf-a{color:#79c0ff}
.cf-code .cf-s{color:#a5d6ff}
.cf-code .cf-c{color:#8b949e;font-style:italic}
.cf-code .cf-p{color:#c9d1d9}
`;

function Editor({ value, language, onChange }) {
  const taRef = useRef(null);
  const preRef = useRef(null);

  // null => too big to tokenize; the textarea then stands alone.
  const painted = useMemo(
    () => (language === 'css' ? highlightCss(value) : highlightHtml(value)),
    [value, language]
  );

  // Keep the painted layer glued to the textarea's scroll position.
  const syncScroll = useCallback(() => {
    if (preRef.current && taRef.current) {
      preRef.current.scrollTop = taRef.current.scrollTop;
      preRef.current.scrollLeft = taRef.current.scrollLeft;
    }
  }, []);

  return (
    <div className="relative flex-1 min-h-0 rounded-md border border-border-default bg-bg-elevated overflow-hidden">
      {/* AUDITED dangerouslySetInnerHTML — the builder's only one. `painted`
          comes from codeFormat.js's highlighters, which run escHtml() over
          EVERY source character before wrapping runs in class-only <span>
          tags: the result is escaped text plus a fixed span vocabulary, so
          operator code cannot become live markup. The layer is aria-hidden
          and pointer-events:none; the real input is the textarea above it. */}
      {painted != null && (
        <pre
          ref={preRef}
          aria-hidden="true"
          className={`absolute inset-0 overflow-auto pointer-events-none cf-code ${EDITOR_TEXT}`}
          dangerouslySetInnerHTML={{ __html: `${painted}\n` }}
        />
      )}
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        spellCheck={false}
        wrap="soft"
        className={`absolute inset-0 w-full h-full resize-none bg-transparent focus:outline-none overflow-auto ${EDITOR_TEXT}
          ${painted != null ? 'text-transparent caret-sky-400' : 'text-text-primary'}`}
        style={painted != null ? { WebkitTextFillColor: 'transparent' } : undefined}
      />
    </div>
  );
}

export default function CodeTab({ code, blocks, onApply }) {
  const [tab, setTab] = useState('full');
  const [htmlDoc, setHtmlDoc] = useState('');
  const [cssDoc, setCssDoc] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);

  // The document as BUILT — dirty is a plain compare against this, and
  // knownIds is the id set the document actually describes (a block added
  // elsewhere afterwards has no marker and must not read as deleted).
  // `nonce` anchors THIS document's page-JS wrapper (R3): only the wrapper
  // carrying it is parsed back as custom_js, so an operator-written
  // data-lb="page-js" script can never swap places with the real one.
  const builtRef = useRef({ html: '', css: '', ids: [], nonce: '' });

  const rebuild = useCallback(() => {
    const nonce = makeNonce();
    const { text: html } = buildHtmlDoc(code, blocks, nonce);
    const css = buildCssDoc(code, blocks);
    builtRef.current = { html, css, ids: docBlockIds(blocks), nonce };
    setHtmlDoc(html);
    setCssDoc(css);
    setNotice(null);
  }, [code, blocks]);

  // Build once on mount only. Rebuilding on every `blocks` change would
  // overwrite whatever the operator is typing the moment an autosave answers.
  const bootedRef = useRef(false);
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    rebuild();
  }, [rebuild]);

  const dirty = htmlDoc !== builtRef.current.html || cssDoc !== builtRef.current.css;

  const save = useCallback(async () => {
    if (saving || !dirty) return;
    setSaving(true);
    setNotice(null);
    try {
      const parsed = parseCodeDocs({
        htmlDoc,
        cssDoc,
        blocks,
        knownIds: builtRef.current.ids,
        nonce: builtRef.current.nonce,
        deps: { newId: newBlockId },
      });
      await onApply(parsed);
      // Re-baseline off what we just sent so the pane reads clean. `blocks`
      // is null when the document did not describe them (R1) — the baseline
      // then keeps the ids it already had.
      builtRef.current = {
        html: htmlDoc,
        css: cssDoc,
        ids: parsed.blocks ? docBlockIds(parsed.blocks) : builtRef.current.ids,
        nonce: builtRef.current.nonce,
      };
      const bits = [];
      if (parsed.stats.created) bits.push(`${parsed.stats.created} new block${parsed.stats.created === 1 ? '' : 's'} from pasted HTML`);
      if (parsed.stats.removed) bits.push(`${parsed.stats.removed} block${parsed.stats.removed === 1 ? '' : 's'} removed`);
      if (parsed.stats.retyped) bits.push(`${parsed.stats.retyped} converted to custom_html`);
      setNotice({
        kind: parsed.notices.length ? 'warn' : 'ok',
        text: bits.length ? `Applied — ${bits.join(', ')}.` : 'Applied.',
        details: parsed.notices,
      });
    } catch (err) {
      // A refusal is OUR rule (R2), not the server's — it means the document
      // was never sent. Say so plainly and keep every character they typed.
      if (err instanceof CodeDocRefusal) {
        setNotice({ kind: 'error', text: err.message, details: ['Nothing was saved — your code is exactly as you left it.'] });
        setSaving(false);
        return;
      }
      // The PATCH is validateBlocks-guarded; a refusal is the server telling
      // us the document does not describe a legal page. Surface it verbatim
      // and keep the operator's text — never silently rebuild over it.
      setNotice({
        kind: 'error',
        text: err?.response?.data?.error || err?.message || 'Save failed',
      });
    } finally {
      setSaving(false);
    }
  }, [saving, dirty, htmlDoc, cssDoc, blocks, onApply]);

  // ⌘/Ctrl+S — the reference's binding. Held-key repeats are ignored.
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 's') return;
      e.preventDefault();
      if (e.repeat || saving || !dirty) return;
      save();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save, saving, dirty]);

  const onRefresh = () => {
    if (dirty && !window.confirm('Discard your unsaved code edits and reload from the page?')) return;
    rebuild();
  };

  const doFormat = () => {
    if (tab === 'css') setCssDoc((v) => formatCss(v));
    else setHtmlDoc((v) => formatHtml(v));
  };

  return (
    <div className="flex-1 min-w-0 flex flex-col min-h-0 p-4 gap-3">
      <style>{HL_CSS}</style>
      <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px] text-amber-300/90 leading-relaxed shrink-0">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
        <span>
          Everything here is editable and ships to the PUBLIC page as written — the server does not rewrite it.
          Paste HTML inside the <code className="font-mono">@BLOCKS</code> section and it becomes a block; delete a{' '}
          <code className="font-mono">@block</code> marker and its block is removed. Blocks whose markup the server
          generates show a placeholder — leave it alone to keep the block, or replace it to convert the block to
          custom HTML. Test with Preview before re-publishing.
        </span>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2 shrink-0 flex-wrap">
        <div className="flex rounded-lg border border-border-default overflow-hidden">
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.value}
                onClick={() => setTab(t.value)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium cursor-pointer transition-colors
                  ${tab === t.value ? 'bg-accent/15 text-accent' : 'text-text-muted hover:text-text-primary'}`}
              >
                <Icon className="w-3.5 h-3.5" /> {t.label}
              </button>
            );
          })}
        </div>

        {dirty && (
          <span className="px-2 py-0.5 rounded-full border border-amber-400/50 text-amber-400 text-[10px] font-semibold uppercase tracking-wider animate-pulse">
            Unsaved
          </span>
        )}

        <div className="flex-1" />

        <button
          onClick={onRefresh}
          title="Rebuild the document from the page as it is now"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border-default text-xs text-text-muted hover:text-text-primary cursor-pointer"
        >
          <RotateCcw className="w-3.5 h-3.5" /> Refresh
        </button>
        <button
          onClick={doFormat}
          title="Re-indent — never rewrites, reorders or drops tokens"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border-default text-xs text-text-muted hover:text-text-primary cursor-pointer"
        >
          <Wand2 className="w-3.5 h-3.5" /> Format
        </button>
        <button
          onClick={save}
          disabled={saving || !dirty}
          title="Apply this document to the page (⌘S)"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer bg-accent text-white
            disabled:opacity-40 disabled:pointer-events-none"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          {saving ? 'Applying…' : 'Save code'}
        </button>
      </div>

      {notice && (
        <div
          className={`flex items-start gap-2 rounded-lg px-3 py-2 text-[12px] shrink-0 leading-relaxed border
            ${notice.kind === 'ok'
              ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300/90'
              : notice.kind === 'warn'
                ? 'border-amber-500/40 bg-amber-500/5 text-amber-300/90'
                : 'border-danger/40 bg-danger/5 text-danger'}`}
        >
          {notice.kind === 'ok' ? <Check className="w-4 h-4 mt-0.5 shrink-0" /> : <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />}
          <div className="min-w-0">
            <div>{notice.text}</div>
            {notice.details?.length > 0 && (
              <ul className="mt-1 space-y-0.5 list-disc list-inside">
                {notice.details.map((d, i) => <li key={i}>{d}</li>)}
              </ul>
            )}
          </div>
        </div>
      )}

      <Editor
        key={tab}
        value={tab === 'css' ? cssDoc : htmlDoc}
        language={tab === 'css' ? 'css' : 'html'}
        onChange={tab === 'css' ? setCssDoc : setHtmlDoc}
      />
    </div>
  );
}
