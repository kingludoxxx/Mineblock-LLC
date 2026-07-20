import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { FileText, Video, Wand2, Loader2, Sparkles, ChevronDown, Package, Check, AlertCircle } from 'lucide-react';
import ProductSelector from '../../../components/ProductSelector';
import api from '../../../services/api';

// Fallback when the selected product has no angles in the Product Library.
const FALLBACK_ANGLES = [
  { name: 'Pain Point',       funnel_stage: 'top' },
  { name: 'Curiosity Hook',   funnel_stage: 'top' },
  { name: 'Breaking news',    funnel_stage: 'top' },
  { name: 'Social Proof',     funnel_stage: 'middle' },
  { name: 'Authority',        funnel_stage: 'middle' },
  { name: 'Before/After',     funnel_stage: 'middle' },
  { name: 'Direct Offer',     funnel_stage: 'bottom' },
  { name: 'Scarcity',         funnel_stage: 'bottom' },
];

const FUNNEL_ORDER = { top: 0, middle: 1, bottom: 2 };
const FUNNEL_LABEL = { top: 'Top of Funnel', middle: 'Middle of Funnel', bottom: 'Bottom of Funnel' };

// ── Iteration vectors ──────────────────────────────────────────────────
// Each iteration card can pull one or more of these levers. Angle, product,
// mechanism, and CTA structure are LOCKED — handled server-side. These are
// the things the user CAN change.
const ITERATION_VECTORS = [
  { key: 'hooks',     label: 'Hooks',         description: 'Refresh the 5 hooks with different mechanism families' },
  { key: 'format',    label: 'Format Swap',   description: 'Re-deliver the script in a different format vehicle' },
  { key: 'avatar',    label: 'Avatar / POV',  description: 'Rewrite from a different speaker perspective' },
  { key: 'length',    label: 'Length',        description: 'Compress to a tighter cut while preserving every beat' },
  { key: 'proofLead', label: 'Proof Lead',    description: 'Rotate which proof element leads the body' },
  { key: 'opening3s', label: 'Opening 3s',    description: 'Rewrite only the cold open + first hook to match' },
];

const DEFAULT_FORMATS = [
  'Mashup', 'Short Video', 'UGC Selfie', 'Studio Testimonial', 'Voiceover', 'GIF', 'Cartoon',
];
const DEFAULT_AVATARS = [
  'Founder POV', 'Customer Testimonial', 'Skeptic-Converted', 'Expert / Authority', 'Creator (UGC)',
];
const LENGTH_TARGETS  = ['Auto (vary)', '85% of original', '75% of original', '65% of original', '50% of original'];
const PROOF_TARGETS   = ['Auto (rotate)', 'Data', 'Story', 'Comparison', 'Testimonial'];

const VECTOR_LABEL = ITERATION_VECTORS.reduce((acc, v) => ({ ...acc, [v.key]: v.label }), {});

