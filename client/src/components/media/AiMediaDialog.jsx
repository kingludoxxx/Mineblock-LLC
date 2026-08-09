// AI MEDIA — "AI Media · CLAUDE × HIGGSFIELD".
//
// Two ways to fill one image slot, side by side: generate a new one, or pick
// one you already have. Both hand the caller the SAME asset object, so a
// call-site can swap this dialog and MediaPicker for each other without
// touching a line of its own code.
//
// ═══════════════════════════════════════════════════════════════════════════
// INTEGRATION CONTRACT — identical to MediaPicker's, deliberately.
// ═══════════════════════════════════════════════════════════════════════════
//
//   import { AiMediaDialog } from '../../components/media';
//
//   <AiMediaDialog
//     open={aiMediaOpen}
//     onClose={() => setAiMediaOpen(false)}
//     onSelect={(asset) => {
//       updateBlockProps(blockId, { src: asset.url, alt: asset.alt });
//       setAiMediaOpen(false);            // the dialog never closes itself
//     }}
//   />
//
// onSelect receives ONE argument:
//
//   { url: string (non-empty, absolute https),
//     alt: string,
//     width: number|null, height: number|null,
//     id: string,                      // lb_media.id
//     mime: string, bytes: number|null,
//     source: 'upload'|'url' }
//
// The full field-by-field contract lives in MediaLibraryModal.jsx's header —
// this file satisfies it, it does not redefine it.
//
// GUARANTEES the caller may rely on (the same three MediaPicker gives):
//   • onSelect fires at most once per interaction, and only for a NON-archived
//     asset with a non-empty url.
//   • the dialog NEVER closes itself; the caller owns `open`.
//   • no builder/page state is read or written here.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY A GENERATED IMAGE IS AN ORDINARY LIBRARY ASSET
// ═══════════════════════════════════════════════════════════════════════════
// The server re-hosts every finished generation into lb_media before it tells
// this dialog the job is done (routes/aiMedia.js). So the "Recent" grid and
// the "From files" grid are showing rows from the SAME table — Recent is just
// the slice this dialog created. There is no second store, no "AI images"
// bucket to keep in sync, and no third-party URL on a published page.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE "From files" GRID
// ═══════════════════════════════════════════════════════════════════════════
// MediaLibraryModal renders a full-screen overlay and does not export its grid,
// so an inline tab cannot mount it without nesting one modal inside another.
// This file therefore reads the SAME endpoint (GET /media) and builds the
// asset object with the SAME field mapping and the SAME two guards
// (MediaLibraryModal.jsx:317-332). That mapping is the contract; if it ever
// changes there, change it here in the same commit.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X, RefreshCw, Loader2, AlertCircle, Check, ImageIcon, Wallet,
} from 'lucide-react';
import api from '../../services/api';
import Button from '../ui/Button';

// Mirrors the server allowlists (routes/aiMedia.js ASPECTS / QUALITIES /
// BATCHES). A value this dropdown cannot produce is a 400, by design.
const ASPECTS = ['9:16', '1:1', '16:9', '4:5', '3:4'];
const QUALITIES = ['1080p', '720p'];
const BATCHES = [1, 2, 4];
const MAX_PROMPT = 2000;

const EXAMPLE_PROMPTS = [
  'Hero shot of a tactical water filter on a mountain ledge, golden hour',
  'Slow cinematic push-in on product, dust particles',
];

// The AIDeveloperPanel cadence, unchanged: 3s normally, 10s after 5 consecutive
// failures, and after ~100 attempts the card flips to a retryable stale state
// rather than polling a dead job forever.
const POLL_MS = 3000;
const POLL_SLOW_MS = 10_000;
const POLL_BACKOFF_AFTER = 5;
const MAX_POLL_ATTEMPTS = 100;

const LIBRARY_PAGE_SIZE = 60;

// The API answers { success:false, error:{ code, message } }. Codes are
// operator-actionable, so the message is surfaced rather than a generic string.
const errCode = (err) => err?.response?.data?.error?.code || '';
const errText = (err, fallback) =>
  err?.response?.data?.error?.message
  || err?.response?.data?.error?.code
  || err?.message
  || fallback;

// lb_media row -> the asset object every caller of this family receives.
const toAsset = (item) => ({
  url: item.url,
  alt: item.alt || '',
  width: item.width ?? null,
  height: item.height ?? null,
  id: item.id,
  mime: item.mime || '',
  bytes: item.bytes ?? null,
  source: item.source,
});

