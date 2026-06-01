import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  RefreshCw,
  Loader2,
  Sparkles,
  CheckCircle2,
  ExternalLink,
  Settings2,
  ChevronRight,
  MessageSquare,
  Play,
  MoreHorizontal,
  Send,
  Zap,
  FileText,
  Package,
  BookOpen,
  Upload,
  TrendingUp,
} from 'lucide-react';
import api from '../../services/api';
import ScriptGeneratorPanel from './briefs/ScriptGeneratorPanel';
import GeneratedBriefCard from './briefs/GeneratedBriefCard';
import ReferenceCard from './briefs/ReferenceCard';
import ReferencePreviewModal from './briefs/ReferencePreviewModal';
import LeagueImportModal from './briefs/LeagueImportModal';
import MetaVideoImportModal from './briefs/MetaVideoImportModal';
import ScriptUploadModal from './briefs/ScriptUploadModal';
import BriefDetailModal from './briefs/BriefDetailModal';
import PushToClickupModal from './briefs/PushToClickupModal';
import PipelineSettingsModal from './briefs/PipelineSettingsModal';
import LaunchTemplateEditor from './briefs/LaunchTemplateEditor';
import AdCopySetsManager from './briefs/AdCopySetsManager';

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const PIPELINE_COLUMNS = [
  {
    key: 'reference',
    label: 'Reference',
    icon: BookOpen,
    colorClass: 'text-violet-400 drop-shadow-[0_0_6px_rgba(167,139,250,0.5)]',
    badgeClass: 'bg-violet-500/10 text-violet-400 border-violet-500/25',
  },
  {
    key: 'generated',
    label: 'Generated',
    icon: Sparkles,
    colorClass: 'text-[#d4b55a] drop-shadow-[0_0_6px_rgba(201,168,76,0.5)]',
    badgeClass: 'bg-[#c9a84c]/10 text-[#d4b55a] border-[#c9a84c]/25',
  },
  {
    key: 'approved',
    label: 'Approved',
    icon: CheckCircle2,
    colorClass: 'text-emerald-400 drop-shadow-[0_0_6px_rgba(16,185,129,0.5)]',
    badgeClass: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25',
  },
  // Note: the "Pushed" column was removed in the League → Brief Pipeline rollout.
  // Briefs with status='pushed' in the DB now bucket into ready_to_launch so
  // they remain visible. The POST /generated/:id/push backend route is kept
  // for future auto-push-on-approve work.
  {
    key: 'ready_to_launch',
    label: 'Ready ClickUp',                     // renamed from "Ready to Launch"
    icon: Send,
    colorClass: 'text-blue-400 drop-shadow-[0_0_6px_rgba(96,165,250,0.5)]',
    badgeClass: 'bg-blue-500/10 text-blue-400 border-blue-500/25',
  },
  {
    key: 'launched',
    label: 'Launched',
    icon: Zap,
    colorClass: 'text-violet-400 drop-shadow-[0_0_6px_rgba(167,139,250,0.5)]',
    badgeClass: 'bg-violet-500/10 text-violet-400 border-violet-500/25',
  },
];

// ---------------------------------------------------------------------------
// BriefPipeline (main page)
// ---------------------------------------------------------------------------

