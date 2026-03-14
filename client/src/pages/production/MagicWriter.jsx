import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Wand2,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Zap,
  FileText,
  ArrowRight,
  Sparkles,
} from 'lucide-react';
import api from '../../services/api';

const STORAGE_KEY = 'magic-writer-product-profile';

function loadProfile() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {
    productName: '',
    benefits: '',
    targetAudience: '',
    uniqueMechanism: '',
    powerPhrases: '',
  };
}

export default function MagicWriter() {
  // Mode: 'competitor' or 'myScript'
  const [mode, setMode] = useState('competitor');

  // Script input
  const [script, setScript] = useState('');

  // Product profile
  const [profile, setProfile] = useState(loadProfile);
  const [profileOpen, setProfileOpen] = useState(true);

  // Generation state
  const [generating, setGenerating] = useState(false);
  const [results, setResults] = useState(null); // competitor: { rephrased } | myScript step1: { variants[] } | step2: { hooks[], selectedVariant }
  const [step, setStep] = useState(1); // for myScript mode: 1 = variations, 2 = hooks
  const [selectedVariant, setSelectedVariant] = useState(null);
  const [selectedBodyOpen, setSelectedBodyOpen] = useState(false);

  // Copy feedback
  const [copiedId, setCopiedId] = useState(null);

  // Debounced save to localStorage
  const saveTimer = useRef(null);
  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
    }, 500);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [profile]);

  // Reset results when mode changes
  useEffect(() => {
    setResults(null);
    setStep(1);
    setSelectedVariant(null);
  }, [mode]);

  const updateProfile = useCallback((field, value) => {
    setProfile((prev) => ({ ...prev, [field]: value }));
  }, []);

  const copyText = useCallback((text, id) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  }, []);

  const canGenerate = script.trim().length > 0;

  // Main generate handler
  const handleGenerate = useCallback(async () => {
    if (!canGenerate) return;
    setGenerating(true);

    if (mode === 'competitor') {
      try {
        const res = await api.post('/magic-writer/generate', {
          mode: 'competitor',
          script,
          productProfile: profile,
          variantCount: 1,
        });
        setResults({ rephrased: res.data.variants?.[0]?.text || res.data.rephrased || '' });
      } catch {
        setResults({ rephrased: '[Error generating — please try again]' });
      } finally {
        setGenerating(false);
      }
    } else {
      // myScript mode
      if (step === 1) {
        try {
          const res = await api.post('/magic-writer/generate', {
            mode: 'variations',
            script,
            productProfile: profile,
            variantCount: 5,
          });
          const variants = res.data.variants || [];
          setResults({ variants });
        } catch {
          setResults({ variants: [] });
        } finally {
          setGenerating(false);
        }
      } else if (step === 2 && selectedVariant) {
        try {
          const res = await api.post('/magic-writer/generate-hooks', {
            selectedVariant: selectedVariant.text,
            productProfile: profile,
            hookCount: 5,
          });
          const hooks = res.data.hooks || [];
          setResults((prev) => ({ ...prev, hooks, selectedVariant }));
        } catch {
          setResults((prev) => ({ ...prev, hooks: [], selectedVariant }));
        } finally {
          setGenerating(false);
        }
      } else {
        setGenerating(false);
      }
    }
  }, [canGenerate, mode, script, profile, step, selectedVariant]);

  const handleSelectVariant = useCallback((variant) => {
    setSelectedVariant(variant);
    setStep(2);
    setResults((prev) => ({ ...prev, hooks: null }));
  }, []);

  const actionLabel = () => {
    if (mode === 'competitor') return 'Rephrase for My Product';
    if (step === 1) return 'Generate 5 Variations';
    return 'Generate 5 Hooks';
  };

  const placeholderText =
    mode === 'competitor'
      ? "Paste the competitor's ad script here..."
      : 'Paste your winning script here...';

  return (
    <div className="flex h-full -m-6">
      {/* Left Panel — 40% */}
      <div className="w-[40%] min-w-[380px] overflow-y-auto p-6 border-r border-white/[0.06]">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 rounded-lg bg-purple-500/20">
            <Wand2 className="w-5 h-5 text-purple-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Magic Writer</h1>
            <p className="text-sm text-slate-400">AI-powered ad copywriting</p>
          </div>
        </div>

        {/* Mode Toggle */}
        <div className="flex bg-[#111] rounded-lg border border-white/[0.06] p-0.5 mb-6">
          <button
            onClick={() => setMode('competitor')}
            className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors cursor-pointer ${
              mode === 'competitor'
                ? 'bg-purple-600 text-white'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Competitor Script
          </button>
          <button
            onClick={() => setMode('myScript')}
            className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors cursor-pointer ${
              mode === 'myScript'
                ? 'bg-purple-600 text-white'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            My Winning Script
          </button>
        </div>

        {/* Script Input */}
        <section className="mb-6">
          <label className="text-sm font-medium text-slate-300 mb-2 block">Script Input</label>
          <textarea
            value={script}
            onChange={(e) => setScript(e.target.value)}
            placeholder={placeholderText}
            className="w-full h-44 bg-[#111] border border-white/[0.06] rounded-lg p-3 text-sm text-white placeholder-slate-500 resize-none focus:outline-none focus:border-purple-500/50 transition-colors"
          />
        </section>

        {/* Product Profile — Collapsible */}
        <section className="mb-6">
          <button
            onClick={() => setProfileOpen((o) => !o)}
            className="flex items-center justify-between w-full text-sm font-medium text-slate-300 mb-3 cursor-pointer"
          >
            <span>Product Profile</span>
            {profileOpen ? (
              <ChevronUp className="w-4 h-4 text-slate-500" />
            ) : (
              <ChevronDown className="w-4 h-4 text-slate-500" />
            )}
          </button>

          {profileOpen && (
            <div className="space-y-3">
              <div>
                <label className="text-xs text-slate-500 mb-1 block">Product Name</label>
                <input
                  type="text"
                  value={profile.productName}
                  onChange={(e) => updateProfile('productName', e.target.value)}
                  placeholder="e.g. GlowSkin Serum"
                  className="w-full bg-[#111] border border-white/[0.06] rounded-lg p-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500/50 transition-colors"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">Key Benefits</label>
                <textarea
                  rows={3}
                  value={profile.benefits}
                  onChange={(e) => updateProfile('benefits', e.target.value)}
                  placeholder="List the main benefits, one per line..."
                  className="w-full bg-[#111] border border-white/[0.06] rounded-lg p-3 text-sm text-white placeholder-slate-500 resize-none focus:outline-none focus:border-purple-500/50 transition-colors"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">Target Audience</label>
                <input
                  type="text"
                  value={profile.targetAudience}
                  onChange={(e) => updateProfile('targetAudience', e.target.value)}
                  placeholder="e.g. Women 25-40 with acne-prone skin"
                  className="w-full bg-[#111] border border-white/[0.06] rounded-lg p-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500/50 transition-colors"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">Unique Mechanism</label>
                <input
                  type="text"
                  value={profile.uniqueMechanism}
                  onChange={(e) => updateProfile('uniqueMechanism', e.target.value)}
                  placeholder="e.g. Patented BioRetinol Complex"
                  className="w-full bg-[#111] border border-white/[0.06] rounded-lg p-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500/50 transition-colors"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">Power Phrases</label>
                <textarea
                  rows={3}
                  value={profile.powerPhrases}
                  onChange={(e) => updateProfile('powerPhrases', e.target.value)}
                  placeholder="Phrases you use in 90% of your videos..."
                  className="w-full bg-[#111] border border-white/[0.06] rounded-lg p-3 text-sm text-white placeholder-slate-500 resize-none focus:outline-none focus:border-purple-500/50 transition-colors"
                />
              </div>
            </div>
          )}
        </section>

        {/* Action Button */}
        <button
          onClick={handleGenerate}
          disabled={!canGenerate || generating}
          className={`w-full py-3.5 rounded-lg font-semibold text-sm flex items-center justify-center gap-2 transition-all cursor-pointer ${
            canGenerate && !generating
              ? 'bg-gradient-to-r from-purple-600 to-purple-500 text-white hover:from-purple-500 hover:to-purple-400 shadow-lg shadow-purple-500/25'
              : 'bg-slate-800 text-slate-500 cursor-not-allowed'
          }`}
        >
          {generating ? (
            <>
              <RefreshCw className="w-4 h-4 animate-spin" />
              Generating...
            </>
          ) : (
            <>
              <Zap className="w-4 h-4" />
              {actionLabel()}
            </>
          )}
        </button>
      </div>

      {/* Right Panel — 60% */}
      <div className="flex-1 overflow-y-auto p-6">
        {generating ? (
          /* Loading */
          <div className="flex flex-col items-center justify-center h-full">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-purple-500/20 to-pink-500/20 flex items-center justify-center mb-4 animate-pulse">
              <Wand2 className="w-8 h-8 text-purple-400" />
            </div>
            <h2 className="text-lg font-semibold text-white mb-1">Crafting your copy...</h2>
            <p className="text-sm text-slate-400">
              {mode === 'competitor'
                ? 'Rephrasing the script for your product'
                : step === 1
                  ? 'Generating 5 script variations'
                  : 'Generating 5 new hooks'}
            </p>
            <div className="mt-6 flex gap-1">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="w-2 h-2 rounded-full bg-purple-500 animate-bounce"
                  style={{ animationDelay: `${i * 0.15}s` }}
                />
              ))}
            </div>
          </div>
        ) : !results ? (
          /* Empty State */
          <div className="flex flex-col items-center justify-center h-full max-w-lg mx-auto">
            <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-purple-500/20 to-pink-500/20 flex items-center justify-center mb-6">
              <FileText className="w-10 h-10 text-purple-400" />
            </div>
            <h2 className="text-xl font-bold text-white mb-2">
              {mode === 'competitor' ? 'Competitor Script Mode' : 'My Winning Script Mode'}
            </h2>
            <p className="text-slate-400 text-sm text-center leading-relaxed">
              {mode === 'competitor'
                ? "Paste a competitor's ad script on the left and click \"Rephrase for My Product\". The AI will adapt their script structure and persuasion angles to sell your product instead."
                : 'Paste your own winning script on the left. First, generate 5 variations to find the best body. Then pick your favorite and generate 5 new hooks to test against each other.'}
            </p>
          </div>
        ) : mode === 'competitor' && results.rephrased !== undefined ? (
          /* Competitor Mode — Single rephrased script */
          <div>
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-bold text-white">Rephrased Script</h2>
              <button
                onClick={() => copyText(results.rephrased, 'rephrased')}
                className="flex items-center gap-2 px-3 py-1.5 text-sm bg-[#111] border border-white/[0.06] rounded-lg text-slate-300 hover:text-white hover:border-white/[0.12] transition-colors cursor-pointer"
              >
                {copiedId === 'rephrased' ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-green-400" />
                    <span className="text-green-400">Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    Copy
                  </>
                )}
              </button>
            </div>
            <div className="bg-[#111] border border-white/[0.06] rounded-lg p-5">
              <pre className="text-sm text-slate-300 whitespace-pre-wrap font-sans leading-relaxed">
                {results.rephrased}
              </pre>
            </div>
          </div>
        ) : mode === 'myScript' && step === 1 && results.variants ? (
          /* My Script — Step 1: Variations */
          <div>
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-bold text-white">
                Script Variations
                <span className="text-sm font-normal text-slate-400 ml-2">
                  Pick one to generate hooks
                </span>
              </h2>
            </div>
            {results.variants.length === 0 ? (
              <p className="text-slate-400 text-sm">No variations were returned. Try again.</p>
            ) : (
              <div className="space-y-4">
                {results.variants.map((variant, index) => (
                  <div
                    key={index}
                    className="bg-[#111] border border-white/[0.06] rounded-lg overflow-hidden"
                  >
                    <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/[0.06] bg-white/[0.02]">
                      <span className="text-xs font-medium text-slate-400">
                        Variation {index + 1}
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => copyText(variant.text, `var-${index}`)}
                          className="p-1.5 text-slate-400 hover:text-white rounded-md hover:bg-white/[0.06] transition-colors cursor-pointer"
                          title="Copy"
                        >
                          {copiedId === `var-${index}` ? (
                            <Check className="w-3.5 h-3.5 text-green-400" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                        <button
                          onClick={() => handleSelectVariant(variant)}
                          className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md bg-green-500/15 text-green-400 hover:bg-green-500/25 transition-colors cursor-pointer"
                        >
                          Use This
                          <ArrowRight className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                    <div className="p-4">
                      <pre className="text-sm text-slate-300 whitespace-pre-wrap font-sans leading-relaxed">
                        {variant.text}
                      </pre>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : mode === 'myScript' && step === 2 ? (
          /* My Script — Step 2: Hooks */
          <div>
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-bold text-white">
                {results.hooks ? 'Generated Hooks' : 'Ready for Hooks'}
              </h2>
              {!results.hooks && (
                <span className="text-sm text-slate-400">
                  Click "Generate 5 Hooks" on the left
                </span>
              )}
            </div>

            {/* Selected variant body — collapsible */}
            {selectedVariant && (
              <div className="mb-6 bg-[#111] border border-white/[0.06] rounded-lg overflow-hidden">
                <button
                  onClick={() => setSelectedBodyOpen((o) => !o)}
                  className="flex items-center justify-between w-full px-4 py-3 cursor-pointer"
                >
                  <span className="text-xs font-medium text-purple-400">Selected Script Body</span>
                  {selectedBodyOpen ? (
                    <ChevronUp className="w-4 h-4 text-slate-500" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-slate-500" />
                  )}
                </button>
                {selectedBodyOpen && (
                  <div className="px-4 pb-4 border-t border-white/[0.06]">
                    <pre className="text-sm text-slate-400 whitespace-pre-wrap font-sans leading-relaxed mt-3">
                      {selectedVariant.text}
                    </pre>
                  </div>
                )}
              </div>
            )}

            {/* Hook cards */}
            {results.hooks && results.hooks.length > 0 && (
              <div className="space-y-4">
                {results.hooks.map((hook, index) => {
                  const hookText = typeof hook === 'string' ? hook : hook.text;
                  const fullScript = hookText + '\n\n' + (selectedVariant?.text || '');
                  return (
                    <div
                      key={index}
                      className="bg-[#111] border border-white/[0.06] rounded-lg overflow-hidden"
                    >
                      <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/[0.06] bg-white/[0.02]">
                        <span className="text-xs font-medium text-slate-400">
                          Hook {index + 1}
                        </span>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => copyText(hookText, `hook-${index}`)}
                            className="p-1.5 text-slate-400 hover:text-white rounded-md hover:bg-white/[0.06] transition-colors cursor-pointer"
                            title="Copy hook"
                          >
                            {copiedId === `hook-${index}` ? (
                              <Check className="w-3.5 h-3.5 text-green-400" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>
                          <button
                            onClick={() => copyText(fullScript, `full-${index}`)}
                            className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md bg-purple-500/15 text-purple-400 hover:bg-purple-500/25 transition-colors cursor-pointer"
                          >
                            {copiedId === `full-${index}` ? (
                              <>
                                <Check className="w-3 h-3 text-green-400" />
                                <span className="text-green-400">Copied</span>
                              </>
                            ) : (
                              <>
                                <Sparkles className="w-3 h-3" />
                                Copy Full Script
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                      <div className="p-4">
                        <pre className="text-sm text-slate-300 whitespace-pre-wrap font-sans leading-relaxed">
                          {hookText}
                        </pre>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {results.hooks && results.hooks.length === 0 && (
              <p className="text-slate-400 text-sm">No hooks were returned. Try again.</p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
