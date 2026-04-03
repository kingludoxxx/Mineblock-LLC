import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  RefreshCw,
  Loader2,
  Sparkles,
  Trophy,
  Rocket,
  CheckCircle2,
  ExternalLink,
  Settings2,
  ChevronRight,
  MessageSquare,
  Play,
  MoreHorizontal,
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
  {
    key: 'pushed',
    label: 'Pushed',
    icon: Rocket,
    colorClass: 'text-white drop-shadow-[0_0_6px_rgba(255,255,255,0.3)]',
    badgeClass: 'bg-white/[0.06] text-white border-white/[0.1]',
  },
];

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
    try {
      const { data } = await api.get(`/brief-pipeline/winners/${winner.id}`);
      setWinnerDetail(data.winner || data);
    } catch (err) {
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

    for (const w of winners) map.detected.push(w);

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
              onClick={handleDetect}
              disabled={detecting}
              className="inline-flex items-center justify-center gap-2 rounded-lg text-xs font-medium transition-all h-8 px-3
                         bg-[#c9a84c]/10 text-[#d4b55a] hover:bg-[#c9a84c]/20 border border-[#c9a84c]/25 hover:border-[#c9a84c]/40
                         shadow-[0_0_10px_rgba(201,168,76,0.08)] hover:shadow-[0_0_15px_rgba(201,168,76,0.15)]
                         disabled:opacity-40 cursor-pointer font-mono tracking-wide uppercase"
            >
              {detecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trophy className="w-3.5 h-3.5" />}
              Detect Winners
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
            <div className="p-4 border-b border-white/[0.04] flex items-center gap-2 text-[#e8d5a3] font-mono text-sm tracking-wide uppercase">
              <Sparkles className="w-4 h-4 drop-shadow-[0_0_6px_rgba(201,168,76,0.6)]" />
              <span className="text-glow-gold">Script Generator</span>
            </div>

            {/* Script Generator panel */}
            <div className="p-4">
              <ScriptGeneratorPanel
                onGenerated={handleGenerateFromScript}
                generating={scriptGenerating}
                generatingStep={scriptGenStep}
              />
            </div>

            {/* Winning Ads section */}
            <div className="mt-auto border-t border-white/[0.04] bg-black/20 flex flex-col flex-1">
              <div className="p-4 flex items-center justify-between text-[#c9a84c]/80 font-mono text-xs tracking-wide uppercase">
                <div className="flex items-center gap-2">
                  <Trophy className="w-3.5 h-3.5" />
                  Winning Ads
                </div>
                <span className="bg-[#c9a84c]/10 text-[#c9a84c]/80 px-2 py-0.5 rounded border border-[#c9a84c]/15">
                  {buckets.detected.length}
                </span>
              </div>
              <div className="px-4 pb-4 space-y-3 overflow-y-auto flex-1">
                {buckets.detected.length === 0 ? (
                  <div className="flex flex-col items-center justify-center text-center py-8">
                    <div className="w-10 h-10 rounded-lg bg-white/[0.02] border border-white/[0.04] flex items-center justify-center mb-3 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.02)]">
                      <Trophy className="w-4 h-4 text-zinc-700" />
                    </div>
                    <p className="text-[11px] text-zinc-600 font-mono leading-relaxed">
                      NO WINNERS DETECTED<br />
                      <span className="opacity-70">AWAITING AD ACCOUNT SYNC</span>
                    </p>
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

          {/* Right — Pipeline columns */}
          <main className="flex-1 overflow-x-auto bg-transparent p-6 relative">
            <div className="flex gap-8 h-full min-w-[900px]">
              {PIPELINE_COLUMNS.map((col, colIdx) => {
                const items = buckets[col.key];
                const Icon = col.icon;

                return (
                  <div key={col.key} className="flex-1 flex flex-col min-w-[300px] relative">
                    {/* Column header */}
                    <div className="flex items-center justify-between mb-4 pb-3 border-b border-white/[0.04] relative">
                      <div className="absolute bottom-0 left-0 w-1/3 h-[1px] bg-gradient-to-r from-current to-transparent opacity-30" />
                      <div className="flex items-center gap-2">
                        <Icon className={`w-4 h-4 ${col.colorClass}`} />
                        <h3 className="font-mono text-xs tracking-[0.15em] uppercase text-zinc-300 font-semibold">
                          {col.label}
                        </h3>
                      </div>
                      <span className={`text-[10px] font-mono px-2 py-0.5 rounded border ${col.badgeClass}`}>
                        {items.length}
                      </span>
                    </div>

                    {/* Dashed connector between columns */}
                    {colIdx < PIPELINE_COLUMNS.length - 1 && (
                      <div className="absolute top-6 -right-5 w-4 border-t border-dashed border-white/[0.06]" />
                    )}

                    {/* Card list */}
                    <div className="flex-1 overflow-y-auto space-y-4 pr-2 pb-4">
                      {items.length === 0 ? (
                        <div className="flex items-center justify-center h-32">
                          <p className="text-xs text-zinc-600 font-mono">No items</p>
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
                              <GeneratedBriefCard
                                key={item.id}
                                brief={item}
                                onClick={() => setDetailModal(item)}
                                showActions="pushed"
                              />
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

      {/* Generating overlay */}
      {generating && (
        <div className="fixed bottom-6 right-6 glass-card border border-white/[0.06] rounded-lg px-4 py-3 shadow-xl flex items-center gap-3 z-40">
          <Loader2 className="w-4 h-4 animate-spin text-[#c9a84c]" />
          <div>
            <p className="text-xs font-medium text-white font-mono">Generating briefs...</p>
            <p className="text-[10px] text-zinc-500">{generatingStep}</p>
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
