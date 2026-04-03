import { useState } from 'react';
import { ImageIcon, Sparkles, Download, RefreshCw, Maximize2, Copy } from 'lucide-react';

const MODELS = [
  { value: 'flux-pro', label: 'Flux Pro', description: 'Highest quality' },
  { value: 'flux-schnell', label: 'Flux Schnell', description: 'Fast generation' },
  { value: 'sdxl', label: 'SDXL', description: 'Stable Diffusion XL' },
  { value: 'dall-e-3', label: 'DALL-E 3', description: 'OpenAI' },
];

const ASPECT_RATIOS = [
  { value: '1:1', label: '1:1', desc: 'Square' },
  { value: '16:9', label: '16:9', desc: 'Landscape' },
  { value: '9:16', label: '9:16', desc: 'Portrait' },
  { value: '4:3', label: '4:3', desc: 'Standard' },
  { value: '3:4', label: '3:4', desc: 'Tall' },
  { value: '21:9', label: '21:9', desc: 'Ultrawide' },
];

const STYLES = ['Photorealistic', 'Digital Art', 'Oil Painting', 'Watercolor', 'Anime', '3D Render', 'Sketch', 'Cinematic'];

export default function Images() {
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [model, setModel] = useState('flux-pro');
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [style, setStyle] = useState('Photorealistic');
  const [count, setCount] = useState(2);
  const [generating, setGenerating] = useState(false);
  const [images, setImages] = useState([]);

  const canGenerate = prompt.trim().length > 0;

  const handleGenerate = async () => {
    if (!canGenerate) return;
    setGenerating(true);
    setImages([]);
    await new Promise((r) => setTimeout(r, 2500));

    // Generate placeholder images with colored gradients
    const colors = [
      ['#6366f1', '#a855f7'], ['#ec4899', '#f43f5e'], ['#14b8a6', '#06b6d4'],
      ['#f59e0b', '#ef4444'], ['#8b5cf6', '#3b82f6'], ['#10b981', '#34d399'],
    ];
    setImages(
      Array.from({ length: count }, (_, i) => ({
        id: i + 1,
        prompt,
        model,
        aspectRatio,
        style,
        gradient: colors[i % colors.length],
      }))
    );
    setGenerating(false);
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 rounded-lg bg-cyan-500/20"><ImageIcon className="w-5 h-5 text-cyan-400" /></div>
        <div>
          <h1 className="text-2xl font-bold text-white">AI Image Generator</h1>
          <p className="text-sm text-slate-400">Create stunning visuals with AI</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Controls */}
        <div className="lg:col-span-1 space-y-4">
          <div className="bg-[#111] border border-white/[0.06] rounded-lg p-5 space-y-4">
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Prompt</label>
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)}
                placeholder="Describe the image you want to create..."
                rows={4} className="w-full bg-black/30 border border-white/[0.06] rounded-lg p-2.5 text-sm text-white placeholder-slate-500 resize-none focus:outline-none focus:border-cyan-500/50" />
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Negative Prompt (optional)</label>
              <input type="text" value={negativePrompt} onChange={(e) => setNegativePrompt(e.target.value)}
                placeholder="What to avoid..." className="w-full bg-black/30 border border-white/[0.06] rounded-lg p-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500/50" />
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1.5 block">Model</label>
              <div className="grid grid-cols-2 gap-2">
                {MODELS.map((m) => (
                  <button key={m.value} onClick={() => setModel(m.value)}
                    className={`text-left p-2.5 rounded-lg border text-xs transition-colors cursor-pointer ${model === m.value ? 'bg-cyan-600/20 border-cyan-500/40 text-white' : 'border-white/[0.06] text-slate-400 hover:text-white hover:border-white/[0.12]'}`}>
                    <div className="font-medium">{m.label}</div>
                    <div className="text-slate-500 mt-0.5">{m.description}</div>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1.5 block">Aspect Ratio</label>
              <div className="grid grid-cols-3 gap-2">
                {ASPECT_RATIOS.map((ar) => (
                  <button key={ar.value} onClick={() => setAspectRatio(ar.value)}
                    className={`py-2 rounded-lg border text-xs font-medium transition-colors cursor-pointer ${aspectRatio === ar.value ? 'bg-cyan-600 border-cyan-500 text-white' : 'border-white/[0.06] text-slate-400 hover:text-white'}`}>
                    {ar.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1.5 block">Style</label>
              <div className="flex flex-wrap gap-1.5">
                {STYLES.map((s) => (
                  <button key={s} onClick={() => setStyle(s)}
                    className={`px-2.5 py-1 text-xs rounded-full border transition-colors cursor-pointer ${style === s ? 'bg-cyan-600 border-cyan-500 text-white' : 'border-white/[0.06] text-slate-400 hover:text-white'}`}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1.5 block">Number of Images</label>
              <div className="flex gap-2">
                {[1, 2, 3, 4].map((n) => (
                  <button key={n} onClick={() => setCount(n)}
                    className={`flex-1 py-2 rounded-lg border text-sm font-medium transition-colors cursor-pointer ${count === n ? 'bg-cyan-600 border-cyan-500 text-white' : 'border-white/[0.06] text-slate-400 hover:text-white'}`}>
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <button onClick={handleGenerate} disabled={!canGenerate || generating}
              className={`w-full py-3 rounded-lg font-semibold text-sm flex items-center justify-center gap-2 transition-all cursor-pointer ${canGenerate && !generating ? 'bg-gradient-to-r bg-accent text-bg-main hover:bg-accent-hover shadow-lg shadow-accent/25' : 'bg-slate-800 text-slate-500 cursor-not-allowed'}`}>
              {generating ? <><RefreshCw className="w-4 h-4 animate-spin" /> Generating...</> : <><Sparkles className="w-4 h-4" /> Generate Images</>}
            </button>
          </div>
        </div>

        {/* Output */}
        <div className="lg:col-span-2">
          {images.length === 0 && !generating ? (
            <div className="flex flex-col items-center justify-center h-80 bg-[#111] border border-white/[0.06] rounded-lg">
              <ImageIcon className="w-16 h-16 text-slate-700 mb-3" />
              <p className="text-slate-500 text-sm">Enter a prompt and generate your images</p>
            </div>
          ) : generating ? (
            <div className="flex flex-col items-center justify-center h-80 bg-[#111] border border-white/[0.06] rounded-lg">
              <RefreshCw className="w-8 h-8 text-cyan-400 animate-spin mb-3" />
              <p className="text-slate-400 text-sm">Generating {count} image{count > 1 ? 's' : ''} with {MODELS.find((m) => m.value === model)?.label}...</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {images.map((img) => (
                <div key={img.id} className="bg-[#111] border border-white/[0.06] rounded-lg overflow-hidden group">
                  {/* Placeholder gradient */}
                  <div className="relative aspect-square" style={{ background: `linear-gradient(135deg, ${img.gradient[0]}, ${img.gradient[1]})` }}>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="text-center">
                        <ImageIcon className="w-12 h-12 text-white/30 mx-auto mb-2" />
                        <p className="text-white/40 text-xs px-4">AI-generated image placeholder</p>
                      </div>
                    </div>
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
                      <div className="flex gap-2">
                        <button className="p-2 bg-white/20 rounded-lg text-white hover:bg-white/30 backdrop-blur-sm cursor-pointer"><Maximize2 className="w-4 h-4" /></button>
                        <button className="p-2 bg-white/20 rounded-lg text-white hover:bg-white/30 backdrop-blur-sm cursor-pointer"><Download className="w-4 h-4" /></button>
                        <button onClick={() => navigator.clipboard.writeText(img.prompt)} className="p-2 bg-white/20 rounded-lg text-white hover:bg-white/30 backdrop-blur-sm cursor-pointer"><Copy className="w-4 h-4" /></button>
                      </div>
                    </div>
                  </div>
                  <div className="p-3">
                    <p className="text-xs text-slate-400 truncate">{img.prompt}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-slate-600">{img.style}</span>
                      <span className="text-xs text-slate-600">-</span>
                      <span className="text-xs text-slate-600">{img.aspectRatio}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
