import { useState } from 'react';
import { Megaphone, Sparkles, Copy, RefreshCw, Image, Video, Type } from 'lucide-react';

const AD_PLATFORMS = ['Facebook', 'Instagram', 'TikTok', 'YouTube', 'Google', 'LinkedIn'];
const AD_FORMATS = [
  { value: 'image', label: 'Image Ad', icon: Image },
  { value: 'video', label: 'Video Ad', icon: Video },
  { value: 'text', label: 'Text Ad', icon: Type },
];

export default function MagicAds() {
  const [platform, setPlatform] = useState('Facebook');
  const [format, setFormat] = useState('image');
  const [productName, setProductName] = useState('');
  const [targetAudience, setTargetAudience] = useState('');
  const [hook, setHook] = useState('');
  const [tone, setTone] = useState('conversational');
  const [results, setResults] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState(null);

  const canGenerate = productName.trim() && targetAudience.trim();

  const handleGenerate = async () => {
    if (!canGenerate) return;
    setGenerating(true);
    setResults([]);
    await new Promise((r) => setTimeout(r, 2000));
    setResults([
      {
        id: 1,
        headline: `Stop Scrolling. ${productName} Changes Everything.`,
        primaryText: `Tired of [problem]? ${productName} was built for ${targetAudience} who demand real results. No fluff. No BS. Just a proven system that works.\n\nJoin 10,000+ who already made the switch.`,
        cta: 'Shop Now',
        description: `The #1 solution for ${targetAudience.toLowerCase()}.`,
      },
      {
        id: 2,
        headline: `Why ${targetAudience.split(' ')[0]} Are Switching to ${productName}`,
        primaryText: `We asked 500 ${targetAudience.toLowerCase()} what they really wanted. Then we built ${productName} to deliver exactly that.\n\nThe results? See for yourself.`,
        cta: 'Learn More',
        description: `Backed by science. Loved by ${targetAudience.toLowerCase()}.`,
      },
      {
        id: 3,
        headline: `${productName}: The Last [Product] You'll Ever Need`,
        primaryText: `${hook || 'What if there was a better way?'}\n\nThat's exactly what ${productName} delivers. Designed from the ground up for ${targetAudience.toLowerCase()}, with zero compromises.`,
        cta: 'Get Started',
        description: 'Limited time offer. Free shipping included.',
      },
    ]);
    setGenerating(false);
  };

  const handleCopy = (text, index) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 rounded-lg bg-pink-500/20"><Megaphone className="w-5 h-5 text-pink-400" /></div>
        <div>
          <h1 className="text-2xl font-bold text-white">Magic Ads</h1>
          <p className="text-sm text-slate-400">AI-powered ad creative generation</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Input panel */}
        <div className="lg:col-span-1 space-y-4">
          <div className="bg-[#111] border border-white/[0.06] rounded-lg p-5 space-y-4">
            <div>
              <label className="text-xs text-slate-400 mb-1.5 block">Platform</label>
              <div className="flex flex-wrap gap-2">
                {AD_PLATFORMS.map((p) => (
                  <button key={p} onClick={() => setPlatform(p)}
                    className={`px-3 py-1.5 text-xs rounded-lg border transition-colors cursor-pointer ${platform === p ? 'bg-pink-600 border-pink-500 text-white' : 'bg-transparent border-white/[0.06] text-slate-400 hover:text-white hover:border-white/[0.12]'}`}>
                    {p}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1.5 block">Ad Format</label>
              <div className="flex gap-2">
                {AD_FORMATS.map((f) => (
                  <button key={f.value} onClick={() => setFormat(f.value)}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs rounded-lg border transition-colors cursor-pointer ${format === f.value ? 'bg-pink-600 border-pink-500 text-white' : 'bg-transparent border-white/[0.06] text-slate-400 hover:text-white'}`}>
                    <f.icon className="w-3.5 h-3.5" /> {f.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Product Name</label>
              <input type="text" value={productName} onChange={(e) => setProductName(e.target.value)}
                placeholder="e.g. FitPro Max" className="w-full bg-black/30 border border-white/[0.06] rounded-lg p-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-pink-500/50" />
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Target Audience</label>
              <input type="text" value={targetAudience} onChange={(e) => setTargetAudience(e.target.value)}
                placeholder="e.g. Women 25-40 into fitness" className="w-full bg-black/30 border border-white/[0.06] rounded-lg p-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-pink-500/50" />
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Hook / Angle (optional)</label>
              <input type="text" value={hook} onChange={(e) => setHook(e.target.value)}
                placeholder="e.g. What if you never had to diet again?" className="w-full bg-black/30 border border-white/[0.06] rounded-lg p-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-pink-500/50" />
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Tone</label>
              <select value={tone} onChange={(e) => setTone(e.target.value)}
                className="w-full bg-black/30 border border-white/[0.06] rounded-lg p-2.5 text-sm text-white focus:outline-none focus:border-pink-500/50 cursor-pointer">
                <option value="conversational">Conversational</option>
                <option value="professional">Professional</option>
                <option value="urgent">Urgent / Scarcity</option>
                <option value="storytelling">Storytelling</option>
                <option value="humorous">Humorous</option>
              </select>
            </div>
            <button onClick={handleGenerate} disabled={!canGenerate || generating}
              className={`w-full py-3 rounded-lg font-semibold text-sm flex items-center justify-center gap-2 transition-all cursor-pointer ${canGenerate && !generating ? 'bg-gradient-to-r from-pink-600 to-rose-600 text-white hover:from-pink-500 hover:to-rose-500 shadow-lg shadow-pink-500/25' : 'bg-slate-800 text-slate-500 cursor-not-allowed'}`}>
              {generating ? <><RefreshCw className="w-4 h-4 animate-spin" /> Generating...</> : <><Sparkles className="w-4 h-4" /> Generate Ads</>}
            </button>
          </div>
        </div>

        {/* Results */}
        <div className="lg:col-span-2 space-y-4">
          {results.length === 0 && !generating ? (
            <div className="flex flex-col items-center justify-center h-64 bg-[#111] border border-white/[0.06] rounded-lg">
              <Megaphone className="w-12 h-12 text-slate-700 mb-3" />
              <p className="text-slate-500 text-sm">Configure your ad parameters and hit Generate</p>
            </div>
          ) : generating ? (
            <div className="flex flex-col items-center justify-center h-64 bg-[#111] border border-white/[0.06] rounded-lg">
              <RefreshCw className="w-8 h-8 text-pink-400 animate-spin mb-3" />
              <p className="text-slate-400 text-sm">Generating {platform} {format} ads...</p>
            </div>
          ) : (
            results.map((ad, i) => (
              <div key={ad.id} className="bg-[#111] border border-white/[0.06] rounded-lg p-5">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs text-slate-500">Ad Variant {i + 1} - {platform} {AD_FORMATS.find((f) => f.value === format)?.label}</span>
                  <button onClick={() => handleCopy(`${ad.headline}\n\n${ad.primaryText}\n\n${ad.cta}\n${ad.description}`, i)}
                    className="flex items-center gap-1 text-xs text-slate-400 hover:text-white cursor-pointer">
                    <Copy className="w-3.5 h-3.5" /> {copiedIndex === i ? 'Copied!' : 'Copy All'}
                  </button>
                </div>
                <h3 className="text-lg font-bold text-white mb-2">{ad.headline}</h3>
                <p className="text-sm text-slate-300 whitespace-pre-line mb-3">{ad.primaryText}</p>
                <div className="flex items-center gap-3 pt-3 border-t border-white/[0.06]">
                  <span className="px-3 py-1 bg-pink-600 text-white text-xs font-medium rounded">{ad.cta}</span>
                  <span className="text-xs text-slate-500">{ad.description}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
