// ─────────────────────────────────────────────────────────────────────────────
// ComposerPanels — the BRIEF + IMPORT controls at the top of the COMPOSER column.
//
// Two ways a static enters Composer:
//   BRIEF   "Describe a new static" — no League reference; the engine renders
//           from the product image plus a typed brief.
//   IMPORT  a .zip (or loose images) designed elsewhere, e.g. a batch exported
//           from Claude Design.
//
// The archive is unzipped IN THE BROWSER and posted one image per request — a
// 50-static export is ~80MB, past any single JSON body this API accepts. That
// also means one unreadable file cannot take the other 49 down with it, and
// progress is real rather than a spinner.
// ─────────────────────────────────────────────────────────────────────────────

import { useRef, useState, useCallback } from 'react';
import { Sparkles, Upload, Loader2, AlertTriangle, X, ChevronDown } from 'lucide-react';
import api from '../../../services/api';
import { readZip, pairEntries, bytesToBase64, isUnzipSupported, UnzipError } from './unzip';

const RATIOS = ['1:1', '4:5', '9:16'];
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;
// Matches the server's per-file ceiling so an oversized file is refused here,
// before spending upload time on it.
const MAX_FILE_BYTES = 25 * 1024 * 1024;

const mimeFor = (name) =>
  /\.jpe?g$/i.test(name) ? 'image/jpeg'
  : /\.webp$/i.test(name) ? 'image/webp'
  : 'image/png';

