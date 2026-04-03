import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  RefreshCw,
  Loader2,
  Eye,
  CheckCircle2,
  Sparkles,
  Trophy,
  Rocket,
  ExternalLink,
  Settings,
} from 'lucide-react';
import api from '../../services/api';
import WinnerCard from './briefs/WinnerCard';
import ScriptGeneratorPanel from './briefs/ScriptGeneratorPanel';
import GeneratedBriefCard from './briefs/GeneratedBriefCard';
import BriefDetailModal from './briefs/BriefDetailModal';
import WinnerDetailModal from './briefs/WinnerDetailModal';
import PipelineSettingsModal from './briefs/PipelineSettingsModal';

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const PIPELINE_COLUMNS = [
  {
    key: 'generated',
    label: 'Generated',
    icon: Sparkles,
    badgeBg: 'bg-purple-500/15',
    badgeText: 'text-purple-400/80',
    headerBorder: 'border-purple-500/30',
  },
  {
    key: 'approved',
    label: 'Approved',
    icon: CheckCircle2,
    badgeBg: 'bg-emerald-500/15',
    badgeText: 'text-emerald-400/80',
    headerBorder: 'border-emerald-500/30',
  },
  {
    key: 'pushed',
    label: 'Pushed',
    icon: Rocket,
    badgeBg: 'bg-cyan-500/15',
    badgeText: 'text-cyan-400/80',
    headerBorder: 'border-cyan-500/30',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function StatusBadge({ label, bg, text }) {
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${bg} ${text}`}>
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// BriefPipeline (main page)
// ---------------------------------------------------------------------------

export default function BriefPipeline() {
  // Data
  const [winners, setWinners] = useState([]);
  const [generated, setGenerated] = useState([]);

  // Loading states
  const [loadingWinners, setLoadingWinners] = useState(false);
  const [loadingGenerated, setLoadingGenerated] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generatingId, setGeneratingId] = useState(null);
  const [generatingStep, setGeneratingStep] = useState('');

  // UI state
  const [detailModal, setDetailModal] = useState(null);
  const [winnerDetail, setWinnerDetail] = useState(null);
  const [error, setError] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  const fetchWinners = useCallback(async () => {
    setLoadingWinners(true);
    try {
      const { data } = await api.get('/brief-pipeline/winners');
      setWinners(data.winners || data || []);
    } catch (err) {
      console.error('Failed to fetch winners:', err);
    } finally {
      setLoadingWinners(false);
    }
  }, []);

  const fetchGenerated = useCallback(async () => {
    setLoadingGenerated(true);
    try {
      const { data } = await api.get('/brief-pipeline/generated');
      setGenerated(data.briefs || data || []);
    } catch (err) {
      console.error('Failed to fetch generated briefs:', err);
    } finally {
      setLoadingGenerated(false);
    }
  }, []);

  const refreshAll = useCallback(() => {
    fetchWinners();
    fetchGenerated();
  }, [fetchWinners, fetchGenerated]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const handleViewWinner = useCallback(async (winner) => {
    // Fetch full winner detail (includes script from ClickUp)
    try {
      const { data } = await api.get(`/brief-pipeline/winners/${winner.id}`);
      setWinnerDetail(data.winner || data);
    } catch (err) {
      // Fallback to the data we already have
      setWinnerDetail(winner);
    }
  }, []);

  const handleDetect = useCallback(async () => {
    setDetecting(true);
    try {
      await api.post('/brief-pipeline/detect');
      await fetchWinners();
    } catch (err) {
      console.error('Detection failed:', err);
      setError('Failed to detect winners. Check console for details.');
    } finally {
      setDetecting(false);
    }
  }, [fetchWinners]);

  const handleGenerate = useCallback(async (winnerId, config) => {
    setGenerating(true);
    setGeneratingId(winnerId);
    setGeneratingStep('Analyzing winning ad...');
    let stepInterval;
    try {
      const stepMessages = [
        'Analyzing winning ad...',
        'Identifying iteration angles...',
        'Generating brief variations...',
        'Scoring & ranking output...',
        'Finalizing briefs...',
      ];
      let stepIdx = 0;
      stepInterval = setInterval(() => {
        stepIdx = Math.min(stepIdx + 1, stepMessages.length - 1);
        setGeneratingStep(stepMessages[stepIdx]);
      }, 3000);

      await api.post(`/brief-pipeline/generate/${winnerId}`, config || {});
      clearInterval(stepInterval);
      await fetchGenerated();
      await fetchWinners();
    } catch (err) {
      clearInterval(stepInterval);
      console.error('Generate failed:', err);
      setError(err.response?.data?.error?.message || 'Brief generation failed.');
    } finally {
      setGenerating(false);
      setGeneratingId(null);
      setGeneratingStep('');
    }
  }, [fetchGenerated, fetchWinners]);

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

  const handleSaveBrief = useCallback(async (briefId, updates) => {
    try {
      await api.patch(`/brief-pipeline/generated/${briefId}`, updates);
      await fetchGenerated();
      setDetailModal(prev => prev ? { ...prev, ...updates } : null);
    } catch (err) {
      setError('Failed to save brief changes.');
    }
  }, [fetchGenerated]);

  const [scriptGenerating, setScriptGenerating] = useState(false);
  const [scriptGenStep, setScriptGenStep] = useState('');

  const handleGenerateFromScript = useCallback(async (config) => {
    setScriptGenerating(true);
    setScriptGenStep('Analyzing script...');
    let stepInterval;
    try {
      const stepMessages = [
        'Analyzing script...',
        'Running deep analysis (3 agents)...',
        'Generating variations...',
        'Scoring & validating...',
        'Finalizing briefs...',
      ];
      let stepIdx = 0;
      stepInterval = setInterval(() => {
        stepIdx = Math.min(stepIdx + 1, stepMessages.length - 1);
        setScriptGenStep(stepMessages[stepIdx]);
      }, 4000);

      await api.post('/brief-pipeline/generate-from-script', {
        script: config.script,
        url: config.url,
        productCode: config.productCode,
        angle: config.angle,
        mode: config.mode === 'clone' ? 'clone' : 'variants',
        numVariations: config.numVariations,
      });
      clearInterval(stepInterval);
      await fetchGenerated();
      await fetchWinners();
    } catch (err) {
      clearInterval(stepInterval);
      const msg = err.response?.data?.error?.message || err.message || 'Generation failed';
      setError(msg);
      throw new Error(msg);
    } finally {
      setScriptGenerating(false);
      setScriptGenStep('');
    }
  }, [fetchGenerated, fetchWinners]);

  const handlePush = useCallback(async (briefId) => {
    try {
      await api.post(`/brief-pipeline/generated/${briefId}/push`);
      await fetchGenerated();
    } catch (err) {
      console.error('Push failed:', err);
      setError('Failed to push brief to ClickUp.');
    }
  }, [fetchGenerated]);

  // ---------------------------------------------------------------------------
  // Bucket items into columns
  // ---------------------------------------------------------------------------

  const buckets = useMemo(() => {
    const map = { detected: [], generated: [], approved: [], pushed: [] };

    // All winners go to detected
    for (const w of winners) map.detected.push(w);

    // Generated briefs go into generated, approved, or pushed
    for (const b of generated) {
      if (b.status === 'pushed') {
        map.pushed.push(b);
      } else if (b.status === 'approved') {
        map.approved.push(b);
      } else if (b.status !== 'rejected') {
        map.generated.push(b);
      }
    }

    return map;
  }, [winners, generated]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const isLoading = loadingWinners || loadingGenerated;

  return (
    <div className="flex flex-col min-h-screen bg-bg-main">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
        <h1 className="text-lg font-semibold text-text-primary">Brief Pipeline</h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleDetect}
            disabled={detecting}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-accent-text
                       bg-accent/10 border border-accent/20 rounded-md
                       hover:bg-accent/20 transition-colors disabled:opacity-40 cursor-pointer"
          >
            {detecting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Eye className="w-3.5 h-3.5" />
            )}
            Detect Winners
          </button>
          <button
            type="button"
            onClick={refreshAll}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-muted
                       bg-bg-elevated border border-border-default rounded-md
                       hover:bg-bg-hover hover:text-text-primary transition-colors disabled:opacity-40 cursor-pointer"
          >
            {isLoading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-muted
                       bg-bg-elevated border border-border-default rounded-md
                       hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
          >
            <Settings className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Main layout: Left sidebar (Script Generator + Winning Ads) | Right pipeline columns */}
      <div className="flex-1 flex overflow-hidden" style={{ minHeight: 'calc(100vh - 120px)' }}>
        {/* Left sidebar — Script Generator + Winning Ads stacked */}
        <div className="w-[300px] shrink-0 border-r border-border-subtle flex flex-col overflow-y-auto px-4 py-4 custom-scrollbar">
          {/* Script Generator */}
          <div className="mb-4">
            <div className="flex items-center gap-2 px-1 py-2 border-b-2 border-accent/40 mb-3">
              <Sparkles className="w-4 h-4 text-accent" />
              <span className="text-sm font-semibold text-accent">Script Generator</span>
            </div>
            <ScriptGeneratorPanel
              onGenerated={handleGenerateFromScript}
              generating={scriptGenerating}
              generatingStep={scriptGenStep}
            />
          </div>

          {/* Winning Ads — below the generator */}
          <div className="flex-1">
            <div className="flex items-center gap-2 px-1 py-2 border-b-2 border-accent/40 mb-3">
              <Trophy className="w-4 h-4 text-accent" />
              <span className="text-sm font-semibold text-accent">Winning Ads</span>
              <span className="ml-auto px-2 py-0.5 rounded-full text-[11px] font-medium bg-accent/15 text-accent-text">
                {buckets.detected.length}
              </span>
            </div>
            <div className="space-y-3 pb-4">
              {buckets.detected.length === 0 ? (
                <div className="flex items-center justify-center h-24">
                  <p className="text-xs text-text-faint">No winners detected</p>
                </div>
              ) : (
                buckets.detected.map((item) => (
                  <WinnerCard
                    key={item.id}
                    winner={item}
                    onSelect={() => handleViewWinner(item)}
                  />
                ))
              )}
            </div>
          </div>
        </div>

        {/* Right — Pipeline columns (Generated | Approved | Pushed) */}
        <div className="flex-1 overflow-x-auto px-4 py-4">
          <div className="flex gap-4 h-full">
            {PIPELINE_COLUMNS.map((col) => {
              const items = buckets[col.key];
              const Icon = col.icon;

              return (
                <div key={col.key} className="flex flex-col min-w-[260px] max-w-[360px] flex-1">
                  {/* Column header */}
                  <div className={`flex items-center gap-2 px-3 py-2.5 border-b-2 ${col.headerBorder} mb-3`}>
                    <Icon className="w-4 h-4 text-text-muted" />
                    <span className="text-sm font-semibold text-text-primary">{col.label}</span>
                    <span className={`ml-auto px-2 py-0.5 rounded-full text-[11px] font-medium ${col.badgeBg} ${col.badgeText}`}>
                      {items.length}
                    </span>
                  </div>

                  {/* Card list */}
                  <div className="flex-1 overflow-y-auto pr-1 space-y-3 pb-4 custom-scrollbar">
                    {items.length === 0 ? (
                      <div className="flex items-center justify-center h-32">
                        <p className="text-xs text-text-faint">No items</p>
                      </div>
                    ) : (
                      items.map((item) => {
                        if (col.key === 'generated') {
                          return (
                            <GeneratedBriefCard
                              key={item.id}
                              brief={item}
                              onClick={() => setDetailModal(item)}
                              showActions="generated"
                              onApprove={() => handleApprove(item.id)}
                              onReject={() => handleReject(item.id)}
                            />
                          );
                        }

                        if (col.key === 'approved') {
                          return (
                            <GeneratedBriefCard
                              key={item.id}
                              brief={item}
                              onClick={() => setDetailModal(item)}
                              showActions="approved"
                              onPush={() => handlePush(item.id)}
                            />
                          );
                        }

                        if (col.key === 'pushed') {
                          return (
                            <div
                              key={item.id}
                              className="bg-bg-main border border-border-default rounded-lg p-3 space-y-2
                                         hover:border-border-strong hover:shadow-lg hover:shadow-black/20 transition-all duration-150"
                            >
                              <p className="text-sm font-medium text-text-primary truncate">
                                {item.naming_convention || 'Brief'}
                              </p>
                              {item.clickup_task_url && (
                                <a
                                  href={item.clickup_task_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center gap-1 text-[11px] text-accent-text hover:text-accent transition-colors"
                                >
                                  <ExternalLink className="w-3 h-3" />
                                  ClickUp Task
                                </a>
                              )}
                              {item.pushed_at && (
                                <p className="text-[10px] text-text-faint">
                                  Pushed {new Date(item.pushed_at).toLocaleDateString()}
                                </p>
                              )}
                            </div>
                          );
                        }

                        return null;
                      })
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Error toast */}
      {error && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-red-950/90 border border-red-500/20 rounded-lg px-4 py-3 shadow-xl flex items-center gap-3 z-50 max-w-md">
          <p className="text-xs text-red-200 flex-1">{error}</p>
          <button type="button" onClick={() => setError(null)} className="text-red-400 hover:text-red-200 text-xs font-medium shrink-0 cursor-pointer">
            Dismiss
          </button>
        </div>
      )}

      {/* Generating overlay indicator */}
      {generating && (
        <div className="fixed bottom-6 right-6 bg-bg-card border border-border-default rounded-lg px-4 py-3 shadow-xl flex items-center gap-3 z-40">
          <Loader2 className="w-4 h-4 animate-spin text-accent" />
          <div>
            <p className="text-xs font-medium text-text-primary">Generating briefs...</p>
            <p className="text-[10px] text-text-muted">{generatingStep}</p>
          </div>
        </div>
      )}

      {/* Winner Detail Modal */}
      {winnerDetail && (
        <WinnerDetailModal
          winner={winnerDetail}
          isOpen={!!winnerDetail}
          onClose={() => setWinnerDetail(null)}
          onGenerate={(winnerId, config) => {
            setWinnerDetail(null);
            handleGenerate(winnerId, config);
          }}
          generating={generating}
        />
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
          onApprove={() => {
            handleApprove(detailModal.id);
            setDetailModal(null);
          }}
          onReject={() => {
            handleReject(detailModal.id);
            setDetailModal(null);
          }}
          onPush={() => {
            handlePush(detailModal.id);
            setDetailModal(null);
          }}
        />
      )}

      {/* Pipeline Settings Modal */}
      <PipelineSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