const ScriptGeneratorPanel = forwardRef(function ScriptGeneratorPanel({
  onGenerated,
  generating,
  generatingStep,
  initialScript,
  initialMode,
  initialReferenceId,
  referenceLabel,
  onClearReference,
  selectedModel: externalSelectedModel,
  onModelChange: externalOnModelChange,
}, ref) {
  const [inputMode, setInputMode] = useState('text');
  const [scriptText, setScriptText] = useState('');
  const [scriptUrl, setScriptUrl] = useState('');
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [productList, setProductList] = useState([]);
  const [selectedAngle, setSelectedAngle] = useState(null);
  const [customAngle, setCustomAngle] = useState('');
  const [outputMode, setOutputMode] = useState('clone');
  const [variantCount, setVariantCount] = useState(3);
  // Iteration vectors — default is Hooks-only (safest most common iteration).
  const [iterationVectors, setIterationVectors] = useState({
    hooks:     { enabled: true,  target: null },
    format:    { enabled: false, target: 'Auto (rotate)' },
    avatar:    { enabled: false, target: 'Auto (rotate)' },
    length:    { enabled: false, target: 'Auto (vary)' },
    proofLead: { enabled: false, target: 'Auto (rotate)' },
    opening3s: { enabled: false, target: null },
  });
  const [enhancing, setEnhancing] = useState(false);
  const [error, setError] = useState(null);
  const [internalSelectedModel, setInternalSelectedModel] = useState('claude');

  // Use external model if provided by parent, otherwise use internal state
  const selectedModel = externalSelectedModel !== undefined ? externalSelectedModel : internalSelectedModel;
  const setSelectedModel = externalOnModelChange || setInternalSelectedModel;

  useImperativeHandle(ref, () => ({
    getSelectedModel: () => selectedModel,
  }));

  // Apply external prefill (from Reference card → "Generate Brief"). The
  // script and its referenceId must travel as ONE atomic unit: keying the
  // dedup on script text alone let scriptText lag behind a newer
  // initialReferenceId (stale textarea surviving a clear / no-transcript
  // prefill), so a generate could pair the OLD script with a NEW reference.
  // The dedup key is now referenceId+script, the applied referenceId is
  // captured in state alongside the script (handleGenerate reads THAT, never
  // the live prop), and a cleared prefill resets everything.
  const appliedScriptRef = useRef(null);
  const appliedModeRef = useRef(null);
  const [appliedReferenceId, setAppliedReferenceId] = useState(null);
  useEffect(() => {
    const prefillKey = initialScript ? `${initialReferenceId || 'manual'}::${initialScript}` : null;
    if (prefillKey && appliedScriptRef.current !== prefillKey) {
      appliedScriptRef.current = prefillKey;
      setInputMode('text');
      setScriptText(initialScript);
      setAppliedReferenceId(initialReferenceId || null);
    }
    if (!initialScript && appliedScriptRef.current !== null) {
      // Prefill cleared (X on the reference banner) — reset so the stale
      // transcript can't survive into the next generation.
      appliedScriptRef.current = null;
      setScriptText('');
      setAppliedReferenceId(null);
    }
    if (initialMode && appliedModeRef.current !== initialMode) {
      appliedModeRef.current = initialMode;
      // 'iterate' is its own mode (META source); fall through to clone or variants
      // for the existing LEAGUE / UPLOAD / manual flows.
      // Only 2 modes now: clone (default) + iterate (META source). Any
      // legacy 'variants' value coming in from old state falls back to clone.
      setOutputMode(initialMode === 'iterate' ? 'iterate' : 'clone');
    }
  }, [initialScript, initialMode, initialReferenceId]);

  // ── MR (Miner Forge Pro) is the default product, always ───────────────
  // Auto-snaps the selection back to MR whenever the field is empty AND
  // the product list has loaded. Triggered on first load AND after the
  // user clicks the X clear button — MR is sticky by design.
  useEffect(() => {
    if (selectedProduct) return;
    if (!productList || productList.length === 0) return;
    const mr = productList.find(p =>
      (p.short_name || '').toUpperCase() === 'MR'
      || (p.product_code || '').toUpperCase() === 'MR'
      || (p.name || '').toLowerCase().includes('miner forge')
    );
    const pick = mr || productList[0];
    if (pick) setSelectedProduct(pick);
  }, [selectedProduct, productList]);

  // ── Product Library bridge ────────────────────────────────────────────
  // When a product is selected, fetch the full profile from the Brief Pipeline
  // bridge endpoint so we can show exactly what fields the prompts will see.
  const [productContext, setProductContext] = useState(null); // { product, context, lineCount }
  const [productContextLoading, setProductContextLoading] = useState(false);
  const [productContextError, setProductContextError] = useState(null);
  const [productContextExpanded, setProductContextExpanded] = useState(false);

  useEffect(() => {
    if (!selectedProduct?.id) {
      setProductContext(null);
      setProductContextError(null);
      return;
    }
    // Per-effect AbortController so React StrictMode's double-invoke + rapid
    // product changes don't surface as "Network Error" (which is what axios
    // throws when an in-flight XHR is cancelled by the next effect run).
    const controller = new AbortController();
    let cancelled = false;
    setProductContextLoading(true);
    setProductContextError(null);

    const fetchContext = async (attempt = 1) => {
      try {
        const r = await api.get(
          `/brief-pipeline/product-context/${selectedProduct.id}`,
          { signal: controller.signal }
        );
        if (cancelled) return;
        setProductContext(r.data);
      } catch (err) {
        // Swallow cancellations — they're not real failures.
        if (cancelled || controller.signal.aborted) return;
        if (err.code === 'ERR_CANCELED' || err.name === 'CanceledError' || err.name === 'AbortError') return;

        // One silent retry for transient network failures (Render cold-start
        // race, proxy timeout, etc.). Most "Network Error" pops resolve here.
        const isNetwork = !err.response;
        if (isNetwork && attempt === 1) {
          await new Promise((r) => setTimeout(r, 600));
          if (cancelled) return;
          return fetchContext(2);
        }

        const apiMsg = err.response?.data?.error?.message;
        const status = err.response?.status;
        const msg = apiMsg
          ? apiMsg
          : status
            ? `HTTP ${status}`
            : 'Couldn\'t reach the server';
        setProductContextError(msg);
        setProductContext(null);
      } finally {
        if (!cancelled) setProductContextLoading(false);
      }
    };
    fetchContext();
    return () => { cancelled = true; controller.abort(); };
  }, [selectedProduct?.id]);

  const hasInput = inputMode === 'text' ? scriptText.trim().length > 20 : scriptUrl.trim().length > 5;
  const hasAnyVectorSelected = Object.values(iterationVectors).some(v => v.enabled);
  const canGenerate = hasInput && !generating && (outputMode !== 'iterate' || hasAnyVectorSelected);

  // Compile the iteration vector selections into the array shape the
  // backend's buildIterationPrompt expects: [{ vector, target, notes }].
  const buildVectorsPayload = () => Object.entries(iterationVectors)
    .filter(([, v]) => v.enabled)
    .map(([k, v]) => ({ vector: VECTOR_LABEL[k], target: v.target || null }));

  const handleGenerate = async () => {
    if (!hasInput) return;
    setError(null);
    try {
      await onGenerated({
        script: inputMode === 'text' ? scriptText : null,
        url: inputMode === 'url' ? scriptUrl : null,
        productId: selectedProduct?.id || null,
        productCode: selectedProduct?.product_code || selectedProduct?.short_name || null,
        angle: selectedAngle || customAngle || null,
        mode: outputMode,
        numVariations: variantCount,
        // appliedReferenceId was captured in the SAME state update as the
        // script text — the live initialReferenceId prop can be newer than
        // the textarea contents (the wrong-reference bug).
        referenceId: appliedReferenceId || null,
        model: selectedModel,
        // Only send vectorsSelected on iterate mode — clone mode ignores it.
        vectorsSelected: outputMode === 'iterate' ? buildVectorsPayload() : undefined,
      });
    } catch (err) {
      setError(err.message || 'Generation failed');
    }
  };

  const [enhanceError, setEnhanceError] = useState(null);
  const handleEnhance = async () => {
    if (!scriptText.trim()) return;
    setEnhancing(true);
    setEnhanceError(null);
    try {
      const r = await api.post('/brief-pipeline/enhance-script', { text: scriptText });
      if (r.data?.enhanced) {
        setScriptText(r.data.enhanced);
      } else {
        setEnhanceError('Enhancer returned no text');
      }
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message || 'Enhance failed';
      setEnhanceError(msg);
    } finally {
      setEnhancing(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Reference Content */}
      <div className="space-y-3">
        <div className="text-[10px] font-mono font-semibold text-zinc-500 uppercase tracking-[0.15em] flex items-center gap-2">
          <div className="w-1 h-1 bg-[#c9a84c]/40 rounded-full" />
          Reference Content
        </div>

        <div className="flex p-1 bg-white/[0.02] rounded-lg border border-white/[0.05] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.02)]">
          <button
            type="button"
            onClick={() => setInputMode('text')}
            className={`flex-1 flex items-center justify-center gap-2 py-1.5 text-xs font-medium rounded-md transition-all duration-300 cursor-pointer ${
              inputMode === 'text'
                ? 'bg-white/[0.06] text-white shadow-[0_1px_2px_rgba(0,0,0,0.2),inset_0_1px_0_0_rgba(255,255,255,0.04)] border border-white/[0.06]'
                : 'text-zinc-500 hover:text-zinc-300 border border-transparent'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            Paste Text
          </button>
          <button
            type="button"
            onClick={() => setInputMode('url')}
            className={`flex-1 flex items-center justify-center gap-2 py-1.5 text-xs font-medium rounded-md transition-all duration-300 cursor-pointer ${
              inputMode === 'url'
                ? 'bg-white/[0.06] text-white shadow-[0_1px_2px_rgba(0,0,0,0.2),inset_0_1px_0_0_rgba(255,255,255,0.04)] border border-white/[0.06]'
                : 'text-zinc-500 hover:text-zinc-300 border border-transparent'
            }`}
          >
            <Video className="w-3.5 h-3.5" />
            Video URL
          </button>
        </div>

        {inputMode === 'text' ? (
          <div>
            <textarea
              value={scriptText}
              onChange={(e) => setScriptText(e.target.value)}
              placeholder="Paste competitor copy, landing page text, article, ad, email..."
              className="w-full h-32 bg-white/[0.02] border border-white/[0.05] rounded-lg p-3 text-sm text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-[#c9a84c]/30 focus:border-[#c9a84c]/20 resize-none transition-all shadow-[inset_0_1px_0_0_rgba(255,255,255,0.02)] block"
            />
            {/* Dedicated action row — well below the textarea with its own card,
                so the Enhance button never visually overlaps with scrolled text. */}
            <div className="mt-3 flex items-center justify-between gap-2 px-3 py-2 rounded-md bg-white/[0.015] border border-white/[0.04]">
              <div className="text-[10px] font-mono text-zinc-500">
                {scriptText.length > 0
                  ? `${scriptText.length} chars · ${scriptText.trim().split(/\s+/).filter(Boolean).length} words`
                  : 'Paste at least 20 characters to enable Enhance'}
              </div>
              <div className="flex items-center gap-2">
                {enhanceError && (
                  <span className="text-[10px] font-mono text-red-400/80 max-w-[14rem] truncate" title={enhanceError}>
                    {enhanceError}
                  </span>
                )}
                <button
                  type="button"
                  onClick={handleEnhance}
                  disabled={enhancing || scriptText.trim().length < 20}
                  title={scriptText.trim().length < 20 ? 'Paste at least 20 characters first' : 'Clean up grammar/punctuation, preserve voice'}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider rounded-md border border-[#c9a84c]/25 bg-[#c9a84c]/10 text-[#e8d5a3] hover:bg-[#c9a84c]/15 hover:border-[#c9a84c]/40 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {enhancing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
                  {enhancing ? 'Enhancing…' : 'Enhance'}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <input
            type="url"
            value={scriptUrl}
            onChange={(e) => setScriptUrl(e.target.value)}
            placeholder="FB Ad Library or direct video URL (.mp4, .webm)"
            className="w-full bg-white/[0.02] border border-white/[0.05] rounded-lg p-3 text-sm text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-[#c9a84c]/30 focus:border-[#c9a84c]/20 transition-all shadow-[inset_0_1px_0_0_rgba(255,255,255,0.02)]"
          />
        )}
      </div>

      {/* Configuration */}
      <div className="space-y-4">

        <div className="space-y-1.5">
          <label className="text-xs text-zinc-400 font-mono">Target_Product</label>
          <ProductSelector
            selectedId={selectedProduct?.id}
            onSelect={(p) => setSelectedProduct(p)}
            onLoad={(list) => setProductList(list || [])}
            allowClear={false}
            className="w-full"
          />

          {/* Product Library context is still fetched (the angle dropdown and
              the generation prompts consume it) — the status/preview panel was
              removed from the layout per operator request. */}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs text-zinc-400 font-mono">Ad_Angle</label>
            {productContext?.product?.angles?.length > 0 && (
              <span className="text-[10px] font-mono text-zinc-500">
                {productContext.product.angles.length} from {productContext.product.short_name || 'product'}
              </span>
            )}
          </div>
          {(() => {
            // Pull angles from the selected product. Fall back to a small
            // generic list only if the product has none.
            const raw = (productContext?.product?.angles && productContext.product.angles.length > 0)
              ? productContext.product.angles
              : FALLBACK_ANGLES;
            // Group by funnel_stage so the dropdown reads top → middle → bottom.
            const groups = raw.reduce((acc, a) => {
              const stage = (a.funnel_stage || 'middle').toLowerCase();
              if (!acc[stage]) acc[stage] = [];
              acc[stage].push(a);
              return acc;
            }, {});
            const stages = Object.keys(groups).sort((x, y) => (FUNNEL_ORDER[x] ?? 9) - (FUNNEL_ORDER[y] ?? 9));
            return (
              <select
                value={selectedAngle || ''}
                onChange={(e) => { setSelectedAngle(e.target.value || null); setCustomAngle(''); }}
                className="w-full bg-[#0a0a0a] border border-white/[0.06] rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-[#c9a84c]/30 focus:border-[#c9a84c]/30 cursor-pointer appearance-none transition-colors hover:border-white/[0.12]"
                style={{
                  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23a1a1aa' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E")`,
                  backgroundRepeat: 'no-repeat',
                  backgroundPosition: 'right 0.75rem center',
                  paddingRight: '2rem',
                }}
              >
                <option value="">— Let AI choose the best angle —</option>
                {stages.map(stage => (
                  <optgroup key={stage} label={FUNNEL_LABEL[stage] || stage.toUpperCase()}>
                    {groups[stage].map((a, i) => (
                      <option key={`${stage}-${i}`} value={a.name}>
                        {a.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            );
          })()}
          <input
            type="text"
            value={customAngle}
            onChange={(e) => { setCustomAngle(e.target.value); setSelectedAngle(null); }}
            placeholder="Or type a custom angle..."
            className="w-full bg-white/[0.02] border border-white/[0.05] rounded-lg p-2 text-sm text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-[#c9a84c]/30 focus:border-[#c9a84c]/20 transition-all shadow-[inset_0_1px_0_0_rgba(255,255,255,0.02)]"
          />
        </div>
      </div>

      {/* Output Mode */}
      <div className="space-y-4">
        <div className="text-[10px] font-mono font-semibold text-zinc-500 uppercase tracking-[0.15em] flex items-center gap-2">
          <div className="w-1 h-1 bg-[#c9a84c]/40 rounded-full" />
          Output Mode
        </div>

        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setOutputMode('clone')}
            className={`w-full text-left p-3 rounded-lg border transition-all duration-300 relative overflow-hidden cursor-pointer ${
              outputMode === 'clone'
                ? 'glass-card border-[#c9a84c]/20 shadow-[0_0_15px_rgba(201,168,76,0.04),inset_0_1px_0_0_rgba(255,255,255,0.04)]'
                : 'bg-white/[0.01] border-white/[0.04] hover:border-white/[0.08] hover:bg-white/[0.02]'
            }`}
          >
            {outputMode === 'clone' && (
              <div className="absolute top-0 left-0 w-[2px] h-full bg-gradient-to-b from-[#c9a84c] to-[#e8d5a3] shadow-[0_0_8px_rgba(201,168,76,0.6)]" />
            )}
            <div className="flex items-center gap-3 mb-1">
              <div className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors ${
                outputMode === 'clone' ? 'border-[#c9a84c] bg-[#c9a84c]/10' : 'border-zinc-700 bg-black/20'
              }`}>
                {outputMode === 'clone' && (
                  <div className="w-1.5 h-1.5 rounded-sm bg-[#d4b55a] shadow-[0_0_4px_rgba(201,168,76,0.8)]" />
                )}
              </div>
              <span className={`text-sm font-medium tracking-wide ${outputMode === 'clone' ? 'text-[#e8d5a3]' : 'text-zinc-300'}`}>
                1:1 Script Clone
              </span>
            </div>
            <p className="text-xs text-zinc-500 pl-[26px]">Keeps structure word-for-word, swaps product & avatar</p>
          </button>

          <button
            type="button"
            onClick={() => setOutputMode('iterate')}
            className={`w-full text-left p-3 rounded-lg border transition-all duration-300 relative overflow-hidden cursor-pointer ${
              outputMode === 'iterate'
                ? 'glass-card border-sky-500/30 shadow-[0_0_15px_rgba(14,165,233,0.06),inset_0_1px_0_0_rgba(255,255,255,0.04)]'
                : 'bg-white/[0.01] border-white/[0.04] hover:border-white/[0.08] hover:bg-white/[0.02]'
            }`}
            title="For META references — iterate OUR own winning script (no product swap)"
          >
            {outputMode === 'iterate' && (
              <div className="absolute top-0 left-0 w-[2px] h-full bg-gradient-to-b from-sky-400 to-sky-300 shadow-[0_0_8px_rgba(14,165,233,0.6)]" />
            )}
            <div className="flex items-center gap-3 mb-1">
              <div className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors ${
                outputMode === 'iterate' ? 'border-sky-400 bg-sky-500/15' : 'border-zinc-700 bg-black/20'
              }`}>
                {outputMode === 'iterate' && (
                  <div className="w-1.5 h-1.5 rounded-sm bg-sky-300 shadow-[0_0_4px_rgba(14,165,233,0.8)]" />
                )}
              </div>
              <span className={`text-sm font-medium tracking-wide ${outputMode === 'iterate' ? 'text-sky-200' : 'text-zinc-300'}`}>
                Iterate Our Winner
              </span>
            </div>
            <p className="text-xs text-zinc-500 pl-[26px]">Fresh hook + body variants of OUR winning script — no product swap</p>
          </button>
        </div>

        {outputMode === 'iterate' && (
          <div className="flex items-center gap-3 pt-2">
            <span className="text-xs text-zinc-500 font-mono">ITERATIONS:</span>
            <div className="flex gap-1.5">
              {[2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setVariantCount(n)}
                  className={`w-8 h-8 rounded-md flex items-center justify-center text-xs font-mono font-medium transition-all duration-300 cursor-pointer ${
                    variantCount === n
                      ? 'bg-sky-500/15 text-sky-200 border border-sky-500/40 shadow-[0_0_8px_rgba(14,165,233,0.12)]'
                      : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04] border border-transparent'
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Iteration vectors — only visible in Iterate mode */}
      {outputMode === 'iterate' && (() => {
        const formats = (productContext?.product?.formats?.length ? productContext.product.formats.map(f => f.name || f) : DEFAULT_FORMATS);
        const avatars = (productContext?.product?.avatars?.length ? productContext.product.avatars.map(a => a.name || a) : DEFAULT_AVATARS);
        const selectedCount = Object.values(iterationVectors).filter(v => v.enabled).length;
        const toggleVector = (key) => setIterationVectors(prev => ({ ...prev, [key]: { ...prev[key], enabled: !prev[key].enabled } }));
        const setTarget = (key, target) => setIterationVectors(prev => ({ ...prev, [key]: { ...prev[key], target } }));
        const targetOptions = {
          format:    ['Auto (rotate)', ...formats],
          avatar:    ['Auto (rotate)', ...avatars],
          length:    LENGTH_TARGETS,
          proofLead: PROOF_TARGETS,
        };
        return (
          <div className="space-y-3">
            <div className="text-[10px] font-mono font-semibold text-zinc-500 uppercase tracking-[0.15em] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-1 h-1 bg-sky-400/50 rounded-full" />
                Iterate by
              </div>
              <span className={`text-[10px] font-mono ${selectedCount === 0 ? 'text-red-400' : selectedCount >= 4 ? 'text-amber-400' : 'text-zinc-600'}`}>
                {selectedCount === 0 ? 'PICK AT LEAST ONE' : `${selectedCount} selected`}
              </span>
            </div>
            <div className="space-y-1.5">
              {ITERATION_VECTORS.map(v => {
                const state = iterationVectors[v.key];
                const showTarget = state.enabled && targetOptions[v.key];
                return (
                  <div key={v.key}>
                    <button
                      type="button"
                      onClick={() => toggleVector(v.key)}
                      className={`w-full flex items-start gap-3 p-2.5 rounded-md border transition-all cursor-pointer text-left ${
                        state.enabled
                          ? 'bg-sky-500/[0.04] border-sky-500/30'
                          : 'bg-white/[0.01] border-white/[0.04] hover:border-white/[0.08]'
                      }`}
                    >
                      <div className={`mt-0.5 w-3.5 h-3.5 rounded-sm border flex items-center justify-center shrink-0 transition-colors ${
                        state.enabled ? 'border-sky-400 bg-sky-500/15' : 'border-zinc-700'
                      }`}>
                        {state.enabled && <div className="w-1.5 h-1.5 rounded-sm bg-sky-300" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className={`text-xs font-medium ${state.enabled ? 'text-sky-200' : 'text-zinc-300'}`}>
                          {v.label}
                        </div>
                        <div className="text-[10px] text-zinc-500 leading-snug mt-0.5">
                          {v.description}
                        </div>
                      </div>
                    </button>
                    {showTarget && (
                      <div className="pl-[26px] pt-1.5">
                        <select
                          value={state.target || ''}
                          onChange={(e) => setTarget(v.key, e.target.value)}
                          className="w-full bg-[#0a0a0a] border border-sky-500/20 rounded-md px-2 py-1 text-[11px] font-mono text-zinc-300 focus:outline-none focus:border-sky-500/40 cursor-pointer appearance-none"
                          style={{
                            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%2338bdf8' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E")`,
                            backgroundRepeat: 'no-repeat',
                            backgroundPosition: 'right 0.5rem center',
                            paddingRight: '1.5rem',
                          }}
                        >
                          {targetOptions[v.key].map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {selectedCount >= 4 && (
              <div className="text-[10px] font-mono text-amber-300/80 bg-amber-500/10 border border-amber-500/25 rounded px-2.5 py-1.5 leading-snug">
                ⚠ {selectedCount} vectors selected — closer to a new ad than an iteration. The more levers you pull at once, the harder it is to attribute lift to any one of them.
              </div>
            )}
          </div>
        );
      })()}

      {/* Error */}
      {error && (
        <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-2.5 py-1.5 font-mono">
          {error}
        </div>
      )}

      {/* Model selector */}
      <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-[#0a0a0a] border border-slate-700/30">
        <span className="text-xs font-mono text-slate-400">MODEL</span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setSelectedModel('claude')}
            className="px-3 py-1.5 rounded text-xs font-mono font-semibold transition-all"
            style={{
              background: selectedModel === 'claude' ? '#c9a84c' : 'transparent',
              color: selectedModel === 'claude' ? '#111113' : '#a1a1a1',
              border: selectedModel === 'claude' ? 'none' : '1px solid rgba(161,161,161,0.3)',
            }}
          >
            CLAUDE
          </button>
          <button
            type="button"
            onClick={() => setSelectedModel('openai')}
            className="px-3 py-1.5 rounded text-xs font-mono font-semibold transition-all"
            style={{
              background: selectedModel === 'openai' ? '#10a37f' : 'transparent',
              color: selectedModel === 'openai' ? '#ffffff' : '#a1a1a1',
              border: selectedModel === 'openai' ? 'none' : '1px solid rgba(161,161,161,0.3)',
            }}
          >
            OPENAI
          </button>
        </div>
      </div>

      {/* Generate button */}
      <button
        type="button"
        onClick={handleGenerate}
        disabled={!canGenerate}
        className="w-full flex items-center justify-center gap-2 py-3 rounded-lg text-sm font-mono font-semibold tracking-wide uppercase transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        style={{
          background: generating ? '#1a1710' : 'linear-gradient(135deg, #c9a84c, #d4b55a)',
          color: generating ? '#c9a84c' : '#111113',
          border: generating ? '1px solid rgba(201,168,76,0.2)' : 'none',
          boxShadow: generating ? 'none' : '0 0 20px rgba(201,168,76,0.25), 0 1px 3px rgba(0,0,0,0.4), inset 0 1px 0 0 rgba(255,255,255,0.2)',
        }}
      >
        {generating ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-xs">{generatingStep || 'Generating...'}</span>
          </>
        ) : (
          <>
            <Sparkles className="w-4 h-4" />
            Generate {outputMode === 'iterate' ? `${variantCount} Iterations` : 'Clone'}
          </>
        )}
      </button>
    </div>
  );
});

export default ScriptGeneratorPanel;