/**
 * @param {object}   props
 * @param {boolean}  props.open
 * @param {Function} props.onClose
 * @param {Function} props.onSelect   see the contract above
 * @param {string}   [props.title]
 * @param {string}   [props.subtitle]
 */
export default function AiMediaDialog({ open, onClose, onSelect, title, subtitle }) {
  // ── generation form ──────────────────────────────────────────────────────
  const [prompt, setPrompt] = useState('');
  const [aspect, setAspect] = useState(ASPECTS[0]);
  const [quality, setQuality] = useState(QUALITIES[0]);
  const [batch, setBatch] = useState(1);

  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState('');
  // Credits are NOT an error. They are a state the operator fixes with a card,
  // and a red toast per failed generation is the behaviour this flag exists to
  // prevent — one calm amber note, cleared the moment a generation starts.
  const [creditsEmpty, setCreditsEmpty] = useState(false);

  // ── results ──────────────────────────────────────────────────────────────
  // { jobId, token, prompt, status:'running'|'completed'|'failed'|'stale',
  //   media, error }
  const [jobs, setJobs] = useState([]);
  const [tab, setTab] = useState('recent');
  const [picked, setPicked] = useState('');

  // ── library tab ──────────────────────────────────────────────────────────
  const [files, setFiles] = useState([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState('');
  // "attempted", NOT "loaded" — see loadFiles for why the distinction is the
  // difference between one request and a few thousand.
  const [filesAttempted, setFilesAttempted] = useState(false);

  const promptRef = useRef(null);
  const pollState = useRef({}); // jobId -> { timer, attempts, failures, token }

  const charCount = prompt.length;

  // ── polling ──────────────────────────────────────────────────────────────
  const patchJob = useCallback((jobId, patch) => {
    setJobs((prev) => prev.map((j) => (j.jobId === jobId ? { ...j, ...patch } : j)));
  }, []);

  const stopAllPolling = useCallback(() => {
    Object.values(pollState.current).forEach((s) => clearTimeout(s.timer));
    pollState.current = {};
  }, []);

  // Unmount must not leave a timer chain running against a dead component.
  useEffect(() => () => stopAllPolling(), [stopAllPolling]);

  const startPolling = useCallback((jobId, token, { immediate = false } = {}) => {
    const existing = pollState.current[jobId];
    if (existing?.timer) clearTimeout(existing.timer);
    const st = { attempts: 0, failures: 0, token: token ?? existing?.token, timer: null };
    pollState.current[jobId] = st;

    // `st` IS this chain's identity. clearTimeout alone cannot stop a chain
    // whose request is already in flight: the await resolves after the close,
    // schedules the next tick, and that timer is unreachable by anything —
    // an immortal chain, one more per open/close cycle. So every resumption
    // point re-checks that the registry still points at THIS `st`. Closing
    // (stopAllPolling empties the registry) or superseding it (a new chain for
    // the same job) makes that check fail and the chain ends there.
    const superseded = () => pollState.current[jobId] !== st;

    const poll = async () => {
      if (superseded()) return;
      st.attempts += 1;

      let data = null;
      let error = null;
      try {
        const res = await api.get(`/ai-media/jobs/${jobId}`, {
          // Job -> user binding: the HMAC tag issued with the job, in a HEADER,
          // never in the URL.
          headers: st.token ? { 'X-Job-Token': st.token } : {},
        });
        data = res.data?.data ?? null;
      } catch (err) {
        error = err;
      }

      // ── the resumption guard ──
      if (superseded()) return;

      if (error) {
        const c = errCode(error);
        // 402 mid-poll is the same operator-actionable state the submit path
        // surfaces — say it once, and let the card keep its own retry.
        if (c === 'not_enough_credits') setCreditsEmpty(true);
        // Storage being unconfigured is not transient and not the operator's
        // typo — it is an infra fact with a named fix. Polling it 100 times
        // changes nothing, so the card stops and says what is wrong.
        if (c === 'storage_unavailable') {
          delete pollState.current[jobId];
          patchJob(jobId, {
            status: 'blocked',
            error: errText(error, 'The image cannot be saved — no CDN backend is configured.'),
          });
          return;
        }
        st.failures += 1; // transient — back off below
      } else {
        st.failures = 0;
        if (data && data.status === 'completed' && data.media) {
          delete pollState.current[jobId];
          patchJob(jobId, { status: 'completed', media: data.media, error: null });
          // A finished generation is now a library row, so a library tab the
          // operator already opened is stale. Let it refetch once.
          setFilesAttempted(false);
          return;
        }
        if (data && data.status === 'failed') {
          delete pollState.current[jobId];
          patchJob(jobId, {
            status: 'failed',
            error: data.error || 'The generation failed.',
            // The server says when a refusal is final; a card that knows this
            // does not offer a Retry that cannot work.
            permanent: Boolean(data.permanent),
          });
          return;
        }
      }

      if (st.attempts >= MAX_POLL_ATTEMPTS) {
        delete pollState.current[jobId];
        patchJob(jobId, { status: 'stale' });
        return;
      }
      st.timer = setTimeout(poll, st.failures >= POLL_BACKOFF_AFTER ? POLL_SLOW_MS : POLL_MS);
    };

    st.timer = setTimeout(poll, immediate ? 0 : POLL_MS);
  }, [patchJob]);

  const retryJob = useCallback((job) => {
    // A permanently-refused generation has no retry to offer; the card does not
    // render the button, and this is the second half of that guarantee.
    if (job.permanent && job.status !== 'blocked' && job.status !== 'stale') return;
    patchJob(job.jobId, { status: 'running', error: null, permanent: false });
    startPolling(job.jobId, job.token, { immediate: true });
  }, [patchJob, startPolling]);

  // ── library ──────────────────────────────────────────────────────────────
  const loadFiles = useCallback(async () => {
    // ATTEMPTED, not LOADED, and set in `finally`. Gating the effect on
    // success means a FAILING /media request re-satisfies the effect's
    // condition the instant `filesLoading` drops back to false — the effect
    // fires again, fails again, forever, thousands of requests deep, and the
    // error panel it is supposed to render never survives a frame. The flag
    // that stops the loop must be set on BOTH outcomes; the only way back in
    // is an explicit operator action (Try again / Refresh) or a finished
    // generation, both of which call this function directly.
    setFilesAttempted(true);
    setFilesLoading(true);
    setFilesError('');
    try {
      const { data } = await api.get('/media', {
        params: { limit: LIBRARY_PAGE_SIZE, offset: 0, archived: false },
      });
      setFiles(Array.isArray(data.items) ? data.items : []);
    } catch (err) {
      setFilesError(errText(err, 'Could not load the media library.'));
      setFiles([]);
    } finally {
      setFilesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open || tab !== 'files' || filesAttempted) return;
    loadFiles();
  }, [open, tab, filesAttempted, loadFiles]);

  // Closing resets the transient bits so a previous session's banner never
  // greets the next one. Results are kept — reopening to grab the second image
  // of a batch is the common case, and throwing them away would mean paying
  // twice for it.
  useEffect(() => {
    if (open) return;
    setGenError('');
    setPicked('');
    stopAllPolling();
  }, [open, stopAllPolling]);

  // Re-arm polling for anything still running when the dialog reopens.
  useEffect(() => {
    if (!open) return;
    jobs.forEach((j) => {
      if (j.status === 'running' && !pollState.current[j.jobId]) {
        startPolling(j.jobId, j.token, { immediate: true });
      }
    });
    // `jobs` is intentionally not a dependency: this re-arms on OPEN, and
    // newly created jobs start their own poll in generate().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, startPolling]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // ── generate ─────────────────────────────────────────────────────────────
  const generate = useCallback(async () => {
    const text = prompt.trim();
    if (!text || generating) return;
    setGenerating(true);
    setGenError('');
    setCreditsEmpty(false);
    try {
      const { data } = await api.post('/ai-media/generate', {
        prompt: text, aspect, quality, batch,
      });
      const started = Array.isArray(data.jobs) ? data.jobs : [];
      setJobs((prev) => [
        ...started.map((j) => ({
          jobId: j.job_id,
          token: j.job_token,
          prompt: text,
          status: 'running',
          media: null,
          error: null,
        })),
        ...prev,
      ]);
      started.forEach((j) => startPolling(j.job_id, j.job_token));
      setTab('recent');
      // A partial batch is stated, never swallowed: an operator who asked for
      // four and got two must be told, or they will believe they got four.
      if (data.partial) {
        if (data.partial.code === 'not_enough_credits') setCreditsEmpty(true);
        else setGenError(`Only ${data.partial.started} of ${data.partial.requested} started — ${data.partial.message}`);
      }
    } catch (err) {
      if (errCode(err) === 'not_enough_credits') setCreditsEmpty(true);
      else setGenError(errText(err, 'Could not start the generation.'));
    } finally {
      setGenerating(false);
    }
  }, [prompt, aspect, quality, batch, generating, startPolling]);

  // ── selection — the ONLY place onSelect is ever called ───────────────────
  const choose = useCallback((item) => {
    // Both halves of the documented guarantee, asserted here: a non-empty url
    // and never an archived asset.
    if (!item?.url || item.archived) return;
    setPicked(item.id);
    onSelect?.(toAsset(item));
  }, [onSelect]);

  const refreshRight = useCallback(() => {
    if (tab === 'files') { loadFiles(); return; }
    jobs.forEach((j) => {
      if (j.status === 'running') startPolling(j.jobId, j.token, { immediate: true });
    });
  }, [tab, loadFiles, jobs, startPolling]);

  const runningCount = useMemo(() => jobs.filter((j) => j.status === 'running').length, [jobs]);
  const generateLabel = `Generate ${batch} image${batch === 1 ? '' : 's'}`;

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div
        className="w-full max-w-5xl max-h-[88vh] flex flex-col bg-bg-card border border-border-default rounded-xl shadow-2xl overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label={title || 'AI Media'}
      >
        {/* ── header ─────────────────────────────────────────────────────── */}
        <div className="flex items-start gap-3 px-5 py-3.5 border-b border-border-default shrink-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-text-primary truncate">{title || 'AI Media'}</h2>
              <span className="shrink-0 px-1.5 py-0.5 rounded border border-accent/40 bg-accent/10 text-accent text-[10px] font-semibold tracking-wide">
                CLAUDE × HIGGSFIELD
              </span>
            </div>
            <p className="mt-0.5 text-[11px] text-text-muted">
              {subtitle || 'Filling the selected image — generate one or pick from your files.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* ── body: two columns ──────────────────────────────────────────── */}
        <div className="flex-1 min-h-0 flex flex-col md:flex-row">

          {/* ── LEFT: the generation form ─────────────────────────────────── */}
          <div className="md:w-[340px] shrink-0 md:border-r border-border-default overflow-y-auto px-5 py-4 space-y-4">
            <div>
              <div className="flex items-baseline justify-between mb-1.5">
                <label htmlFor="ai-media-prompt" className="text-[10px] font-semibold tracking-widest text-text-muted">
                  PROMPT
                </label>
                <span
                  className={`text-[10px] tabular-nums ${charCount >= MAX_PROMPT ? 'text-danger' : 'text-text-faint'}`}
                  aria-label={`${charCount} of ${MAX_PROMPT} characters used`}
                >
                  {charCount}
                </span>
              </div>
              <textarea
                id="ai-media-prompt"
                ref={promptRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value.slice(0, MAX_PROMPT))}
                maxLength={MAX_PROMPT}
                rows={7}
                placeholder="Describe the image you want…"
                className="w-full px-3 py-2 rounded-lg bg-bg-elevated border border-border-default text-text-primary text-sm placeholder:text-text-faint resize-none focus:outline-none focus:border-accent/60"
              />
            </div>

            <div>
              <label htmlFor="ai-media-aspect" className="block text-[10px] font-semibold tracking-widest text-text-muted mb-1.5">
                ASPECT
              </label>
              <select
                id="ai-media-aspect"
                value={aspect}
                onChange={(e) => setAspect(e.target.value)}
                className="w-full px-3 py-1.5 rounded-lg bg-bg-elevated border border-border-default text-text-primary text-sm focus:outline-none focus:border-accent/60 cursor-pointer"
              >
                {ASPECTS.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>

            <div>
              <label htmlFor="ai-media-quality" className="block text-[10px] font-semibold tracking-widest text-text-muted mb-1.5">
                QUALITY
                <span
                  className="ml-1.5 normal-case tracking-normal text-text-faint"
                  title="Recorded with the job, but not yet forwarded to Higgsfield — the generation service only accepts prompt + aspect ratio today."
                >
                  (recorded, not yet applied)
                </span>
              </label>
              <select
                id="ai-media-quality"
                value={quality}
                onChange={(e) => setQuality(e.target.value)}
                title="Recorded with the job, but not yet forwarded to Higgsfield — the generation service only accepts prompt + aspect ratio today."
                className="w-full px-3 py-1.5 rounded-lg bg-bg-elevated border border-border-default text-text-primary text-sm focus:outline-none focus:border-accent/60 cursor-pointer"
              >
                {QUALITIES.map((q) => <option key={q} value={q}>{q}</option>)}
              </select>
            </div>

            <div>
              <span className="block text-[10px] font-semibold tracking-widest text-text-muted mb-1.5">BATCH</span>
              <div role="group" aria-label="Batch size" className="inline-flex rounded-lg border border-border-default overflow-hidden">
                {BATCHES.map((n, i) => (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={batch === n}
                    onClick={() => setBatch(n)}
                    className={`px-4 py-1.5 text-xs cursor-pointer transition-colors ${i > 0 ? 'border-l border-border-default' : ''} ${
                      batch === n
                        ? 'bg-accent/15 text-accent font-semibold'
                        : 'bg-bg-elevated text-text-muted hover:text-text-primary hover:bg-bg-hover'
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            <Button
              size="md"
              className="w-full"
              onClick={generate}
              loading={generating}
              disabled={!prompt.trim() || generating}
            >
              {!generating && <span aria-hidden="true">✦</span>}
              {generateLabel}
            </Button>

            {creditsEmpty && (
              <div className="px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs flex items-start gap-2">
                <Wallet className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>Higgsfield credits are empty — top up to generate</span>
              </div>
            )}
            {genError && (
              <div className="px-3 py-2 rounded-lg bg-danger/10 border border-danger/30 text-danger text-xs flex items-start gap-2">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span className="min-w-0 break-words">{genError}</span>
              </div>
            )}
          </div>

          {/* ── RIGHT: results / library ──────────────────────────────────── */}
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="flex items-center gap-1 px-5 py-2.5 border-b border-border-default shrink-0">
              <button
                type="button"
                aria-pressed={tab === 'recent'}
                onClick={() => setTab('recent')}
                className={`px-2.5 py-1 rounded-md text-xs cursor-pointer transition-colors ${
                  tab === 'recent' ? 'bg-bg-elevated text-text-primary' : 'text-text-muted hover:text-text-primary'
                }`}
              >
                <span aria-hidden="true">✦</span> Recent
                {runningCount > 0 && <span className="ml-1 text-text-faint">({runningCount})</span>}
              </button>
              <span className="text-text-faint text-xs" aria-hidden="true">|</span>
              <button
                type="button"
                aria-pressed={tab === 'files'}
                onClick={() => setTab('files')}
                className={`px-2.5 py-1 rounded-md text-xs cursor-pointer transition-colors ${
                  tab === 'files' ? 'bg-bg-elevated text-text-primary' : 'text-text-muted hover:text-text-primary'
                }`}
              >
                <span aria-hidden="true">📁</span> From files
              </button>
              <button
                type="button"
                onClick={refreshRight}
                title="Refresh"
                aria-label="Refresh"
                className="ml-auto p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer"
              >
                <RefreshCw className={`w-4 h-4 ${filesLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
              {/* ── RECENT ───────────────────────────────────────────────── */}
              {tab === 'recent' && !jobs.length && (
                <div className="h-full min-h-56 flex flex-col items-center justify-center gap-3 text-center">
                  <ImageIcon className="w-8 h-8 text-text-faint" />
                  <p className="text-sm text-text-primary">No media yet — Try one of these to get started:</p>
                  <div className="flex flex-col gap-2 items-center max-w-md">
                    {EXAMPLE_PROMPTS.map((ex) => (
                      <button
                        key={ex}
                        type="button"
                        onClick={() => { setPrompt(ex.slice(0, MAX_PROMPT)); promptRef.current?.focus(); }}
                        className="px-3 py-1.5 rounded-full border border-border-default bg-bg-elevated text-text-muted hover:text-text-primary hover:border-border-strong text-xs text-left cursor-pointer transition-colors"
                      >
                        {ex}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {tab === 'recent' && Boolean(jobs.length) && (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {jobs.map((job) => (
                    <JobCard
                      key={job.jobId}
                      job={job}
                      picked={picked === job.media?.id}
                      onUse={() => choose(job.media)}
                      onRetry={() => retryJob(job)}
                    />
                  ))}
                </div>
              )}

              {/* ── FROM FILES ───────────────────────────────────────────── */}
              {tab === 'files' && filesLoading && !files.length && (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="aspect-square rounded-lg bg-bg-elevated border border-border-default animate-pulse" />
                  ))}
                </div>
              )}

              {tab === 'files' && !filesLoading && filesError && (
                <div className="h-56 flex flex-col items-center justify-center gap-3 text-center">
                  <AlertCircle className="w-7 h-7 text-danger" />
                  <p className="text-sm text-text-primary">{filesError}</p>
                  <Button size="sm" variant="secondary" onClick={loadFiles}>Try again</Button>
                </div>
              )}

              {tab === 'files' && !filesLoading && !filesError && !files.length && (
                <div className="h-56 flex flex-col items-center justify-center gap-2 text-center">
                  <ImageIcon className="w-8 h-8 text-text-faint" />
                  <p className="text-sm text-text-primary">The library is empty.</p>
                  <p className="text-xs text-text-muted">Generate one on the left, or upload from the media library.</p>
                </div>
              )}

              {tab === 'files' && Boolean(files.length) && (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {files.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => choose(item)}
                      className={`group relative aspect-square rounded-lg border overflow-hidden bg-bg-main flex items-center justify-center cursor-pointer transition-colors ${
                        picked === item.id ? 'border-accent' : 'border-border-default hover:border-border-strong'
                      }`}
                      title={item.filename || item.url}
                    >
                      <img
                        src={item.url}
                        alt={item.alt || item.filename || ''}
                        loading="lazy"
                        className="max-w-full max-h-full object-contain"
                        onError={(e) => { e.currentTarget.style.display = 'none'; }}
                      />
                      <span className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-accent text-bg-main text-xs font-semibold">
                          {picked === item.id ? <Check className="w-3.5 h-3.5" /> : null}
                          Use this
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── footer ─────────────────────────────────────────────────────── */}
        <div className="px-5 py-3 border-t border-border-default shrink-0 flex items-center gap-2">
          <p className="text-[11px] text-text-faint truncate">
            Finished generations are saved to your media library — the library is the source of truth.
          </p>
          <div className="ml-auto">
            <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── one generation ─────────────────────────────────────────────────────────
// running -> spinner · completed -> thumbnail + "Use this" · failed -> the
// reason · stale -> retry. A failed card states WHY (the server sends an
// operator-readable reason) instead of a shrug.
function JobCard({ job, picked, onUse, onRetry }) {
  if (job.status === 'completed' && job.media) {
    return (
      <button
        type="button"
        onClick={onUse}
        title={job.prompt}
        className={`group relative aspect-square rounded-lg border overflow-hidden bg-bg-main flex items-center justify-center cursor-pointer transition-colors ${
          picked ? 'border-accent' : 'border-border-default hover:border-border-strong'
        }`}
      >
        <img
          src={job.media.url}
          alt={job.media.alt || job.prompt || ''}
          loading="lazy"
          className="max-w-full max-h-full object-contain"
          onError={(e) => { e.currentTarget.style.display = 'none'; }}
        />
        <span className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-accent text-bg-main text-xs font-semibold">
            {picked ? <Check className="w-3.5 h-3.5" /> : null}
            Use this
          </span>
        </span>
      </button>
    );
  }

  if (job.status === 'failed' || job.status === 'stale' || job.status === 'blocked') {
    // Three different things, three different affordances:
    //   stale    — we gave up asking; asking again is exactly the fix
    //   blocked  — infra (no CDN backend). Named cause, one retry once fixed
    //   failed   — upstream/asset verdict. `permanent` means OUR checks
    //              refused the bytes, so no amount of retrying changes it and
    //              offering the button would be a lie
    const isStale = job.status === 'stale';
    const isBlocked = job.status === 'blocked';
    const canRetry = isStale || isBlocked || !job.permanent;
    const tone = isBlocked ? 'text-amber-400' : isStale ? 'text-text-faint' : 'text-danger';
    return (
      <div className="aspect-square rounded-lg border border-border-default bg-bg-elevated flex flex-col items-center justify-center gap-2 p-3 text-center">
        <AlertCircle className={`w-6 h-6 ${tone}`} />
        <p className="text-[11px] text-text-muted break-words">
          {isStale ? 'Generation status unavailable.' : (job.error || 'The generation failed.')}
        </p>
        {job.permanent && !isBlocked && (
          <p className="text-[10px] text-text-faint">This one cannot be retried.</p>
        )}
        {canRetry && (
          <Button size="sm" variant="secondary" onClick={onRetry}>Retry</Button>
        )}
      </div>
    );
  }

  return (
    <div className="aspect-square rounded-lg border border-border-default bg-bg-elevated flex flex-col items-center justify-center gap-2 p-3 text-center">
      <Loader2 className="w-6 h-6 text-accent animate-spin" />
      <p className="text-[11px] text-text-muted line-clamp-3 break-words">{job.prompt}</p>
    </div>
  );
}
