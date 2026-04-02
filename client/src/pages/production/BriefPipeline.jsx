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
} from 'lucide-react';
import api from '../../services/api';
import WinnerCard from './briefs/WinnerCard';
import GeneratedBriefCard from './briefs/GeneratedBriefCard';
import BriefDetailModal from './briefs/BriefDetailModal';
import WinnerDetailModal from './briefs/WinnerDetailModal';

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const COLUMNS = [
  {
    key: 'detected',
    label: 'Winning Ads',
    icon: Trophy,
    badgeBg: 'bg-amber-500/20',
    badgeText: 'text-amber-300',
    headerBorder: 'border-amber-500/40',
  },
  {
    key: 'generated',
    label: 'Generated',
    icon: Sparkles,
    badgeBg: 'bg-purple-500/20',
    badgeText: 'text-purple-300',
    headerBorder: 'border-purple-500/40',
  },
  {
    key: 'approved',
    label: 'Approved',
    icon: CheckCircle2,
    badgeBg: 'bg-emerald-500/20',
    badgeText: 'text-emerald-300',
    headerBorder: 'border-emerald-500/40',
  },
  {
    key: 'pushed',
    label: 'Pushed',
    icon: Rocket,
    badgeBg: 'bg-cyan-500/20',
    badgeText: 'text-cyan-300',
    headerBorder: 'border-cyan-500/40',
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
    <div className="flex flex-col min-h-screen bg-[#0a0a0a]">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
        <h1 className="text-lg font-semibold text-gray-100">Brief Pipeline</h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleDetect}
            disabled={detecting}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-300
                       bg-white/[0.04] border border-white/[0.06] rounded-md
                       hover:bg-white/[0.08] transition-colors disabled:opacity-40 cursor-pointer"
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
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-300
                       bg-white/[0.04] border border-white/[0.06] rounded-md
                       hover:bg-white/[0.08] transition-colors disabled:opacity-40 cursor-pointer"
          >
            {isLoading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            Refresh
          </button>
        </div>
      </div>

      {/* Kanban columns */}
      <div className="flex-1 overflow-x-auto px-6 py-4" style={{ minHeight: 'calc(100vh - 120px)' }}>
        <div className="flex gap-4 h-full">
          {COLUMNS.map((col) => {
            const items = buckets[col.key];
            const Icon = col.icon;

            return (
              <div key={col.key} className="flex flex-col min-w-[260px] max-w-[320px] flex-1">
                {/* Column header */}
                <div className={`flex items-center gap-2 px-3 py-2.5 border-b-2 ${col.headerBorder} mb-3`}>
                  <Icon className="w-4 h-4 text-gray-400" />
                  <span className="text-sm font-semibold text-gray-200">{col.label}</span>
                  <span className={`ml-auto px-2 py-0.5 rounded-full text-[11px] font-medium ${col.badgeBg} ${col.badgeText}`}>
                    {items.length}
                  </span>
                </div>

                {/* Card list */}
                <div className="flex-1 overflow-y-auto pr-1 space-y-3 pb-4 custom-scrollbar">
                  {items.length === 0 ? (
                    <div className="flex items-center justify-center h-32">
                      <p className="text-xs text-gray-600">No items</p>
                    </div>
                  ) : (
                    items.map((item) => {
                      // Column 1: Winning Ads (detected)
                      if (col.key === 'detected') {
                        return (
                          <WinnerCard
                            key={item.id}
                            winner={item}
                            onSelect={() => handleViewWinner(item)}
                          />
                        );
                      }

                      // Column 2: Generated
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

                      // Column 4: Approved
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

                      // Column 5: Pushed
                      if (col.key === 'pushed') {
                        return (
                          <div
                            key={item.id}
                            className="bg-[#0a0a0a] border border-white/[0.06] rounded-lg p-3 space-y-2
                                       hover:border-white/[0.12] hover:shadow-lg hover:shadow-black/20 transition-all duration-150"
                          >
                            <p className="text-sm font-medium text-gray-100 truncate">
                              {item.naming_convention || 'Brief'}
                            </p>
                            {item.clickup_task_url && (
                              <a
                                href={item.clickup_task_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300 transition-colors"
                              >
                                <ExternalLink className="w-3 h-3" />
                                ClickUp Task
                              </a>
                            )}
                            {item.pushed_at && (
                              <p className="text-[10px] text-gray-500">
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

      {/* Error toast */}
      {error && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-red-950 border border-red-500/30 rounded-lg px-4 py-3 shadow-xl flex items-center gap-3 z-50 max-w-md">
          <p className="text-xs text-red-200 flex-1">{error}</p>
          <button type="button" onClick={() => setError(null)} className="text-red-400 hover:text-red-200 text-xs font-medium shrink-0 cursor-pointer">
            Dismiss
          </button>
        </div>
      )}

      {/* Generating overlay indicator */}
      {generating && (
        <div className="fixed bottom-6 right-6 bg-[#141414] border border-white/[0.08] rounded-lg px-4 py-3 shadow-xl flex items-center gap-3 z-40">
          <Loader2 className="w-4 h-4 animate-spin text-purple-400" />
          <div>
            <p className="text-xs font-medium text-gray-200">Generating briefs...</p>
            <p className="text-[10px] text-gray-500">{generatingStep}</p>
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
    </div>
  );
}
