import { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronDown, ChevronUp, RotateCcw, X, Loader2, ListChecks } from 'lucide-react';
import api from '../../../services/api';

// ---------------------------------------------------------------------------
// QueueStrip — batch brief-generation queue status strip.
//
// Sits above the GENERATED column card list. Polls GET /brief-pipeline/queue
// every 5s while any job is queued/transcribing/generating; stops when idle.
// Renders nothing when there are no visible jobs.
//
// Props:
//   refreshKey   (number)   — bump to force an immediate refetch (e.g. right
//                             after a POST /brief-pipeline/queue succeeds)
//   onJobComplete (function) — called whenever a job transitions to 'complete'
//                             between polls (parent refreshes the briefs list)
// ---------------------------------------------------------------------------

const ACTIVE_STATUSES = ['queued', 'transcribing', 'generating'];

const STATUS_CHIP = {
  queued:       'bg-zinc-500/10 text-zinc-400 border-zinc-500/25',
  transcribing: 'bg-blue-500/10 text-blue-400 border-blue-500/25',
  generating:   'bg-violet-500/10 text-violet-400 border-violet-500/25',
  complete:     'bg-emerald-500/10 text-emerald-400 border-emerald-500/25',
  failed:       'bg-red-500/10 text-red-400 border-red-500/25',
  canceled:     'bg-zinc-500/10 text-zinc-500 border-zinc-500/25',
};

const STATUS_LABEL = {
  queued: 'Queued',
  transcribing: 'Transcribing',
  generating: 'Generating',
  complete: 'Done',
  failed: 'Failed',
  canceled: 'Canceled',
};