export default function BriefPipeline() {
  // Data
  const [generated, setGenerated] = useState([]);
  const [references, setReferences] = useState([]);

  // Loading states
  const [loadingGenerated, setLoadingGenerated] = useState(false);
  // eslint-disable-next-line no-unused-vars
  const [loadingReferences, setLoadingReferences] = useState(false);
  // (Winning Ads sidebar removal: the legacy 'generating'/'generatingId'/
  // 'generatingStep' state belonged to that path and is gone. The
  // script-from-text flow uses 'scriptGenerating' below.)

  // UI state
  const [detailModal, setDetailModal] = useState(null);
  // Push-to-ClickUp modal: holds {id, naming_convention} of the brief being pushed.
  // Null = closed. Opening it fires GET /clickup-prefill internally.
  const [pushModal, setPushModal] = useState(null);
  const [error, setError] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [templateEditorOpen, setTemplateEditorOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [copySetsOpen, setCopySetsOpen] = useState(false);
  const [launchTemplates, setLaunchTemplates] = useState([]);
  const [launching, setLaunching] = useState(false);
  const [selectedForLaunch, setSelectedForLaunch] = useState([]);
  const [launchModalOpen, setLaunchModalOpen] = useState(false);
  const [leagueImportOpen, setLeagueImportOpen] = useState(false);
  const [metaImportOpen, setMetaImportOpen]     = useState(false);
  const [uploadOpen, setUploadOpen]             = useState(false);
  const [previewReference, setPreviewReference] = useState(null);

  // Prefill state for the Script Generator panel — populated when the user
  // imports a reference OR clicks "Generate Brief" / "Use as Reference".
  // The panel reads these as initialScript / initialMode / referenceLabel.
  const [scriptPrefill, setScriptPrefill] = useState({ script: null, mode: null, label: null });
  const scriptGenSectionRef = useRef(null);

  // Refs for cleanup and double-click guards
  const abortRef = useRef(false);
  const scriptGeneratingRef = useRef(false);
  const stepIntervalsRef = useRef([]);

  // ── Optimistic GENERATING placeholders ────────────────────────────
  // Each entry: { winner_id, referenceTitle, mode, startedAt, step, status }.
  // We push one on every /generate-from-script call so the operator sees an
  // immediate skeleton card in the GENERATED column — no more "is it working?"
  // staring at the page. The entry self-removes when the real brief lands
  // (matched by winner_id during fetchGenerated). Survives independently of
  // scriptGenerating so batch generations + sequential generations stack.
  const [pendingGenerations, setPendingGenerations] = useState([]);

  // ── Reference-column multi-select mode ────────────────────────────
  // Operator toggles "Select multiple" → checkboxes appear on every reference
  // card → a "Generate N briefs" button fires N parallel generations.
  const [referenceSelectMode, setReferenceSelectMode] = useState(false);
  const [selectedReferenceIds, setSelectedReferenceIds] = useState([]);

  // Cleanup on unmount: abort polling & clear all step intervals
  useEffect(() => {
    return () => {
      abortRef.current = true;
      stepIntervalsRef.current.forEach(id => clearInterval(id));
      stepIntervalsRef.current = [];
    };
  }, []);

  // Helper: spawn an optimistic placeholder card for a generation.
  // Returns a cancel fn that removes the placeholder (used on API failure).
  const spawnPendingGeneration = useCallback(({ winner_id, referenceTitle, mode }) => {
    const startedAt = Date.now();
    setPendingGenerations((prev) => [
      ...prev,
      { winner_id, referenceTitle: referenceTitle || 'Generating brief', mode: mode || 'clone', startedAt, step: 0 },
    ]);
    // Cycle through 3 step indices every 5s so the card feels alive.
    const interval = setInterval(() => {
      setPendingGenerations((prev) =>
        prev.map((p) =>
          p.winner_id === winner_id ? { ...p, step: Math.min(p.step + 1, 2) } : p
        )
      );
    }, 5000);
    stepIntervalsRef.current.push(interval);
    // Safety timeout — drop a card after 5 minutes if it never completes
    // (server crash, network drop, etc.). Operator can retry from the
    // source reference card.
    const safetyTimeout = setTimeout(() => {
      setPendingGenerations((prev) => prev.filter((p) => p.winner_id !== winner_id));
      clearInterval(interval);
    }, 5 * 60 * 1000);
    stepIntervalsRef.current.push(safetyTimeout);
  }, []);

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  const fetchGenerated = useCallback(async () => {
    setLoadingGenerated(true);
    try {
      const { data } = await api.get('/brief-pipeline/generated');
      const briefs = data.briefs || data || [];
      setGenerated(briefs);
      // Sweep pending placeholders that now have a real brief landed.
      // Match on winner_id — that's the row pointer we got back from
      // /generate-from-script. Cards that arrive get a swap into the real
      // GeneratedBriefCard renderer; pending entry is dropped here.
      const landed = new Set(briefs.map((b) => b.winner_id).filter(Boolean));
      setPendingGenerations((prev) => prev.filter((p) => !landed.has(p.winner_id)));
    } catch (err) {
      console.error('Failed to fetch generated briefs:', err);
    } finally {
      setLoadingGenerated(false);
    }
  }, []);

  const fetchLaunchTemplates = useCallback(async () => {
    try {
      const { data } = await api.get('/brief-pipeline/launch-templates');
      setLaunchTemplates(data.data || data || []);
    } catch (err) {
      console.error('Failed to fetch launch templates:', err);
    }
  }, []);

  const fetchReferences = useCallback(async () => {
    setLoadingReferences(true);
    try {
      const { data } = await api.get('/brief-pipeline/references');
      setReferences(data.references || []);
    } catch (err) {
      console.error('Failed to fetch references:', err);
    } finally {
      setLoadingReferences(false);
    }
  }, []);

  const refreshAll = useCallback(() => {
    fetchGenerated();
    fetchLaunchTemplates();
    fetchReferences();
  }, [fetchGenerated, fetchLaunchTemplates, fetchReferences]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  // Auto-poll references while any are in 'pending' state — META imports
  // transcribe asynchronously, so the column needs to flip cards from
  // "Transcribing…" to "Generate Iterations" without a manual refresh.
  // Polls every 4s, stops as soon as no rows are pending.
  useEffect(() => {
    // Poll while ANY reference is mid-pipeline: pending / extracting / transcribing.
    const anyPending = references.some(r =>
      r.status === 'pending' || r.status === 'extracting' || r.status === 'transcribing'
    );
    if (!anyPending) return;
    const id = setInterval(fetchReferences, 4000);
    return () => clearInterval(id);
  }, [references, fetchReferences]);

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const pollGenerationStatus = useCallback(async (winnerId, stepMessages, stepInterval, setStepFn) => {
    const maxAttempts = 40; // 40 × 3s = 2 min max
    let attempts = 0;
    let stepIdx = 1;

    const poll = () => new Promise((resolve, reject) => {
      const check = async () => {
        if (abortRef.current) {
          clearInterval(stepInterval);
          reject(new Error('Component unmounted — polling aborted.'));
          return;
        }
        try {
          attempts++;
          const { data } = await api.get(`/brief-pipeline/generation-status/${winnerId}`);
          if (abortRef.current) {
            clearInterval(stepInterval);
            reject(new Error('Component unmounted — polling aborted.'));
            return;
          }
          if (data.status === 'complete') {
            clearInterval(stepInterval);
            resolve(data);
            return;
          }
          if (data.status === 'failed') {
            clearInterval(stepInterval);
            // Surface the actual backend error (and which model was attempted)
            // instead of the generic "check server logs" — server now stamps
            // brief_pipeline_winners.generation_error so the operator sees the
            // root cause inline.
            const err = data.generation_error
              ? `Generation failed (model=${data.generation_model || 'unknown'}): ${data.generation_error}`
              : 'All brief generations failed. Check server logs.';
            reject(new Error(err));
            return;
          }
          // Still generating — update step message and continue
          if (attempts % 2 === 0 && stepIdx < stepMessages.length - 1) {
            stepIdx++;
            if (setStepFn && !abortRef.current) setStepFn(stepMessages[stepIdx]);
          }
          if (attempts >= maxAttempts) {
            clearInterval(stepInterval);
            reject(new Error('Generation timed out. Briefs may still be generating — refresh in a moment.'));
            return;
          }
          setTimeout(check, 3000);
        } catch (pollErr) {
          if (abortRef.current) {
            clearInterval(stepInterval);
            reject(new Error('Component unmounted — polling aborted.'));
            return;
          }
          if (attempts >= maxAttempts) {
            clearInterval(stepInterval);
            reject(pollErr);
            return;
          }
          setTimeout(check, 3000);
        }
      };
      check();
    });

    return poll();
  }, []);

  const handleApprove = useCallback(async (briefId) => {
    try {
      await api.patch(`/brief-pipeline/generated/${briefId}`, { status: 'approved' });
      await fetchGenerated();
    } catch (err) {
      console.error('Approve failed:', err);
    }
  }, [fetchGenerated]);

  const handleReject = useCallback(async (briefId) => {
    try {
      await api.patch(`/brief-pipeline/generated/${briefId}`, { status: 'rejected' });
      await fetchGenerated();
    } catch (err) {
      console.error('Reject failed:', err);
    }
  }, [fetchGenerated]);

  const handleDelete = useCallback(async (briefId) => {
    if (!briefId || typeof briefId !== 'string') {
      console.error('handleDelete called with invalid id:', briefId);
      setError('Failed to delete brief: invalid ID.');
      return;
    }
    // Optimistic remove — re-add on error
    const prev = generated;
    setGenerated(gs => gs.filter(g => g.id !== briefId));
    try {
      await api.delete(`/brief-pipeline/generated/${briefId}`);
      await fetchGenerated();
    } catch (err) {
      console.error('Delete failed:', err);
      setGenerated(prev);
      const apiMsg = err.response?.data?.error?.message || err.message;
      setError(`Failed to delete brief: ${apiMsg || 'unknown error'}`);
    }
  }, [generated, fetchGenerated]);

  const handleSaveBrief = useCallback(async (briefId, updates) => {
    try {
      await api.patch(`/brief-pipeline/generated/${briefId}`, updates);
      await fetchGenerated();
      setDetailModal(prev => prev ? { ...prev, ...updates } : null);
    } catch {
      setError('Failed to save brief changes.');
    }
  }, [fetchGenerated]);

  const [scriptGenerating, setScriptGenerating] = useState(false);
  const [scriptGenStep, setScriptGenStep] = useState('');

  const handleGenerateFromScript = useCallback(async (config) => {
    if (scriptGeneratingRef.current) return;
    scriptGeneratingRef.current = true;
    setScriptGenerating(true);
    setScriptGenStep('Extracting script...');
    let stepInterval;
    try {
      // Mode-specific step messages. Variants pipeline was removed; only
      // clone (single Claude call) and iterate (single Claude call) ship.
      const stepMessages = config.mode === 'iterate'
        ? ['Parsing winning script...', 'Generating iterations...', 'Finalizing cards...']
        : ['Parsing competitor script...', 'Cloning into our product...', 'Finalizing card...'];
      let stepIdx = 0;
      stepInterval = setInterval(() => {
        if (abortRef.current) { clearInterval(stepInterval); return; }
        stepIdx = Math.min(stepIdx + 1, stepMessages.length - 1);
        setScriptGenStep(stepMessages[stepIdx]);
      }, 5000);
      stepIntervalsRef.current.push(stepInterval);

      // Only 2 modes survive: clone (LEAGUE / UPLOAD source) and iterate
      // (META source). Anything else would error 500 server-side.
      const sendMode = config.mode === 'iterate' ? 'iterate' : 'clone';
      const { data } = await api.post('/brief-pipeline/generate-from-script', {
        script:          config.script,
        url:             config.url,
        productId:       config.productId,
        productCode:     config.productCode,
        angle:           config.angle,
        mode:            sendMode,
        numVariations:   config.numVariations,
        referenceId:     config.referenceId,
        // Iterate-mode vector picker payload. Backend buildIterationPrompt
        // expects [{ vector, target }] — Hooks / Format Swap / Avatar / etc.
        // Undefined in clone mode (server ignores it).
        vectorsSelected: config.vectorsSelected,
      });

      // Server responds immediately — poll for completion
      if (data.winner_id) {
        // Immediate optimistic skeleton card in GENERATED column. Survives
        // independently of the panel-level scriptGenerating flag so the
        // operator sees "GENERATING ad…" the second they click — no more
        // staring at the page wondering if it's working.
        spawnPendingGeneration({
          winner_id: data.winner_id,
          referenceTitle: config.referenceTitle || config.label || 'Generating brief',
          mode: sendMode,
        });
        setScriptGenStep(stepMessages[1] || 'Working...');
        await pollGenerationStatus(data.winner_id, stepMessages, stepInterval, setScriptGenStep);
      }

      clearInterval(stepInterval);
      if (!abortRef.current) {
        await fetchGenerated();
      }
    } catch (err) {
      clearInterval(stepInterval);
      if (!abortRef.current) {
        // Route structured 409 error codes to actionable messages.
        const errCode = err.response?.data?.error?.code;
        const errMsg = err.response?.data?.error?.message || err.message || 'Generation failed';
        const errHint = err.response?.data?.error?.hint;
        let msg = errMsg;
        switch (errCode) {
          case 'BRAND_MISMATCH':
            msg = `🚫 Brand mismatch: ${errMsg}\n\n${errHint || 'Delete this reference and re-import the correct ad.'}`;
            break;
          case 'REFERENCE_QUARANTINED':
            msg = `🚫 Reference quarantined: ${errMsg}\n\n${errHint || 'Delete and re-import — quarantine cannot be overridden.'}`;
            break;
          case 'AD_COPY_METADATA_ONLY':
            msg = `⚠ No real transcript: ${errMsg}\n\n${errHint || 'Retry Transcribe, or paste the script via Upload.'}`;
            break;
          case 'STATIC_AD_REFUSED':
            msg = `🚫 Static ad refused: ${errMsg}\n\n${errHint || 'Pick a video creative.'}`;
            break;
        }
        setError(msg);
        throw new Error(msg);
      }
    } finally {
      scriptGeneratingRef.current = false;
      if (!abortRef.current) {
        setScriptGenerating(false);
        setScriptGenStep('');
      }
    }
  }, [fetchGenerated, pollGenerationStatus, spawnPendingGeneration]);

  // ── Batch generate from N selected references ────────────────────
  // Fires N parallel /generate-from-script POSTs, one per selected
  // reference. Each one spawns its own skeleton card in GENERATED. Uses
  // the operator's currently-selected Product/Angle from the script
  // generator panel (read via global ref) or sensible defaults.
  // Exits select mode + clears selection on success.
  const handleBatchGenerateFromReferences = useCallback(async (refs, opts = {}) => {
    if (!Array.isArray(refs) || refs.length === 0) return;
    const productCode = opts.productCode || 'MR';
    const angle = opts.angle || null;
    try {
      await Promise.all(refs.map(async (ref) => {
        // Skip references with no transcript — backend would 400 anyway and
        // the empty skeleton would just timeout. Better to no-op silently.
        if (!ref?.transcript) return;
        const sendMode = ref.source === 'meta' ? 'iterate' : 'clone';
        try {
          const { data } = await api.post('/brief-pipeline/generate-from-script', {
            script: ref.transcript,
            productCode,
            angle,
            mode: sendMode,
            numVariations: 1,
            referenceId: ref.id,
          });
          if (data?.winner_id) {
            spawnPendingGeneration({
              winner_id: data.winner_id,
              referenceTitle: ref.headline || ref.brandName || ref.ad_name || 'Generating brief',
              mode: sendMode,
            });
          }
        } catch (e) {
          // Individual generation failed — log and keep going so the
          // remaining N-1 still fire. The skeleton for this one will
          // never appear (no spawn called), so visually it's just absent.
          console.error('[BriefPipeline] batch generate item failed:', e?.response?.data || e?.message);
        }
      }));
      // Quick refresh so any briefs that finished very fast (rare) appear
      // immediately. The poll on later ticks will catch the rest.
      setTimeout(() => { fetchGenerated(); }, 1500);
    } finally {
      setReferenceSelectMode(false);
      setSelectedReferenceIds([]);
    }
  }, [fetchGenerated, spawnPendingGeneration]);

  const handleMoveToReady = useCallback(async (briefId) => {
    try {
      await api.patch(`/brief-pipeline/generated/${briefId}`, { status: 'ready_to_launch' });
      await fetchGenerated();
    } catch (err) {
      console.error('Move to ready failed:', err);
      setError('Failed to move brief to Ready ClickUp.');
    }
  }, [fetchGenerated]);

  // Open the Push-to-ClickUp modal for a brief. Lightweight — the actual
  // prefill fetch happens inside the modal on mount.
  const handleOpenPushModal = useCallback((brief) => {
    setPushModal({
      id: brief.id,
      title: brief.naming_convention || brief.hooks?.[0]?.text || 'Brief',
    });
  }, []);

  // After a successful push, refresh the columns so the brief moves out of
  // Approved and into Ready ClickUp.
  const handlePushSuccess = useCallback(async () => {
    await fetchGenerated();
  }, [fetchGenerated]);

  // Mark a ready-to-launch brief as launched without going through the
  // Meta launcher (operator launched it manually outside the tool).
  const handleMarkLaunched = useCallback(async (briefId) => {
    try {
      await api.patch(`/brief-pipeline/generated/${briefId}`, { status: 'launched' });
      await fetchGenerated();
    } catch (err) {
      console.error('Mark launched failed:', err);
      setError('Failed to mark brief as launched.');
    }
  }, [fetchGenerated]);

  // Reverse transition: send a Ready brief back to Approved (UI for users
  // who can't drag, and for accidental "Move to Ready" clicks).
  const handleMoveBackToApproved = useCallback(async (briefId) => {
    try {
      await api.patch(`/brief-pipeline/generated/${briefId}`, { status: 'approved' });
      await fetchGenerated();
    } catch (err) {
      console.error('Move back to approved failed:', err);
      setError('Failed to move brief back to Approved.');
    }
  }, [fetchGenerated]);

  // ── League / Reference handlers ────────────────────────────────────────

  const applyReferencePrefill = useCallback((reference) => {
    if (!reference?.transcript) return;
    // META references generate iterations; LEAGUE/UPLOAD use clone mode.
    const mode = reference.source === 'meta' ? 'iterate' : 'clone';
    const tierOrSource = reference.source === 'meta'
      ? 'OUR WINNER'
      : reference.source === 'upload'
        ? 'UPLOAD'
        : reference.tier;
    setScriptPrefill({
      script: reference.transcript,
      mode,
      referenceId: reference.id,
      label: `${reference.brandName || 'Pasted'} · ${tierOrSource}`,
    });
    // Old setScriptPrefill block below is replaced — drop the trailing one.
    if (scriptGenSectionRef.current) {
      scriptGenSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  // After import: refresh refs AND auto-prefill the Script Generator so the
  // banner appears immediately (and gets re-applied on each subsequent import).
  const handleLeagueImported = useCallback(async (reference) => {
    await fetchReferences();
    if (reference) applyReferencePrefill(reference);
  }, [fetchReferences, applyReferencePrefill]);

  // META imports start with status='pending' (transcription is async). Hold
  // the reference id of the first imported row and apply the prefill as
  // soon as the polling loop sees its transcript become available.
  const [pendingMetaPrefillId, setPendingMetaPrefillId] = useState(null);
  const handleMetaImported = useCallback(async (importedRows) => {
    await fetchReferences();
    // Scroll to the Script Generator so the user sees the import landing
    if (scriptGenSectionRef.current) {
      scriptGenSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    // Watch the first imported ref id. When its transcript completes, we
    // auto-apply the prefill (mode='iterate' + label + script).
    const firstId = importedRows?.[0]?.id;
    if (firstId) setPendingMetaPrefillId(firstId);
  }, [fetchReferences]);

  // When the pending META ref's transcript finishes, apply the prefill once.
  useEffect(() => {
    if (!pendingMetaPrefillId) return;
    const ref = references.find(r => r.id === pendingMetaPrefillId);
    if (ref && ref.transcript) {
      applyReferencePrefill(ref);
      setPendingMetaPrefillId(null);
    }
  }, [pendingMetaPrefillId, references, applyReferencePrefill]);

  const handleDeleteReference = useCallback(async (refId) => {
    // Optimistic remove — re-add on error
    const prev = references;
    setReferences(rs => rs.filter(r => r.id !== refId));
    try {
      await api.delete(`/brief-pipeline/references/${refId}`);
    } catch (err) {
      console.error('Delete reference failed:', err);
      setReferences(prev);
      const apiMsg = err.response?.data?.error?.message || err.message;
      setError(`Failed to delete reference: ${apiMsg || 'unknown error'}`);
    }
  }, [references]);

  const handleRetryTranscribe = useCallback(async (refId) => {
    try {
      await api.post(`/brief-pipeline/references/${refId}/retry-transcribe`);
      // Refresh references — the poll loop will catch the status flip
      await fetchReferences();
    } catch (err) {
      // Route 409 error codes to actionable messages instead of the generic
      // "Retry failed: <message>" toast. These codes come from the backend
      // brand-mismatch / quarantine / concurrency guards and have specific
      // operator actions attached.
      const errCode = err.response?.data?.error?.code;
      const errMsg = err.response?.data?.error?.message || err.message;
      const errHint = err.response?.data?.error?.hint;
      switch (errCode) {
        case 'TRANSCRIBE_IN_FLIGHT':
          setError('A transcribe job is already running for this reference. Wait ~30s and click Refresh.');
          break;
        case 'BRAND_MISMATCH':
          setError(`Brand mismatch detected: ${errMsg}\n\nFix: Delete this reference and re-import a real Mineblock ad.`);
          break;
        case 'REFERENCE_QUARANTINED':
          setError(`Reference is quarantined: ${errMsg}\n\n${errHint || 'Delete and re-import.'}`);
          break;
        case 'AD_COPY_METADATA_ONLY':
          setError(`No real video transcript: ${errMsg}\n\n${errHint || ''}`);
          break;
        default:
          setError(`Retry failed: ${errMsg || 'unknown error'}`);
      }
    }
  }, [fetchReferences]);

  const handleGenerateFromReference = useCallback((reference) => {
    if (!reference?.transcript) {
      setError('This reference has no transcript yet — cannot generate.');
      return;
    }
    applyReferencePrefill(reference);
  }, [applyReferencePrefill]);

  const handlePreviewReference = useCallback((reference) => {
    setPreviewReference(reference);
  }, []);

  const handleClearScriptPrefill = useCallback(() => {
    setScriptPrefill({ script: null, mode: null, label: null });
  }, []);

  // ---------------------------------------------------------------------------
  // Drag & Drop
  // ---------------------------------------------------------------------------

  // Valid forward transitions (column key → allowed target columns).
  // The "pushed" column was removed from the UI; legacy in-DB pushed briefs
  // now appear in ready_to_launch via the bucketize step below.
  const VALID_TRANSITIONS = {
    reference:       [], // reference cards are not drag-targets
    generated:       ['approved', 'ready_to_launch'],
    approved:        ['generated', 'ready_to_launch'],
    ready_to_launch: ['approved'],
    launched:        [],
  };

  const [dragOverCol, setDragOverCol] = useState(null);

  const handleDragStart = useCallback((e, brief, fromCol) => {
    e.dataTransfer.setData('text/plain', JSON.stringify({ briefId: brief.id, fromCol }));
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback((e, colKey) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverCol(colKey);
  }, []);

  const handleDragLeave = useCallback((e) => {
    // Only clear if leaving the column (not entering a child)
    if (!e.currentTarget.contains(e.relatedTarget)) {
      setDragOverCol(null);
    }
  }, []);

  const handleDrop = useCallback(async (e, targetCol) => {
    e.preventDefault();
    setDragOverCol(null);
    try {
      const { briefId, fromCol } = JSON.parse(e.dataTransfer.getData('text/plain'));
      if (fromCol === targetCol) return;
      const allowed = VALID_TRANSITIONS[fromCol] || [];
      if (!allowed.includes(targetCol)) {
        setError(`Cannot move from "${fromCol}" to "${targetCol}".`);
        return;
      }
      // Map column key to actual status value
      const statusMap = {
        generated: 'generated',
        approved: 'approved',
        ready_to_launch: 'ready_to_launch',
      };
      const newStatus = statusMap[targetCol];
      if (!newStatus) return;

      await api.patch(`/brief-pipeline/generated/${briefId}`, { status: newStatus });
      await fetchGenerated();
    } catch (err) {
      console.error('Drop failed:', err);
      setError('Failed to move brief. ' + (err.response?.data?.error?.message || err.message || ''));
    }
  }, [fetchGenerated]);

  const handleLaunch = useCallback(async (briefIds, templateId, copySetId) => {
    setLaunching(true);
    try {
      const { data } = await api.post('/brief-pipeline/launch', {
        brief_ids: briefIds,
        template_id: templateId,
        copy_set_id: copySetId || null,
      });
      await fetchGenerated();
      setLaunchModalOpen(false);
      setSelectedForLaunch([]);
      const launched = (data.data?.results || []).filter(r => r.status === 'launched').length;
      const failed = (data.data?.results || []).filter(r => r.status === 'failed').length;
      if (failed > 0) {
        setError(`Launched ${launched} ads, ${failed} failed. Check launch history for details.`);
      }
    } catch (err) {
      console.error('Launch failed:', err);
      setError(err.response?.data?.error?.message || 'Launch failed.');
    } finally {
      setLaunching(false);
    }
  }, [fetchGenerated]);

  // ---------------------------------------------------------------------------
  // Bucket items into columns
  // ---------------------------------------------------------------------------

  const buckets = useMemo(() => {
    const map = { reference: [], generated: [], approved: [], ready_to_launch: [], launched: [] };

    for (const r of references) map.reference.push(r);

    for (const b of generated) {
      if (b.status === 'launched') {
        map.launched.push(b);
      } else if (b.status === 'ready_to_launch' || b.status === 'launching') {
        map.ready_to_launch.push(b);
      } else if (b.status === 'launch_failed') {
        map.ready_to_launch.push(b); // show failed ones back in ready column
      } else if (b.status === 'pushed') {
        // The Pushed column was removed — legacy pushed briefs surface here
        // so they remain visible until they get manually moved to launched.
        map.ready_to_launch.push(b);
      } else if (b.status === 'approved') {
        map.approved.push(b);
      } else if (b.status !== 'rejected') {
        map.generated.push(b);
      }
    }

    return map;
  }, [generated, references]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const isLoading = loadingGenerated;

  return (
    <div className="flex flex-col min-h-screen bg-[#111113] text-zinc-100 overflow-hidden relative">
      {/* Dot pattern background */}
      <div className="absolute inset-0 bg-dot-pattern pointer-events-none z-0 opacity-50" />

      {/* Subtle radial glow */}
      <div
        className="absolute inset-0 pointer-events-none z-0"
        style={{
          background: 'radial-gradient(ellipse 80% 50% at 50% -20%, rgba(201, 168, 76, 0.04) 0%, transparent 50%), radial-gradient(ellipse 60% 40% at 80% 100%, rgba(255, 255, 255, 0.02) 0%, transparent 50%)',
        }}
      />

      <div className="relative z-10 flex flex-col h-screen w-full">
        {/* Top nav breadcrumb */}
        <header className="h-14 bg-[#111113]/90 backdrop-blur-md flex items-center justify-between px-4 shrink-0 relative">
          <div className="absolute bottom-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-[#c9a84c]/15 to-transparent" />
          <div className="absolute bottom-0 left-0 right-0 h-[1px] bg-white/[0.04]" />

          <div className="flex items-center gap-2 text-xs font-mono tracking-wide">
            <span className="text-zinc-500 hover:text-zinc-300 cursor-pointer transition-colors">APP</span>
            <ChevronRight className="w-3.5 h-3.5 text-zinc-700" />
            <span className="text-zinc-500 hover:text-zinc-300 cursor-pointer transition-colors">PRODUCTION</span>
            <ChevronRight className="w-3.5 h-3.5 text-zinc-700" />
            <span className="text-[#e8d5a3] font-medium text-glow-gold">BRIEF_PIPELINE</span>
          </div>
        </header>

        {/* Page header */}
        <div className="h-16 border-b border-white/[0.04] bg-transparent flex items-center justify-between px-6 shrink-0 relative">
          <div className="absolute bottom-0 left-0 right-0 h-[1px] bg-gradient-to-r from-[#c9a84c]/10 via-transparent to-transparent" />

          <div className="flex items-center gap-3">
            <div className="relative flex items-center justify-center w-3 h-3">
              <div className="absolute w-full h-full bg-[#c9a84c] rounded-full opacity-30" style={{ animation: 'pulse-glow 2s ease-in-out infinite' }} />
              <div className="w-1.5 h-1.5 bg-[#d4b55a] rounded-full shadow-[0_0_8px_rgba(201,168,76,0.8)]" />
            </div>
            <h1 className="text-sm font-mono font-semibold text-white tracking-[0.2em] uppercase text-glow">
              Brief Pipeline
            </h1>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => { setEditingTemplate(null); setTemplateEditorOpen(true); }}
              className="inline-flex items-center justify-center gap-2 rounded-lg text-xs font-medium transition-all h-8 px-3
                         hover:bg-white/[0.05] text-zinc-400 hover:text-zinc-100 border border-transparent hover:border-white/[0.04]
                         cursor-pointer font-mono tracking-wide uppercase"
            >
              <FileText className="w-3.5 h-3.5" />
              Templates
            </button>

            <button
              type="button"
              onClick={() => setCopySetsOpen(true)}
              className="inline-flex items-center justify-center gap-2 rounded-lg text-xs font-medium transition-all h-8 px-3
                         hover:bg-white/[0.05] text-zinc-400 hover:text-zinc-100 border border-transparent hover:border-white/[0.04]
                         cursor-pointer font-mono tracking-wide uppercase"
            >
              <Package className="w-3.5 h-3.5" />
              Copy Sets
            </button>

            <div className="h-4 w-px bg-white/[0.06] mx-1.5" />

            <button
              type="button"
              onClick={refreshAll}
              disabled={isLoading}
              className="inline-flex items-center justify-center gap-2 rounded-lg text-xs font-medium transition-all h-8 px-3
                         hover:bg-white/[0.05] hover:text-zinc-100 text-zinc-400 border border-transparent hover:border-white/[0.04]
                         disabled:opacity-40 cursor-pointer font-mono tracking-wide uppercase"
            >
              {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              Refresh
            </button>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="inline-flex items-center justify-center rounded-md h-8 w-8
                         hover:bg-white/[0.05] text-zinc-400 hover:text-white transition-all cursor-pointer"
            >
              <Settings2 className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Main layout */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left sidebar */}
          <div className="w-80 shrink-0 border-r border-white/[0.04] bg-[#131315]/80 backdrop-blur-xl flex flex-col h-full overflow-y-auto relative">
            <div className="absolute right-0 top-0 bottom-0 w-[1px] bg-gradient-to-b from-[#c9a84c]/15 via-transparent to-transparent" />

            {/* Script Generator header */}
            <div ref={scriptGenSectionRef} className="p-4 border-b border-white/[0.04] flex items-center gap-2 text-[#e8d5a3] font-mono text-sm tracking-wide uppercase">
              <Sparkles className="w-4 h-4 drop-shadow-[0_0_6px_rgba(201,168,76,0.6)]" />
              <span className="text-glow-gold">Script Generator</span>
            </div>

            {/* Script Generator panel */}
            <div className="p-4">
              <ScriptGeneratorPanel
                onGenerated={handleGenerateFromScript}
                generating={scriptGenerating}
                generatingStep={scriptGenStep}
                initialScript={scriptPrefill.script}
                initialMode={scriptPrefill.mode}
                initialReferenceId={scriptPrefill.referenceId}
                referenceLabel={scriptPrefill.label}
                onClearReference={handleClearScriptPrefill}
              />
            </div>

          </div>

          {/* Right — Pipeline columns */}
          <main className="flex-1 overflow-x-auto bg-transparent p-6 relative">
            {/* Launch action bar */}
            {selectedForLaunch.length > 0 && (
              <div className="mb-4 glass-card border border-blue-500/20 rounded-lg px-4 py-3 flex items-center justify-between animate-[fadeIn_0.2s_ease-out]">
                <span className="text-xs font-mono text-blue-300">
                  {selectedForLaunch.length} brief{selectedForLaunch.length > 1 ? 's' : ''} selected for launch
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setSelectedForLaunch([])}
                    className="text-xs text-zinc-400 hover:text-white px-2 py-1 cursor-pointer"
                  >
                    Clear
                  </button>
                  <button
                    onClick={() => setLaunchModalOpen(true)}
                    disabled={launching}
                    className="inline-flex items-center gap-1.5 bg-blue-500 hover:bg-blue-600 text-white text-xs font-medium px-3 py-1.5 rounded-md cursor-pointer disabled:opacity-50"
                  >
                    {launching ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
                    Launch to Meta
                  </button>
                </div>
              </div>
            )}
            <div className="flex gap-8 h-full min-w-[1500px]">
              {PIPELINE_COLUMNS.map((col, colIdx) => {
                const items = buckets[col.key];
                const Icon = col.icon;
                const isDropTarget = dragOverCol === col.key;
                // Reference column and launched column are NOT drop targets.
                const isDroppable = col.key !== 'launched' && col.key !== 'reference';

                return (
                  <div
                    key={col.key}
                    className={`flex-1 flex flex-col min-w-[300px] relative rounded-lg transition-colors ${isDropTarget ? 'bg-white/[0.03] ring-1 ring-[#c9a84c]/30' : ''}`}
                    onDragOver={isDroppable ? (e) => handleDragOver(e, col.key) : undefined}
                    onDragLeave={isDroppable ? handleDragLeave : undefined}
                    onDrop={isDroppable ? (e) => handleDrop(e, col.key) : undefined}
                  >
                    {/* Column header */}
                    <div className="flex items-center justify-between mb-3 pb-3 border-b border-white/[0.04] relative">
                      <div className="absolute bottom-0 left-0 w-1/3 h-[1px] bg-gradient-to-r from-current to-transparent opacity-30" />
                      <div className="flex items-center gap-2">
                        <Icon className={`w-4 h-4 ${col.colorClass}`} />
                        <h3 className="font-mono text-xs tracking-[0.15em] uppercase text-zinc-300 font-semibold">
                          {col.label}
                        </h3>
                      </div>
                      <div className="flex items-center gap-2">
                        {col.key === 'reference' && (
                          <>
                            {/* Multi-select toggle. ON state shows a count + Cancel. */}
                            <button
                              type="button"
                              onClick={() => {
                                setReferenceSelectMode((prev) => {
                                  if (prev) setSelectedReferenceIds([]);
                                  return !prev;
                                });
                              }}
                              className={`text-[10px] font-mono uppercase tracking-wider transition-colors px-1.5 py-0.5 rounded border ${
                                referenceSelectMode
                                  ? 'border-[#c9a84c]/50 bg-[#c9a84c]/15 text-[#e8d5a3]'
                                  : 'border-white/[0.06] text-zinc-500 hover:text-zinc-200 hover:border-white/[0.12]'
                              }`}
                              title="Toggle multi-select to generate from several references at once"
                            >
                              {referenceSelectMode ? `${selectedReferenceIds.length} sel · Cancel` : 'Select'}
                            </button>
                            <Link
                              to="/app/brand-spy"
                              className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 hover:text-zinc-200 transition-colors inline-flex items-center gap-1"
                              title="Open Brand Spy to follow more competitor brands"
                            >
                              Follow <ExternalLink className="w-2.5 h-2.5" />
                            </Link>
                          </>
                        )}
                        <span className={`text-[10px] font-mono px-2 py-0.5 rounded border ${col.badgeClass}`}>
                          {col.key === 'generated'
                            ? items.length + pendingGenerations.length
                            : items.length}
                        </span>
                      </div>
                    </div>

                    {/* Reference source buttons — UPLOAD / LEAGUE / META */}
                    {col.key === 'reference' && (
                      <div className="grid grid-cols-3 gap-1.5 mb-4">
                        <button
                          type="button"
                          onClick={() => setUploadOpen(true)}
                          className="flex flex-col items-center gap-1 py-2.5 rounded-md border border-white/[0.06] bg-white/[0.02] text-zinc-300 hover:bg-white/[0.04] hover:border-white/[0.12] transition-colors cursor-pointer"
                          title="Paste a script manually"
                        >
                          <Upload className="w-4 h-4" />
                          <span className="text-[10px] font-mono uppercase tracking-wider">Upload</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setLeagueImportOpen(true)}
                          className="flex flex-col items-center gap-1 py-2.5 rounded-md border border-[#c9a84c]/30 bg-[#c9a84c]/10 text-[#e8d5a3] hover:bg-[#c9a84c]/15 transition-colors cursor-pointer"
                          title="Import competitor ads from The League"
                        >
                          <BookOpen className="w-4 h-4" />
                          <span className="text-[10px] font-mono uppercase tracking-wider">League</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setMetaImportOpen(true)}
                          className="flex flex-col items-center gap-1 py-2.5 rounded-md border border-sky-500/30 bg-sky-500/10 text-sky-300 hover:bg-sky-500/15 transition-colors cursor-pointer"
                          title="Import our active video ads from Triple Whale"
                        >
                          <TrendingUp className="w-4 h-4" />
                          <span className="text-[10px] font-mono uppercase tracking-wider">Meta</span>
                        </button>
                      </div>
                    )}

                    {/* Dashed connector between columns */}
                    {colIdx < PIPELINE_COLUMNS.length - 1 && (
                      <div className="absolute top-6 -right-5 w-4 border-t border-dashed border-white/[0.06]" />
                    )}

                    {/* Card list */}
                    <div className="flex-1 overflow-y-auto space-y-4 pr-2 pb-4">
                      {/* GENERATING placeholder cards — render first so the
                          operator sees them at the top of the column the
                          instant they click Generate (single or batch). */}
                      {col.key === 'generated' && pendingGenerations.map((p) => {
                        const stepLabels = p.mode === 'iterate'
                          ? ['Parsing winning script…', 'Generating iterations…', 'Finalizing cards…']
                          : ['Parsing source script…', 'Cloning into our product…', 'Finalizing card…'];
                        return (
                          <div
                            key={`pending-${p.winner_id}`}
                            className="rounded-xl border border-[#c9a84c]/30 bg-[#c9a84c]/[0.04] p-4 animate-pulse"
                            aria-live="polite"
                          >
                            <div className="flex items-center justify-between mb-3">
                              <span className="text-[9px] font-mono uppercase tracking-wider font-medium px-1.5 py-0.5 rounded bg-[#c9a84c]/15 text-[#e8d5a3] border border-[#c9a84c]/30">
                                Generating
                              </span>
                              <Loader2 className="w-3.5 h-3.5 text-[#c9a84c] animate-spin" />
                            </div>
                            <h4 className="text-sm font-medium text-zinc-300 leading-snug truncate mb-1">
                              {p.referenceTitle}
                            </h4>
                            <p className="text-[10px] text-zinc-500 font-mono">
                              {stepLabels[p.step] || stepLabels[stepLabels.length - 1]}
                            </p>
                          </div>
                        );
                      })}
                      {items.length === 0 && (col.key !== 'generated' || pendingGenerations.length === 0) ? (
                        col.key === 'reference' ? (
                          <div className="flex flex-col items-center justify-center h-40 px-4 text-center">
                            <BookOpen className="w-6 h-6 text-violet-400/40 mb-2" />
                            <p className="text-xs text-zinc-500 font-mono">
                              Pick a source above
                            </p>
                          </div>
                        ) : (
                          <div className="flex items-center justify-center h-32">
                            <p className="text-xs text-zinc-600 font-mono">No items</p>
                          </div>
                        )
                      ) : (
                        items.map((item) => {
                          // Reference cards have their own renderer — no drag,
                          // no shared brief card model.
                          if (col.key === 'reference') {
                            const isSelected = selectedReferenceIds.includes(item.id);
                            return (
                              <div
                                key={item.id}
                                className={referenceSelectMode ? 'relative' : ''}
                                onClick={referenceSelectMode ? (e) => {
                                  // In select mode the entire card surface is a
                                  // checkbox — swallow card-level clicks (preview,
                                  // generate) and toggle membership instead.
                                  e.stopPropagation();
                                  e.preventDefault();
                                  setSelectedReferenceIds((prev) =>
                                    prev.includes(item.id)
                                      ? prev.filter((id) => id !== item.id)
                                      : [...prev, item.id]
                                  );
                                } : undefined}
                              >
                                {referenceSelectMode && (
                                  <div
                                    className={`absolute top-2 right-2 z-20 w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all ${
                                      isSelected
                                        ? 'bg-[#c9a84c] border-[#c9a84c] shadow-[0_0_8px_rgba(201,168,76,0.4)]'
                                        : 'bg-zinc-900/80 border-white/40'
                                    }`}
                                    aria-hidden
                                  >
                                    {isSelected && <CheckCircle2 className="w-3 h-3 text-zinc-900" />}
                                  </div>
                                )}
                                <div className={referenceSelectMode ? `pointer-events-none transition-all ${isSelected ? 'ring-2 ring-[#c9a84c]/60 rounded-xl' : 'opacity-70'}` : ''}>
                                  <ReferenceCard
                                    reference={item}
                                    onPreview={handlePreviewReference}
                                    onGenerateFromReference={handleGenerateFromReference}
                                    onDelete={handleDeleteReference}
                                    onRetryTranscribe={handleRetryTranscribe}
                                  />
                                </div>
                              </div>
                            );
                          }

                          const isDraggable = col.key !== 'launched';
                          const cardWrapper = (children) => isDraggable ? (
                            <div
                              key={item.id}
                              draggable
                              onDragStart={(e) => handleDragStart(e, item, col.key)}
                              className="cursor-grab active:cursor-grabbing"
                            >
                              {children}
                            </div>
                          ) : <div key={item.id}>{children}</div>;

                          if (col.key === 'generated') {
                            return cardWrapper(
                              <GeneratedBriefCard
                                brief={item}
                                onClick={() => setDetailModal(item)}
                                showActions="generated"
                                onApprove={() => handleApprove(item.id)}
                                onReject={() => handleReject(item.id)}
                                onDelete={() => handleDelete(item.id)}
                              />
                            );
                          }

                          if (col.key === 'approved') {
                            return cardWrapper(
                              <GeneratedBriefCard
                                brief={item}
                                onClick={() => setDetailModal(item)}
                                showActions="approved"
                                onPushToClickup={() => handleOpenPushModal(item)}
                                onMoveToReady={() => handleMoveToReady(item.id)}
                                onDelete={() => handleDelete(item.id)}
                              />
                            );
                          }

                          if (col.key === 'ready_to_launch') {
                            return cardWrapper(
                              <GeneratedBriefCard
                                brief={item}
                                onClick={() => setDetailModal(item)}
                                showActions="ready_to_launch"
                                launchFailed={item.status === 'launch_failed'}
                                launchError={item.launch_error}
                                onSelectForLaunch={() => {
                                  setSelectedForLaunch(prev =>
                                    prev.includes(item.id)
                                      ? prev.filter(id => id !== item.id)
                                      : [...prev, item.id]
                                  );
                                }}
                                isSelectedForLaunch={selectedForLaunch.includes(item.id)}
                                onDelete={() => handleDelete(item.id)}
                              />
                            );
                          }

                          if (col.key === 'launched') {
                            return cardWrapper(
                              <GeneratedBriefCard
                                brief={item}
                                onClick={() => setDetailModal(item)}
                                showActions="launched"
                                metaAdIds={item.meta_ad_ids}
                                onDelete={() => handleDelete(item.id)}
                              />
                            );
                          }

                          return null;
                        })
                      )}
                    </div>
                    {/* Sticky batch-generate bar — only on the reference
                        column, only in multi-select mode, only when at
                        least one ref is selected. Fires N parallel POSTs. */}
                    {col.key === 'reference' && referenceSelectMode && selectedReferenceIds.length > 0 && (
                      <div className="mt-2 mb-1 px-1">
                        <button
                          type="button"
                          onClick={() => {
                            const refs = references.filter((r) => selectedReferenceIds.includes(r.id));
                            handleBatchGenerateFromReferences(refs);
                          }}
                          className="w-full flex items-center justify-center gap-2 py-3 rounded-md bg-[#c9a84c]/15 border border-[#c9a84c]/40 text-[#e8d5a3] font-mono text-xs uppercase tracking-wider hover:bg-[#c9a84c]/25 hover:border-[#c9a84c]/60 shadow-[0_0_15px_rgba(201,168,76,0.15)] transition-all cursor-pointer"
                        >
                          <Sparkles className="w-3.5 h-3.5" />
                          Generate {selectedReferenceIds.length} Brief{selectedReferenceIds.length === 1 ? '' : 's'}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </main>
        </div>
      </div>

      {/* Error toast */}
      {error && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 glass-card border border-red-500/20 rounded-lg px-4 py-3 shadow-xl flex items-center gap-3 z-50 max-w-md">
          <p className="text-xs text-red-200 flex-1">{error}</p>
          <button type="button" onClick={() => setError(null)} className="text-red-400 hover:text-red-200 text-xs font-medium shrink-0 cursor-pointer font-mono uppercase tracking-wide">
            Dismiss
          </button>
        </div>
      )}

      {/* Script-from-text generating overlay */}
      {scriptGenerating && (
        <div className="fixed bottom-6 right-6 glass-card border border-white/[0.06] rounded-lg px-4 py-3 shadow-xl flex items-center gap-3 z-40">
          <Loader2 className="w-4 h-4 animate-spin text-[#c9a84c]" />
          <div>
            <p className="text-xs font-medium text-white font-mono">Generating briefs...</p>
            <p className="text-[10px] text-zinc-500">{scriptGenStep}</p>
          </div>
        </div>
      )}

      {/* Brief Detail Modal */}
      {detailModal && (
        <BriefDetailModal
          brief={detailModal}
          isOpen={!!detailModal}
          onClose={() => setDetailModal(null)}
          winAnalysis={detailModal.win_analysis}
          onSave={handleSaveBrief}
          originalScript={detailModal?.original_script}
          originalRawScript={detailModal?.original_raw_script}
          onApprove={() => {
            handleApprove(detailModal.id);
            setDetailModal(null);
          }}
          onReject={() => {
            handleReject(detailModal.id);
            setDetailModal(null);
          }}
          onMoveToReady={() => {
            handleMoveToReady(detailModal.id);
            setDetailModal(null);
          }}
          onMarkLaunched={() => {
            handleMarkLaunched(detailModal.id);
            setDetailModal(null);
          }}
          onMoveBackToApproved={() => {
            handleMoveBackToApproved(detailModal.id);
            setDetailModal(null);
          }}
          onPushToClickup={() => {
            // Close the detail panel and open the Push modal for the same brief.
            // Two-step instead of stacked modals so the operator only sees one UI.
            handleOpenPushModal(detailModal);
            setDetailModal(null);
          }}
        />
      )}

      {/* Push to ClickUp Modal */}
      <PushToClickupModal
        briefId={pushModal?.id}
        briefTitle={pushModal?.title}
        isOpen={!!pushModal}
        onClose={() => setPushModal(null)}
        onSuccess={() => {
          // Refresh columns; let the operator close the success state in modal.
          handlePushSuccess();
        }}
      />

      {/* Pipeline Settings Modal */}
      <PipelineSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />

      {/* Launch Template Editor */}
      <LaunchTemplateEditor
        open={templateEditorOpen}
        onClose={() => { setTemplateEditorOpen(false); setEditingTemplate(null); }}
        template={editingTemplate}
        onSaved={() => { fetchLaunchTemplates(); setTemplateEditorOpen(false); setEditingTemplate(null); }}
      />

      {/* Ad Copy Sets Manager */}
      <AdCopySetsManager
        open={copySetsOpen}
        onClose={() => setCopySetsOpen(false)}
        productId={null}
        productName="All Products"
      />

      {/* League Import Modal */}
      <LeagueImportModal
        open={leagueImportOpen}
        onClose={() => setLeagueImportOpen(false)}
        onImported={handleLeagueImported}
      />

      {/* Meta video import — our own active ads from Triple Whale */}
      <MetaVideoImportModal
        open={metaImportOpen}
        onClose={() => setMetaImportOpen(false)}
        onImported={handleMetaImported}
      />

      {/* Upload — paste a script manually */}
      <ScriptUploadModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onImported={async () => { await fetchReferences(); }}
      />

      {/* Reference preview lightbox — opens when a Reference card is clicked */}
      <ReferencePreviewModal
        open={!!previewReference}
        reference={previewReference}
        onClose={() => setPreviewReference(null)}
        onUseAsReference={handleGenerateFromReference}
        onDelete={handleDeleteReference}
      />

      {/* Launch Confirmation Modal */}
      {launchModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => !launching && setLaunchModalOpen(false)}>
          <div className="glass-card border border-white/[0.08] rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-mono font-semibold text-white uppercase tracking-wide mb-4 flex items-center gap-2">
              <Zap className="w-4 h-4 text-blue-400" />
              Launch {selectedForLaunch.length} Brief{selectedForLaunch.length > 1 ? 's' : ''} to Meta
            </h3>

            <div className="space-y-3 mb-6">
              <div>
                <label className="font-mono text-[10px] text-[#c9a84c] uppercase tracking-[0.15em] block mb-1.5">
                  Launch Template
                </label>
                <select
                  id="launch-template-select"
                  className="w-full bg-white/[0.03] border border-white/[0.06] rounded-lg px-3 py-2 text-sm text-white focus:ring-1 focus:ring-[#c9a84c]/30 focus:border-[#c9a84c]/20"
                  defaultValue=""
                >
                  <option value="" disabled>Select a template...</option>
                  {launchTemplates.map(t => (
                    <option key={t.id} value={t.id}>{t.name} — {t.ad_account_name || t.ad_account_id}</option>
                  ))}
                </select>
                {launchTemplates.length === 0 && (
                  <p className="text-[10px] text-zinc-500 mt-1">No templates yet. Create one first.</p>
                )}
              </div>
            </div>

            <div className="flex items-center gap-3 justify-end">
              <button
                onClick={() => { setLaunchModalOpen(false); }}
                disabled={launching}
                className="text-xs text-zinc-400 hover:text-white px-3 py-2 cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const sel = document.getElementById('launch-template-select');
                  if (!sel?.value) { setError('Please select a launch template'); return; }
                  handleLaunch(selectedForLaunch, sel.value);
                }}
                disabled={launching || launchTemplates.length === 0}
                className="inline-flex items-center gap-1.5 bg-blue-500 hover:bg-blue-600 text-white text-xs font-semibold px-4 py-2 rounded-lg cursor-pointer disabled:opacity-50"
              >
                {launching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                {launching ? 'Launching...' : 'Confirm Launch'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
