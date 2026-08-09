// IMPORT FUNNEL — paste or drop a `puure-funnel-v1` envelope, READ WHAT IT
// CONTAINS, then confirm.
//
// funnel-os's equivalent (LBWebsitesPage.jsx:526-543) is a hidden <input
// type="file"> that POSTs the moment a file is chosen: no preview, no summary,
// no confirmation, and the backend's raw error code (`not_a_funnel_bundle`)
// shown verbatim in a toast. This one deliberately inserts a READ step. An
// envelope carries other people's scripts — custom_js, head_html, funnel-level
// pixels — and the operator has to be able to see that BEFORE it lands, not
// discover it afterwards.
//
// So the modal is two states:
//   1. PASTE/DROP — a textarea and a drop zone. Parsing happens locally; a file
//      that is not JSON, or JSON that is not an envelope, is refused HERE with
//      prose, before any request is made.
//   2. SUMMARY — name, page count, home page, and the warnings the envelope's
//      own contents earn (scripts present, keys the exporter stripped). The
//      Confirm button is only reachable from this state.
//
// Errors are inline prose, never a toast: the operator is looking at the thing
// that failed and the sentence belongs next to it.
import { useCallback, useMemo, useRef, useState } from 'react';
import { X, Upload, FileJson, AlertTriangle, ShieldAlert } from 'lucide-react';
import api from '../../services/api';
import Button from '../ui/Button';

const FORMAT_TAG = 'puure-funnel-v1';

// The server's structured error codes, in operator language. An unmapped code
// is shown verbatim rather than swallowed — an unknown refusal the operator can
// read and quote is strictly better than "Import failed".
const ERROR_COPY = {
  not_a_funnel_envelope: 'That file is not a Puure funnel export. Its format tag does not match.',
  envelope_must_be_object: 'That file is not a Puure funnel export.',
  envelope_missing_funnel: 'This export is missing its funnel details.',
  envelope_missing_pages: 'This export has no pages list.',
  envelope_has_no_pages: 'This export contains no pages, so there is nothing to import.',
  too_many_pages: 'This export has more pages than a single import allows (100).',
  page_blocks_too_large: 'One page in this export is over the 2MB content limit.',
  envelope_too_large: 'This export is over the 20MB limit.',
  invalid_blocks: 'A page in this export has content the editor cannot store.',
  settings_invalid: 'This export\u2019s funnel settings are too large for the settings editor to save afterwards, so the import was refused.',
  too_many_redirects: 'This export has more redirects than a single import allows (500).',
  redirects_must_be_an_array: 'This export\u2019s redirects list is malformed.',
  funnel_archived: 'That funnel is archived. Restore it before exporting.',
  slug_collision: 'Could not find a free URL slug for the new funnel. Try again.',
  name_too_long: 'The name is too long (200 characters max).',
  server_error: 'The server could not complete the import. Nothing was created.',
};

const describeError = (err) => {
  const code = err?.response?.data?.error?.code;
  const detail = err?.response?.data?.error?.detail;
  if (!code) {
    return err?.message === 'Network Error'
      ? 'Could not reach the server. Nothing was imported.'
      : 'Import failed. Nothing was imported.';
  }
  const base = ERROR_COPY[code] || `Import refused: ${code}`;
  return detail ? `${base} (${detail})` : base;
};

// Read the envelope WITHOUT trusting it. Everything here tolerates a missing or
// wrong-typed field — this is a file from somewhere else, and the summary must
// render rather than throw on a malformed one.
// Review MED #4: the old detector only looked at the custom_js / head_html /
// body_end_html FIELDS, so a <script> pasted into an `html` or `embed` BLOCK —
// which funnelRender emits verbatim — was summarised as "no scripts". This
// mirrors the server's `codeWarnings` detector (services/funnelTransfer.js) on
// purpose: the operator must read the same sentence here, on the export
// confirm, and on the import response. If one side changes, change all three.
const HTML_BLOCK_TYPES = new Set(['html', 'embed']);
const carriesRawHtmlBlock = (page) => {
  const blocks = Array.isArray(page?.blocks) ? page.blocks : [];
  return blocks.some((b) => {
    if (!b || typeof b !== 'object') return false;
    if (HTML_BLOCK_TYPES.has(String(b.type))) return true;
    const html = b.props && typeof b.props === 'object' ? b.props.html : undefined;
    return typeof html === 'string' && /<script/i.test(html);
  });
};