export default function QueueStrip({ refreshKey = 0, onJobComplete }) {
  const [jobs, setJobs] = useState([]);
  const [summary, setSummary] = useState({ queued: 0, running: 0, complete: 0, failed: 0 });
  // null = auto (expanded while active, collapsed when all settled);
  // true/false = explicit operator override via the chevron.
  const [expandedOverride, setExpandedOverride] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [clearing, setClearing] = useState(false);

  // Prior status per job id — used to detect the -> complete transition.
  const prevStatusesRef = useRef({});
  const onJobCompleteRef = useRef(onJobComplete);
  onJobCompleteRef.current = onJobComplete;

  const fetchQueue = useCallback(async () => {
    try {
      const { data } = await api.get('/brief-pipeline/queue');
      const nextJobs = Array.isArray(data?.jobs) ? data.jobs : [];

      // Detect jobs that flipped to complete since the last poll. The FIRST
      // fetch also counts completed jobs as "new": if the page was opened
      // after the queue finished (or the board's own fetch failed during a
      // deploy restart), this nudges the parent to refetch the briefs list
      // so completed work is never invisible. fetchGenerated is idempotent —
      // one extra GET on mount is the whole cost.
      const prev = prevStatusesRef.current;
      const isFirstFetch = Object.keys(prev).length === 0;
      const anyCompleted = nextJobs.some(
        (j) => j.status === 'complete' && (isFirstFetch || (prev[j.id] !== undefined && prev[j.id] !== 'complete'))
      );
      const nextMap = {};
      for (const j of nextJobs) nextMap[j.id] = j.status;
      prevStatusesRef.current = nextMap;

      setJobs(nextJobs);
      setSummary(data?.summary || { queued: 0, running: 0, complete: 0, failed: 0 });

      if (anyCompleted && typeof onJobCompleteRef.current === 'function') {
        onJobCompleteRef.current();
      }
    } catch (err) {
      // Keep the strip quiet on transient fetch errors — next poll retries.
      console.error('QueueStrip: failed to fetch queue:', err);
    }
  }, []);

  // Initial fetch + refetch whenever the parent bumps refreshKey
  // (a fresh queue POST makes the strip appear immediately).
  useEffect(() => {
    fetchQueue();
  }, [fetchQueue, refreshKey]);

  const hasActive = jobs.some((j) => ACTIVE_STATUSES.includes(j.status));

  // Poll every 5s while anything is queued/transcribing/generating; the
  // interval tears down automatically once the queue settles.
  useEffect(() => {
    if (!hasActive) return undefined;
    const timer = setInterval(fetchQueue, 5000);
    return () => clearInterval(timer);
  }, [hasActive, fetchQueue]);

  const handleRetry = useCallback(async (id) => {
    setBusyId(id);
    try {
      await api.post(`/brief-pipeline/queue/${id}/retry`);
      await fetchQueue();
    } catch (err) {
      console.error('QueueStrip: retry failed:', err);
    } finally {
      setBusyId(null);
    }
  }, [fetchQueue]);

  const handleCancel = useCallback(async (id) => {
    setBusyId(id);
    try {
      await api.delete(`/brief-pipeline/queue/${id}`);
      await fetchQueue();
    } catch (err) {
      console.error('QueueStrip: cancel failed:', err);
    } finally {
      setBusyId(null);
    }
  }, [fetchQueue]);

  const handleClearDone = useCallback(async () => {
    setClearing(true);
    try {
      await api.post('/brief-pipeline/queue/clear-done');
      await fetchQueue();
    } catch (err) {
      console.error('QueueStrip: clear-done failed:', err);
    } finally {
      setClearing(false);
    }
  }, [fetchQueue]);

  // Nothing queued in the visible window → render nothing at all.
  if (jobs.length === 0) return null;

  const expanded = expandedOverride !== null ? expandedOverride : hasActive;
  const doneCount = summary.complete || 0;

  const summaryParts = [
    summary.running ? `${summary.running} running` : null,
    summary.queued ? `${summary.queued} queued` : null,
    doneCount ? `${doneCount} done` : null,
    summary.failed ? `${summary.failed} failed` : null,
  ].filter(Boolean);

  return (
    <div className="mb-4 rounded-lg border border-white/[0.06] bg-zinc-900/60">
      {/* Summary row */}
      <button
        type="button"
        onClick={() => setExpandedOverride(!expanded)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 cursor-pointer group"
        title={expanded ? 'Collapse queue' : 'Expand queue'}
      >
        <div className="flex items-center gap-2 min-w-0">
          {hasActive
            ? <Loader2 className="w-3.5 h-3.5 text-[#c9a84c] animate-spin shrink-0" />
            : <ListChecks className="w-3.5 h-3.5 text-zinc-500 shrink-0" />}
          <span className="text-[10px] font-mono uppercase tracking-[0.15em] text-zinc-400 truncate">
            Queue · {summaryParts.length > 0 ? summaryParts.join(' · ') : `${jobs.length} jobs`}
          </span>
        </div>
        {expanded
          ? <ChevronUp className="w-3.5 h-3.5 text-zinc-500 group-hover:text-zinc-300 shrink-0" />
          : <ChevronDown className="w-3.5 h-3.5 text-zinc-500 group-hover:text-zinc-300 shrink-0" />}
      </button>

      {/* Expanded job rows */}
      {expanded && (
        <div className="border-t border-white/[0.04] px-3 py-2 space-y-1.5 max-h-56 overflow-y-auto">
          {jobs.map((job) => (
            <div key={job.id} className="flex items-center gap-2 min-w-0">
              <span
                className={`text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border shrink-0 ${STATUS_CHIP[job.status] || STATUS_CHIP.queued}`}
              >
                {STATUS_LABEL[job.status] || job.status}
              </span>
              <span
                className="text-[11px] text-zinc-300 truncate min-w-0 flex-1"
                title={job.status === 'failed' && job.error ? job.error : (job.headline || '')}
              >
                {job.headline || 'Untitled ad'}
                {job.brand_name && (
                  <span className="text-zinc-500 font-mono text-[10px]"> · {job.brand_name}</span>
                )}
              </span>
              {job.status === 'failed' && (
                <button
                  type="button"
                  onClick={() => handleRetry(job.id)}
                  disabled={busyId === job.id}
                  className="shrink-0 inline-flex items-center gap-1 text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border border-red-500/25 text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer disabled:opacity-50"
                  title={job.error || 'Retry this job'}
                >
                  {busyId === job.id
                    ? <Loader2 className="w-2.5 h-2.5 animate-spin" />
                    : <RotateCcw className="w-2.5 h-2.5" />}
                  Retry
                </button>
              )}
              {job.status === 'queued' && (
                <button
                  type="button"
                  onClick={() => handleCancel(job.id)}
                  disabled={busyId === job.id}
                  className="shrink-0 p-0.5 rounded text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer disabled:opacity-50"
                  title="Cancel this queued job"
                >
                  {busyId === job.id
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <X className="w-3 h-3" />}
                </button>
              )}
            </div>
          ))}

          {doneCount > 0 && (
            <div className="pt-1 flex justify-end">
              <button
                type="button"
                onClick={handleClearDone}
                disabled={clearing}
                className="inline-flex items-center gap-1 text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border border-white/[0.06] text-zinc-500 hover:text-zinc-200 hover:border-white/[0.12] transition-colors cursor-pointer disabled:opacity-50"
                title="Remove completed jobs from the strip"
              >
                {clearing && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
                Clear done
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