export default function ComposerPanels({ productId, productAngles = [], onImported }) {
  // ── Describe state ──
  const [briefOpen, setBriefOpen] = useState(false);
  const [brief, setBrief] = useState('');
  const [briefRatio, setBriefRatio] = useState('4:5');
  const [briefAngle, setBriefAngle] = useState('');
  const [describing, setDescribing] = useState(false);
  const [describeStep, setDescribeStep] = useState('');

  // ── Import state ──
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState(null);   // { imported, skipped, rows: [...] }
  const [error, setError] = useState(null);
  const fileInput = useRef(null);

  // ── Describe a new static ─────────────────────────────────────────────────
  const runDescribe = async () => {
    const text = brief.trim();
    if (!text) { setError('Describe what you want before generating'); return; }
    if (!productId) { setError('Select a product first — the static is rendered from its product image'); return; }
    setDescribing(true); setError(null); setDescribeStep('Submitting...');
    try {
      const res = await api.post('/statics-generation/composer/describe', {
        product_id: productId,
        brief: text,
        ratio: briefRatio,
        angle: briefAngle || null,
      });
      const taskId = res.data?.data?.taskId;
      if (!taskId) throw new Error('No taskId returned');

      // Poll. Ceiling generous enough for gpt-image-2 (~3min observed) plus the
      // R2 mirror; a hard stop beats spinning forever with no explanation.
      const deadline = Date.now() + 8 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 4000));
        const s = await api.get(`/statics-generation/status/${taskId}`);
        const d = s.data?.data || {};
        if (d.progress) setDescribeStep(d.progress);
        if (d.status === 'completed') {
          setBrief(''); setBriefOpen(false); setDescribeStep('');
          onImported?.();
          return;
        }
        if (d.status === 'error' || d.status === 'failed') {
          throw new Error(d.error || 'Generation failed');
        }
      }
      throw new Error('Timed out after 8 minutes — check the Composer column, it may still land');
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message);
    } finally {
      setDescribing(false); setDescribeStep('');
    }
  };

  // ── Import a .zip or loose images ─────────────────────────────────────────
  const ingest = useCallback(async (fileList) => {
    const dropped = Array.from(fileList || []);
    if (dropped.length === 0) return;
    setBusy(true); setError(null); setResult(null); setProgress({ done: 0, total: 0 });

    try {
      /** @type {Array<{name:string, bytes:Uint8Array, prompt:string|null, angle:string|null}>} */
      let files = [];
      const preErrors = [];

      for (const f of dropped) {
        if (/\.zip$/i.test(f.name)) {
          if (!isUnzipSupported()) {
            throw new Error('This browser cannot unzip archives — upload the images directly instead');
          }
          const zip = await readZip(await f.arrayBuffer());
          const paired = pairEntries(zip);
          files.push(...paired.files);
          preErrors.push(...paired.errors);
          if (paired.files.length === 0) {
            // Be specific: "nothing imported" with no reason is the failure mode
            // this whole panel exists to avoid.
            throw new Error(
              `No images found in ${f.name}. Expected .png/.jpg/.webp files` +
              (paired.skippedNonImages.length ? ` (found only: ${paired.skippedNonImages.slice(0, 4).join(', ')})` : '')
            );
          }
        } else if (IMAGE_RE.test(f.name)) {
          files.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()), prompt: null, angle: null });
        } else {
          preErrors.push({ name: f.name, reason: 'not a .zip or a .png/.jpg/.webp image' });
        }
      }

      if (files.length === 0) {
        throw new Error(preErrors[0]?.reason
          ? `Nothing to import — ${preErrors[0].name}: ${preErrors[0].reason}`
          : 'Nothing to import');
      }

      // Refuse oversized files up front rather than after the upload.
      const rows = [];
      const sendable = [];
      for (const f of files) {
        if (f.bytes.length > MAX_FILE_BYTES) {
          rows.push({ ok: false, name: f.name, reason: `${(f.bytes.length / 1048576).toFixed(1)}MB exceeds the 25MB per-file limit` });
        } else {
          sendable.push(f);
        }
      }
      rows.push(...preErrors.map(e => ({ ok: false, name: e.name, reason: e.reason })));
      setProgress({ done: 0, total: sendable.length });

      const totalBytes = files.reduce((n, f) => n + f.bytes.length, 0);
      const start = await api.post('/statics-generation/composer/import/start', {
        filename: dropped.length === 1 ? dropped[0].name : `${dropped.length} files`,
        bytes: totalBytes,
        total_files: sendable.length,
        product_id: productId || null,
      });
      const importId = start.data?.data?.id;
      if (!importId) throw new Error('Server did not return an import id');

      // Sequential on purpose: parallel uploads of 25MB payloads would spike
      // memory on a 512MB dyno, and ordered progress is easier to trust.
      for (const f of sendable) {
        try {
          const res = await api.post(`/statics-generation/composer/import/${importId}/file`, {
            name: f.name,
            mime: mimeFor(f.name),
            data: bytesToBase64(f.bytes),
            prompt: f.prompt,
            angle: f.angle,
            product_id: productId || null,
          });
          rows.push(res.data?.data || { ok: false, name: f.name, reason: 'no outcome returned' });
        } catch (err) {
          rows.push({ ok: false, name: f.name, reason: err.response?.data?.error?.message || err.message });
        }
        setProgress(p => ({ ...p, done: p.done + 1 }));
      }

      const fin = await api.post(`/statics-generation/composer/import/${importId}/finish`, { report: rows });
      const imported = rows.filter(r => r.ok).length;
      setResult({ imported, skipped: rows.length - imported, rows, status: fin.data?.data?.status });
      onImported?.();
    } catch (err) {
      setError(err instanceof UnzipError ? err.message : (err.response?.data?.error?.message || err.message));
    } finally {
      setBusy(false);
    }
  }, [productId, onImported]);

  const onDrop = (e) => {
    e.preventDefault(); e.stopPropagation();
    setDragOver(false);
    if (!busy) ingest(e.dataTransfer?.files);
  };

  return (
    <div className="space-y-3 mb-4">
      {/* ── BRIEF ─────────────────────────────────────────────────────────── */}
      <div className="bg-[#111] border border-white/[0.06] rounded-lg p-3">
        <p className="text-[10px] font-mono tracking-[0.15em] uppercase text-zinc-500 mb-2">Brief</p>
        {!briefOpen ? (
          <button
            type="button"
            onClick={() => { setBriefOpen(true); setError(null); }}
            className="w-full inline-flex items-center justify-center gap-2 h-9 rounded-lg text-[12px] font-semibold bg-violet-600 hover:bg-violet-500 text-white transition-colors cursor-pointer"
          >
            <Sparkles className="w-4 h-4" />
            Describe a new static
          </button>
        ) : (
          <div className="space-y-2">
            <textarea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              rows={4}
              autoFocus
              placeholder="e.g. a clean comparison chart on a kitchen counter, our device passing where three competitors fail, warm morning light"
              className="w-full bg-black/40 border border-white/[0.08] rounded-lg px-2.5 py-2 text-[12px] text-zinc-200 placeholder:text-zinc-600 resize-none focus:outline-none focus:border-violet-500/40"
            />
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <select
                  value={briefRatio}
                  onChange={(e) => setBriefRatio(e.target.value)}
                  className="w-full appearance-none h-8 pl-2 pr-7 rounded-lg text-[11px] font-mono bg-white/[0.05] border border-white/[0.08] text-zinc-200 cursor-pointer"
                >
                  {RATIOS.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                <ChevronDown className="w-3.5 h-3.5 absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
              </div>
              <div className="relative flex-[2]">
                <select
                  value={briefAngle}
                  onChange={(e) => setBriefAngle(e.target.value)}
                  className="w-full appearance-none h-8 pl-2 pr-7 rounded-lg text-[11px] font-mono bg-white/[0.05] border border-white/[0.08] text-zinc-200 cursor-pointer"
                >
                  <option value="">angle (optional)</option>
                  {productAngles.map((a) => {
                    const n = typeof a === 'string' ? a : (a?.name || '');
                    return n ? <option key={n} value={n}>{n}</option> : null;
                  })}
                </select>
                <ChevronDown className="w-3.5 h-3.5 absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={runDescribe}
                disabled={describing || !brief.trim()}
                className={`flex-1 inline-flex items-center justify-center gap-2 h-9 rounded-lg text-[12px] font-semibold transition-colors ${
                  describing || !brief.trim()
                    ? 'bg-white/[0.04] text-zinc-600 cursor-not-allowed'
                    : 'bg-violet-600 hover:bg-violet-500 text-white cursor-pointer'
                }`}
              >
                {describing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                {describing ? (describeStep || 'Generating...') : 'Generate'}
              </button>
              {!describing && (
                <button
                  type="button"
                  onClick={() => { setBriefOpen(false); setBrief(''); setError(null); }}
                  className="h-9 w-9 flex items-center justify-center rounded-lg bg-white/[0.05] border border-white/[0.08] text-zinc-500 hover:text-zinc-300 cursor-pointer"
                  title="Cancel"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── IMPORT ────────────────────────────────────────────────────────── */}
      <div className="bg-[#111] border border-white/[0.06] rounded-lg p-3">
        <p className="text-[10px] font-mono tracking-[0.15em] uppercase text-zinc-500 mb-2">Import</p>
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => !busy && fileInput.current?.click()}
          className={`border border-dashed rounded-lg px-3 py-5 text-center transition-colors ${
            busy ? 'cursor-wait border-white/[0.08]'
                 : `cursor-pointer ${dragOver ? 'border-violet-500/50 bg-violet-500/[0.06]' : 'border-white/[0.12] hover:border-white/25 bg-white/[0.01]'}`
          }`}
        >
          <input
            ref={fileInput}
            type="file"
            multiple
            accept=".zip,image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => { ingest(e.target.files); e.target.value = ''; }}
          />
          {busy ? (
            <div className="space-y-2">
              <Loader2 className="w-4 h-4 animate-spin text-violet-400 mx-auto" />
              <p className="text-[11px] font-mono text-zinc-300">
                {progress.total > 0 ? `Importing ${progress.done}/${progress.total}` : 'Reading archive...'}
              </p>
              {progress.total > 0 && (
                <div className="h-1 bg-white/[0.06] rounded overflow-hidden">
                  <div
                    className="h-full bg-violet-500 transition-all"
                    style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
                  />
                </div>
              )}
            </div>
          ) : (
            <>
              <Upload className="w-4 h-4 text-zinc-500 mx-auto mb-1.5" />
              <p className="text-[12px] text-zinc-300 font-medium">Drop a .zip or an image</p>
              <p className="text-[10px] text-zinc-600 mt-1 leading-relaxed">
                images/ + prompts/ with matching names, or a manifest.csv.
                <br />Format is read from the pixels — 1:1, 4:5, 9:16.
              </p>
            </>
          )}
        </div>

        {/* Outcome. A partial import must never read as a clean one. */}
        {result && (
          <div className={`mt-2 rounded-lg border px-2.5 py-2 ${
            result.skipped > 0 ? 'border-amber-500/25 bg-amber-500/[0.06]' : 'border-emerald-500/25 bg-emerald-500/[0.06]'
          }`}>
            <div className="flex items-start justify-between gap-2">
              <p className={`text-[11px] font-mono ${result.skipped > 0 ? 'text-amber-300' : 'text-emerald-300'}`}>
                {result.imported} imported{result.skipped > 0 ? ` · ${result.skipped} skipped` : ''}
              </p>
              <button
                type="button"
                onClick={() => setResult(null)}
                className="text-zinc-500 hover:text-zinc-300 cursor-pointer shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            {result.skipped > 0 && (
              <ul className="mt-1.5 space-y-0.5 max-h-32 overflow-y-auto custom-scrollbar">
                {result.rows.filter(r => !r.ok).map((r, i) => (
                  <li key={`${r.name}-${i}`} className="text-[10px] text-amber-200/80 leading-snug">
                    <span className="font-mono text-amber-200">{r.name}</span> — {r.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {error && (
          <div className="mt-2 rounded-lg border border-red-500/25 bg-red-500/[0.06] px-2.5 py-2 flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
            <p className="text-[11px] text-red-300 leading-snug flex-1">{error}</p>
            <button type="button" onClick={() => setError(null)} className="text-zinc-500 hover:text-zinc-300 cursor-pointer shrink-0">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