function summarize(env) {
  const pages = Array.isArray(env?.pages) ? env.pages : [];
  const jsPages = pages.filter((p) => typeof p?.custom_js === 'string' && p.custom_js.trim()).length;
  const htmlPages = pages.filter(
    (p) => ['custom_html', 'head_html', 'body_end_html'].some((k) => typeof p?.[k] === 'string' && p[k].trim())
  ).length;
  const blockPages = pages.filter(carriesRawHtmlBlock).length;
  const settings = env?.funnel?.settings || {};
  const funnelCode = ['custom_head_code', 'custom_body_end_code'].some(
    (k) => typeof settings?.[k] === 'string' && settings[k].trim()
  );
  const homes = pages.filter((p) => p?.is_home === true);
  const warnings = [];
  if (jsPages) warnings.push(`custom_js on ${jsPages} page${jsPages === 1 ? '' : 's'} — this is code from another funnel. Read it before publishing.`);
  if (htmlPages) warnings.push(`Raw HTML on ${htmlPages} page${htmlPages === 1 ? '' : 's'} (custom_html / head_html / body_end_html).`);
  if (blockPages) warnings.push(`${blockPages} page${blockPages === 1 ? '' : 's'} carry raw HTML/embed blocks — these render verbatim, scripts included.`);
  if (funnelCode) warnings.push('Funnel-level script (head / body-end code) travels with this export.');
  if (homes.length === 0) warnings.push('No page is marked as the home page — the first page will be promoted.');
  if (homes.length > 1) warnings.push(`${homes.length} pages are marked home — the first wins and the rest are demoted.`);
  return {
    name: typeof env?.funnel?.name === 'string' && env.funnel.name.trim() ? env.funnel.name : 'Untitled funnel',
    slug: typeof env?.funnel?.slug === 'string' ? env.funnel.slug : '',
    exportedAt: env?.exported_at,
    pageCount: pages.length,
    redirectCount: Array.isArray(env?.redirects) ? env.redirects.length : 0,
    home: homes[0]?.slug || pages[0]?.slug || '—',
    pages,
    warnings,
    stripped: Array.isArray(env?.stripped) ? env.stripped : [],
  };
}

