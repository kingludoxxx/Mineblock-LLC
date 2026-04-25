import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Globe,
  Search,
  ChevronDown,
  ChevronUp,
  CheckSquare,
  Square,
  Loader2,
  CheckCircle2,
  AlertCircle,
  SkipForward,
  ExternalLink,
  RefreshCw,
  FolderOpen,
  Languages,
  Video,
  X,
} from 'lucide-react';

const LANG_OPTIONS = [
  { code: 'ES', label: 'Spanish',  flag: '🇪🇸' },
  { code: 'FR', label: 'French',   flag: '🇫🇷' },
  { code: 'DT', label: 'Dutch',    flag: '🇳🇱' },
  { code: 'IT', label: 'Italian',  flag: '🇮🇹' },
];

// Debounce hook
function useDebounce(value, delay) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export default function LanguagesPipeline() {
  // Source tasks
  const [sourceTasks, setSourceTasks]   = useState([]);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [searchQuery, setSearchQuery]   = useState('');
  const debouncedSearch = useDebounce(searchQuery, 300);

  // Selection
  const [selectedTaskIds, setSelectedTaskIds]     = useState(new Set());
  const [selectedLangCodes, setSelectedLangCodes] = useState(new Set());

  // Generation
  const [generating, setGenerating] = useState(false);
  const [results, setResults]       = useState([]);
  const [summary, setSummary]       = useState(null);

  // Existing language cards panel
  const [langTasks, setLangTasks]         = useState([]);
  const [loadingLangTasks, setLoadingLangTasks] = useState(false);
  const [showLangTasks, setShowLangTasks] = useState(false);

  // ── Load source tasks ──
  const loadSourceTasks = useCallback(async (search = '') => {
    setLoadingTasks(true);
    try {
      const params = search ? `?search=${encodeURIComponent(search)}` : '';
      const res = await fetch(`/api/v1/languages-pipeline/source-tasks${params}`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSourceTasks(data.tasks || []);
    } catch (err) {
      console.error('Failed to load source tasks:', err);
    } finally {
      setLoadingTasks(false);
    }
  }, []);

  useEffect(() => {
    loadSourceTasks(debouncedSearch);
  }, [debouncedSearch, loadSourceTasks]);

  // ── Load existing language cards ──
  const loadLangTasks = useCallback(async () => {
    setLoadingLangTasks(true);
    try {
      const res = await fetch('/api/v1/languages-pipeline/languages-tasks', {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setLangTasks(data.tasks || []);
    } catch (err) {
      console.error('Failed to load language cards:', err);
    } finally {
      setLoadingLangTasks(false);
    }
  }, []);

  // ── Task selection ──
  const toggleTask = (id) => {
    setSelectedTaskIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleAllVisible = () => {
    const visibleIds = sourceTasks.map((t) => t.id);
    setSelectedTaskIds((prev) => {
      const allSelected = visibleIds.every((id) => prev.has(id));
      const next = new Set(prev);
      if (allSelected) {
        visibleIds.forEach((id) => next.delete(id));
      } else {
        visibleIds.forEach((id) => next.add(id));
      }
      return next;
    });
  };

  // ── Language selection ──
  const toggleLang = (code) => {
    setSelectedLangCodes((prev) => {
      const next = new Set(prev);
      next.has(code) ? next.delete(code) : next.add(code);
      return next;
    });
  };

  // ── Generate ──
  const handleGenerate = async () => {
    if (selectedTaskIds.size === 0 || selectedLangCodes.size === 0) return;

    setGenerating(true);
    setResults([]);
    setSummary(null);

    try {
      const res = await fetch('/api/v1/languages-pipeline/generate', {
        method:      'POST',
        credentials: 'include',
        headers:     { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskIds:       Array.from(selectedTaskIds),
          languageCodes: Array.from(selectedLangCodes),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setResults([{ status: 'error', error: 'request_failed', message: data.error || `HTTP ${res.status}` }]);
        return;
      }
      setResults(data.results || []);
      setSummary(data.summary || null);
      // Auto-clear selection after success
      if ((data.summary?.created || 0) > 0) {
        setSelectedTaskIds(new Set());
      }
    } catch (err) {
      setResults([{ status: 'error', error: 'network_error', message: err.message }]);
    } finally {
      setGenerating(false);
    }
  };

  const totalPairs = selectedTaskIds.size * selectedLangCodes.size;
  const canGenerate = selectedTaskIds.size > 0 && selectedLangCodes.size > 0 && !generating;

  const visibleAllSelected =
    sourceTasks.length > 0 && sourceTasks.every((t) => selectedTaskIds.has(t.id));

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      {/* Header */}
      <div className="border-b border-white/10 bg-[#0f0f0f] px-8 py-6">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-[#f9c74f]/20 to-[#f4a11d]/10 border border-[#f9c74f]/20">
            <Globe className="h-5 w-5 text-[#f9c74f]" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-white">Video Ads Languages Pipeline</h1>
            <p className="text-sm text-white/40 mt-0.5">
              Translate winning English ads into ES · FR · DT · IT — native, not AI
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => {
                setShowLangTasks((v) => !v);
                if (!showLangTasks) loadLangTasks();
              }}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-sm text-white/70 transition-colors"
            >
              <Languages className="h-4 w-4" />
              {showLangTasks ? 'Hide' : 'View'} Existing Cards
              {showLangTasks ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </button>
            <button
              onClick={() => loadSourceTasks(debouncedSearch)}
              disabled={loadingTasks}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-sm text-white/70 transition-colors"
            >
              <RefreshCw className={`h-4 w-4 ${loadingTasks ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>
      </div>

      <div className="p-8 space-y-6 max-w-6xl mx-auto">

        {/* Existing language cards panel */}
        {showLangTasks && (
          <div className="rounded-2xl bg-[#141414] border border-white/10 overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
              <div className="flex items-center gap-2">
                <Languages className="h-4 w-4 text-[#f9c74f]" />
                <span className="text-sm font-medium">Existing Language Cards</span>
                <span className="text-xs text-white/40 bg-white/5 px-2 py-0.5 rounded-full">
                  {langTasks.length}
                </span>
              </div>
              {loadingLangTasks && <Loader2 className="h-4 w-4 animate-spin text-white/40" />}
            </div>
            <div className="max-h-64 overflow-y-auto">
              {langTasks.length === 0 && !loadingLangTasks ? (
                <p className="text-center text-white/30 text-sm py-8">No language cards yet.</p>
              ) : (
                langTasks.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center justify-between px-6 py-3 border-b border-white/5 hover:bg-white/3 last:border-0"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className={`text-xs font-bold px-2 py-0.5 rounded-md ${
                        t.langCode === 'ES' ? 'bg-[#f9c74f]/15 text-[#f9c74f]' :
                        t.langCode === 'FR' ? 'bg-[#4cc9f0]/15 text-[#4cc9f0]' :
                        t.langCode === 'DT' ? 'bg-[#f77f00]/15 text-[#f77f00]' :
                        'bg-[#90be6d]/15 text-[#90be6d]'
                      }`}>{t.langCode || '??'}</span>
                      <span className="text-sm text-white/70 truncate">{t.name}</span>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className="text-xs text-white/30 capitalize">{t.status}</span>
                      {t.url && (
                        <a href={t.url} target="_blank" rel="noopener noreferrer"
                          className="text-white/30 hover:text-[#f9c74f] transition-colors">
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        <div className="grid grid-cols-3 gap-6">
          {/* ── LEFT: Source task picker ── */}
          <div className="col-span-2 rounded-2xl bg-[#141414] border border-white/10 overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
              <div className="flex items-center gap-2">
                <Video className="h-4 w-4 text-[#f9c74f]" />
                <span className="text-sm font-medium">Select Source Ads</span>
                {selectedTaskIds.size > 0 && (
                  <span className="text-xs bg-[#f9c74f]/15 text-[#f9c74f] px-2 py-0.5 rounded-full">
                    {selectedTaskIds.size} selected
                  </span>
                )}
              </div>
              <button
                onClick={toggleAllVisible}
                className="text-xs text-white/40 hover:text-white/70 transition-colors"
              >
                {visibleAllSelected ? 'Deselect all' : 'Select all'}
              </button>
            </div>

            {/* Search */}
            <div className="px-4 py-3 border-b border-white/10">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-white/30" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search by brief code, angle, avatar..."
                  className="w-full pl-9 pr-9 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-white/30 focus:outline-none focus:border-[#f9c74f]/40 focus:ring-1 focus:ring-[#f9c74f]/20 transition-all"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/70"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>

            {/* Task list */}
            <div className="flex-1 overflow-y-auto" style={{ maxHeight: '400px' }}>
              {loadingTasks ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-[#f9c74f]/50" />
                </div>
              ) : sourceTasks.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-white/30">
                  <FolderOpen className="h-8 w-8 mb-2" />
                  <p className="text-sm">No tasks found</p>
                </div>
              ) : (
                sourceTasks.map((task) => {
                  const isSelected = selectedTaskIds.has(task.id);
                  return (
                    <button
                      key={task.id}
                      onClick={() => toggleTask(task.id)}
                      className={`w-full flex items-start gap-3 px-5 py-3 text-left border-b border-white/5 hover:bg-white/5 transition-colors last:border-0 ${
                        isSelected ? 'bg-[#f9c74f]/5' : ''
                      }`}
                    >
                      <span className="mt-0.5 flex-shrink-0">
                        {isSelected
                          ? <CheckSquare className="h-4 w-4 text-[#f9c74f]" />
                          : <Square className="h-4 w-4 text-white/30" />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className={`text-sm truncate leading-tight ${isSelected ? 'text-[#f9c74f]' : 'text-white/80'}`}>
                          {task.name}
                        </p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-xs text-white/30 capitalize">{task.status}</span>
                          {task.hasScript ? (
                            <span className="text-xs text-green-400/60">✓ Has script</span>
                          ) : (
                            <span className="text-xs text-red-400/60">⚠ No script</span>
                          )}
                          {task.frameLink && (
                            <span className="text-xs text-blue-400/60">📁 Frame.io</span>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            <div className="px-6 py-3 border-t border-white/10 bg-white/2">
              <p className="text-xs text-white/30">
                {sourceTasks.length} ads loaded from Video Ad Pipeline
              </p>
            </div>
          </div>

          {/* ── RIGHT: Language selector + Generate ── */}
          <div className="space-y-4">
            {/* Language toggles */}
            <div className="rounded-2xl bg-[#141414] border border-white/10 overflow-hidden">
              <div className="flex items-center gap-2 px-6 py-4 border-b border-white/10">
                <Globe className="h-4 w-4 text-[#f9c74f]" />
                <span className="text-sm font-medium">Target Languages</span>
              </div>
              <div className="p-4 space-y-2">
                {LANG_OPTIONS.map(({ code, label, flag }) => {
                  const active = selectedLangCodes.has(code);
                  return (
                    <button
                      key={code}
                      onClick={() => toggleLang(code)}
                      className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border transition-all ${
                        active
                          ? 'bg-[#f9c74f]/10 border-[#f9c74f]/30 text-[#f9c74f]'
                          : 'bg-white/3 border-white/10 text-white/60 hover:bg-white/8 hover:text-white/80'
                      }`}
                    >
                      <span className="text-lg leading-none">{flag}</span>
                      <span className="font-semibold text-sm">{code}</span>
                      <span className="text-xs opacity-70">{label}</span>
                      <span className="ml-auto">
                        {active
                          ? <CheckSquare className="h-4 w-4" />
                          : <Square className="h-4 w-4" />}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Summary card */}
            {totalPairs > 0 && (
              <div className="rounded-xl bg-[#f9c74f]/5 border border-[#f9c74f]/20 p-4">
                <p className="text-xs text-[#f9c74f]/80 mb-1">Ready to generate</p>
                <p className="text-2xl font-bold text-[#f9c74f]">{totalPairs}</p>
                <p className="text-xs text-white/40 mt-1">
                  {selectedTaskIds.size} ad{selectedTaskIds.size !== 1 ? 's' : ''} ×{' '}
                  {selectedLangCodes.size} language{selectedLangCodes.size !== 1 ? 's' : ''}
                </p>
                <p className="text-xs text-white/30 mt-2">
                  Each card gets a native-sounding translated script + Frame.io subfolder
                </p>
              </div>
            )}

            {/* Generate button */}
            <button
              onClick={handleGenerate}
              disabled={!canGenerate}
              className={`w-full flex items-center justify-center gap-2 py-4 rounded-2xl font-semibold text-sm transition-all ${
                canGenerate
                  ? 'bg-gradient-to-r from-[#f9c74f] to-[#f4a11d] text-black hover:opacity-90 active:scale-[0.98]'
                  : 'bg-white/5 text-white/20 cursor-not-allowed border border-white/10'
              }`}
            >
              {generating ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Translating & creating...
                </>
              ) : (
                <>
                  <Globe className="h-4 w-4" />
                  Generate {totalPairs > 0 ? `${totalPairs} Cards` : 'Language Versions'}
                </>
              )}
            </button>

            {/* Generating note */}
            {generating && (
              <div className="rounded-xl bg-white/5 border border-white/10 p-4">
                <p className="text-xs text-white/50 text-center leading-relaxed">
                  Translating scripts with Claude Sonnet.<br />
                  Creating Frame.io subfolders.<br />
                  This takes ~{totalPairs * 8}–{totalPairs * 15} seconds.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* ── Results panel ── */}
        {results.length > 0 && (
          <div className="rounded-2xl bg-[#141414] border border-white/10 overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium">Results</span>
                {summary && (
                  <div className="flex items-center gap-2">
                    {summary.created > 0 && (
                      <span className="text-xs bg-green-500/15 text-green-400 px-2 py-0.5 rounded-full">
                        {summary.created} created
                      </span>
                    )}
                    {summary.skipped > 0 && (
                      <span className="text-xs bg-yellow-500/15 text-yellow-400 px-2 py-0.5 rounded-full">
                        {summary.skipped} skipped
                      </span>
                    )}
                    {summary.errors > 0 && (
                      <span className="text-xs bg-red-500/15 text-red-400 px-2 py-0.5 rounded-full">
                        {summary.errors} failed
                      </span>
                    )}
                  </div>
                )}
              </div>
              <button
                onClick={() => { setResults([]); setSummary(null); }}
                className="text-white/30 hover:text-white/70 transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="divide-y divide-white/5">
              {results.map((r, i) => {
                const statusConfig = {
                  created: {
                    icon: <CheckCircle2 className="h-4 w-4 text-green-400" />,
                    bg:   'bg-green-500/5',
                    label: 'Created',
                    labelColor: 'text-green-400',
                  },
                  skipped: {
                    icon: <SkipForward className="h-4 w-4 text-yellow-400" />,
                    bg:   'bg-yellow-500/5',
                    label: 'Skipped',
                    labelColor: 'text-yellow-400',
                  },
                  error: {
                    icon: <AlertCircle className="h-4 w-4 text-red-400" />,
                    bg:   'bg-red-500/5',
                    label: 'Failed',
                    labelColor: 'text-red-400',
                  },
                }[r.status] || {};

                return (
                  <div key={i} className={`flex items-start gap-4 px-6 py-4 ${statusConfig.bg || ''}`}>
                    <span className="mt-0.5 flex-shrink-0">{statusConfig.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        {r.langCode && (
                          <span className="text-xs font-bold bg-white/10 px-2 py-0.5 rounded-md text-white/80">
                            {r.langCode}
                          </span>
                        )}
                        <span className="text-sm text-white/80 truncate">
                          {r.langTaskName || r.sourceName || r.taskId}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 mt-1">
                        <span className={`text-xs font-medium ${statusConfig.labelColor}`}>
                          {statusConfig.label}
                        </span>
                        {r.message && (
                          <span className="text-xs text-white/40 truncate">{r.message}</span>
                        )}
                        {r.frameWarning === 'subfolder_failed' && (
                          <span className="text-xs text-orange-400/70">⚠ Frame.io subfolder failed</span>
                        )}
                        {r.frameWarning === 'no_source_frame_link' && (
                          <span className="text-xs text-orange-400/70">⚠ Source has no Frame.io link</span>
                        )}
                        {r.frameExisted && (
                          <span className="text-xs text-blue-400/70">📁 Reused existing subfolder</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {r.newTaskUrl && (
                        <a
                          href={r.newTaskUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-xs text-[#f9c74f]/70 hover:text-[#f9c74f] transition-colors px-2 py-1 rounded-lg bg-[#f9c74f]/10 hover:bg-[#f9c74f]/20"
                        >
                          <ExternalLink className="h-3 w-3" />
                          ClickUp
                        </a>
                      )}
                      {r.frameUrl && (
                        <a
                          href={r.frameUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-xs text-blue-400/70 hover:text-blue-400 transition-colors px-2 py-1 rounded-lg bg-blue-400/10 hover:bg-blue-400/20"
                        >
                          <FolderOpen className="h-3 w-3" />
                          Frame.io
                        </a>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