export default function ImportFunnelModal({ onClose, onImported }) {
  const [text, setText] = useState('');
  const [envelope, setEnvelope] = useState(null);
  const [nameOverride, setNameOverride] = useState('');
  const [error, setError] = useState(null);
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef(null);

  const summary = useMemo(() => (envelope ? summarize(envelope) : null), [envelope]);

  // Parse LOCALLY. A file that is not an envelope never becomes a request.
  const review = useCallback((raw) => {
    setError(null);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      setError('That is not valid JSON. Paste the contents of a funnel export file, or drop the .json file itself.');
      return;
    }
    // Tolerate a file that wraps the envelope in this app's usual
    // { success, data } response shape — that is exactly what a devtools copy
    // of the export call looks like, and refusing it would be pedantry.
    const env = parsed?.format === FORMAT_TAG ? parsed
      : (parsed?.data?.format === FORMAT_TAG ? parsed.data : parsed);
    if (env?.format !== FORMAT_TAG) {
      setError(`That JSON is not a Puure funnel export — its format tag should be "${FORMAT_TAG}".`);
      return;
    }
    if (!Array.isArray(env.pages) || env.pages.length === 0) {
      setError('That export contains no pages, so there is nothing to import.');
      return;
    }
    setEnvelope(env);
  }, []);

  const onFile = useCallback(async (file) => {
    if (!file) return;
    try {
      review(await file.text());
    } catch {
      setError('That file could not be read.');
    }
  }, [review]);

  const submit = useCallback(async () => {
    if (!envelope || importing) return;
    setImporting(true);
    setError(null);
    try {
      const res = await api.post('/funnel-transfer/import', {
        envelope,
        ...(nameOverride.trim() ? { name_override: nameOverride.trim() } : {}),
      });
      onImported?.(res.data?.data);
    } catch (err) {
      setError(describeError(err));
      setImporting(false);
    }
  }, [envelope, nameOverride, importing, onImported]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="w-full max-w-lg max-h-[88vh] flex flex-col bg-bg-card border border-border-default rounded-xl">
        <div className="shrink-0 flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <h2 className="text-lg font-semibold text-text-primary">Import funnel</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary cursor-pointer" title="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {!summary ? (
            <>
              <div
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  onFile(e.dataTransfer?.files?.[0]);
                }}
                onClick={() => fileRef.current?.click()}
                className={`rounded-lg border border-dashed px-4 py-7 text-center cursor-pointer transition-colors ${
                  dragging
                    ? 'border-accent bg-accent-muted/40'
                    : 'border-border-default hover:border-border-strong hover:bg-bg-hover'
                }`}
              >
                <Upload className="w-5 h-5 mx-auto mb-2 text-text-faint" />
                <p className="text-sm text-text-primary">Drop a funnel <span className="font-mono">.json</span> file</p>
                <p className="text-xs text-text-faint mt-0.5">or click to choose one</p>
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; onFile(f); }}
                />
              </div>

              <div className="flex items-center gap-3">
                <span className="h-px flex-1 bg-border-subtle" />
                <span className="text-[10px] uppercase tracking-wider text-text-faint">or paste</span>
                <span className="h-px flex-1 bg-border-subtle" />
              </div>

              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={`{ "format": "${FORMAT_TAG}", … }`}
                rows={7}
                className="w-full px-3 py-2 text-xs font-mono bg-bg-elevated border border-border-default rounded-md
                  text-text-primary placeholder:text-text-faint focus:outline-none focus:border-border-strong resize-y"
              />
              {error && <p className="text-sm text-red-400">{error}</p>}
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={onClose}>Cancel</Button>
                <Button onClick={() => review(text)} disabled={!text.trim()}>Review</Button>
              </div>
            </>
          ) : (
            <>
              {/* ── What is actually in this file ─────────────────────── */}
              <div className="rounded-lg border border-border-default bg-bg-elevated/50 px-4 py-3 space-y-2">
                <div className="flex items-start gap-2.5">
                  <FileJson className="w-4 h-4 mt-0.5 shrink-0 text-accent-text" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-primary truncate">{summary.name}</p>
                    <p className="text-xs text-text-muted mt-0.5">
                      {summary.pageCount} page{summary.pageCount === 1 ? '' : 's'}
                      {summary.redirectCount ? <> · {summary.redirectCount} redirect{summary.redirectCount === 1 ? '' : 's'}</> : null}
                      {summary.slug ? <> · source slug <span className="font-mono">{summary.slug}</span></> : null}
                      {' '}· home <span className="font-mono">{summary.home}</span>
                    </p>
                    {summary.exportedAt && (
                      <p className="text-[11px] text-text-faint mt-0.5">
                        Exported {new Date(summary.exportedAt).toLocaleString('en-GB')}
                      </p>
                    )}
                  </div>
                </div>
                <ul className="text-[11px] text-text-faint font-mono space-y-0.5 pl-6 max-h-24 overflow-y-auto">
                  {summary.pages.slice(0, 12).map((p, i) => (
                    <li key={`${p?.slug || i}`} className="truncate">
                      {p?.slug || '/?'} <span className="text-text-muted">· {p?.type || 'generic'}</span>
                      {p?.is_home ? <span className="text-accent-text"> · home</span> : null}
                    </li>
                  ))}
                  {summary.pages.length > 12 && <li>+{summary.pages.length - 12} more</li>}
                </ul>
              </div>

              {summary.warnings.length > 0 && (
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2.5 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <ShieldAlert className="w-4 h-4 shrink-0 text-amber-400" />
                    <p className="text-xs font-medium text-amber-300">Review before publishing</p>
                  </div>
                  <ul className="text-xs text-amber-300/90 space-y-1 pl-6 list-disc">
                    {summary.warnings.map((w) => <li key={w}>{w}</li>)}
                  </ul>
                </div>
              )}

              {/* Envelopes exported before this change carried a `stripped`
                  list. It no longer travels in the file (it names where the
                  source deployment keeps its credentials), so this renders only
                  for those older files. */}
              {summary.stripped.length > 0 && (
                <p className="text-[11px] text-text-faint">
                  The exporter left {summary.stripped.length} setting
                  {summary.stripped.length === 1 ? '' : 's'} behind (credentials and unknown keys never travel):{' '}
                  <span className="font-mono">{summary.stripped.join(', ')}</span>
                </p>
              )}

              <div>
                <label className="block text-xs uppercase tracking-wider text-text-faint mb-1.5">
                  Name (optional)
                </label>
                <input
                  value={nameOverride}
                  onChange={(e) => setNameOverride(e.target.value)}
                  placeholder={summary.name}
                  className="w-full px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-md
                    text-text-primary placeholder:text-text-faint focus:outline-none focus:border-border-strong"
                />
              </div>

              <div className="flex items-start gap-2 text-xs text-text-muted">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-text-faint" />
                <p>
                  The imported funnel lands as a <strong className="text-text-primary">draft</strong> with no domain
                  attached. Nothing it contains can serve until you publish it.
                </p>
              </div>

              {error && <p className="text-sm text-red-400">{error}</p>}

              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => { setEnvelope(null); setError(null); }} disabled={importing}>
                  Back
                </Button>
                <Button onClick={submit} loading={importing}>
                  Import {summary.pageCount} page{summary.pageCount === 1 ? '' : 's'}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
