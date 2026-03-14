import { useState } from 'react';
import { Mic, Sparkles, RefreshCw, Download, Play, Pause, Volume2, Clock } from 'lucide-react';

const VOICES = [
  { id: 'alloy', name: 'Alloy', description: 'Neutral and balanced', gender: 'Neutral' },
  { id: 'echo', name: 'Echo', description: 'Warm and confident', gender: 'Male' },
  { id: 'fable', name: 'Fable', description: 'Expressive storyteller', gender: 'Male' },
  { id: 'onyx', name: 'Onyx', description: 'Deep and authoritative', gender: 'Male' },
  { id: 'nova', name: 'Nova', description: 'Energetic and bright', gender: 'Female' },
  { id: 'shimmer', name: 'Shimmer', description: 'Soft and pleasant', gender: 'Female' },
];

const SPEEDS = [
  { value: 0.75, label: '0.75x' },
  { value: 1, label: '1x' },
  { value: 1.25, label: '1.25x' },
  { value: 1.5, label: '1.5x' },
];

export default function Audio() {
  const [text, setText] = useState('');
  const [voice, setVoice] = useState('alloy');
  const [speed, setSpeed] = useState(1);
  const [generating, setGenerating] = useState(false);
  const [clips, setClips] = useState([]);
  const [playingId, setPlayingId] = useState(null);

  const canGenerate = text.trim().length > 0;
  const charCount = text.length;
  const estDuration = Math.ceil((charCount / 150) * (1 / speed) * 60);

  const handleGenerate = async () => {
    if (!canGenerate) return;
    setGenerating(true);
    await new Promise((r) => setTimeout(r, 2000));
    const selectedVoice = VOICES.find((v) => v.id === voice);
    setClips([
      ...clips,
      {
        id: Date.now(),
        text: text.slice(0, 200) + (text.length > 200 ? '...' : ''),
        fullText: text,
        voice: selectedVoice?.name || voice,
        speed,
        duration: `${Math.floor(estDuration / 60)}:${String(estDuration % 60).padStart(2, '0')}`,
        createdAt: new Date().toLocaleTimeString(),
      },
    ]);
    setGenerating(false);
    setText('');
  };

  const togglePlay = (id) => {
    setPlayingId(playingId === id ? null : id);
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 rounded-lg bg-amber-500/20"><Mic className="w-5 h-5 text-amber-400" /></div>
        <div>
          <h1 className="text-2xl font-bold text-white">Text to Speech</h1>
          <p className="text-sm text-slate-400">Convert text to natural-sounding audio</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Controls */}
        <div className="lg:col-span-1">
          <div className="bg-[#111] border border-white/[0.06] rounded-lg p-5 space-y-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-slate-400">Text to Speak</label>
                <span className="text-xs text-slate-600">{charCount} chars</span>
              </div>
              <textarea value={text} onChange={(e) => setText(e.target.value)}
                placeholder="Enter the text you want to convert to speech..."
                rows={6} className="w-full bg-black/30 border border-white/[0.06] rounded-lg p-2.5 text-sm text-white placeholder-slate-500 resize-none focus:outline-none focus:border-amber-500/50" />
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1.5 block">Voice</label>
              <div className="grid grid-cols-2 gap-2">
                {VOICES.map((v) => (
                  <button key={v.id} onClick={() => setVoice(v.id)}
                    className={`text-left p-2.5 rounded-lg border text-xs transition-colors cursor-pointer ${voice === v.id ? 'bg-amber-600/20 border-amber-500/40 text-white' : 'border-white/[0.06] text-slate-400 hover:text-white hover:border-white/[0.12]'}`}>
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{v.name}</span>
                      <span className="text-slate-600">{v.gender}</span>
                    </div>
                    <div className="text-slate-500 mt-0.5">{v.description}</div>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1.5 block">Speed</label>
              <div className="flex gap-2">
                {SPEEDS.map((s) => (
                  <button key={s.value} onClick={() => setSpeed(s.value)}
                    className={`flex-1 py-2 rounded-lg border text-xs font-medium transition-colors cursor-pointer ${speed === s.value ? 'bg-amber-600 border-amber-500 text-white' : 'border-white/[0.06] text-slate-400 hover:text-white'}`}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
            {charCount > 0 && (
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <Clock className="w-3.5 h-3.5" />
                <span>Estimated duration: ~{Math.floor(estDuration / 60)}:{String(estDuration % 60).padStart(2, '0')}</span>
              </div>
            )}
            <button onClick={handleGenerate} disabled={!canGenerate || generating}
              className={`w-full py-3 rounded-lg font-semibold text-sm flex items-center justify-center gap-2 transition-all cursor-pointer ${canGenerate && !generating ? 'bg-gradient-to-r from-amber-600 to-orange-600 text-white hover:from-amber-500 hover:to-orange-500 shadow-lg shadow-amber-500/25' : 'bg-slate-800 text-slate-500 cursor-not-allowed'}`}>
              {generating ? <><RefreshCw className="w-4 h-4 animate-spin" /> Generating Audio...</> : <><Sparkles className="w-4 h-4" /> Generate Speech</>}
            </button>
          </div>
        </div>

        {/* Output */}
        <div className="lg:col-span-2">
          {clips.length === 0 && !generating ? (
            <div className="flex flex-col items-center justify-center h-64 bg-[#111] border border-white/[0.06] rounded-lg">
              <Volume2 className="w-16 h-16 text-slate-700 mb-3" />
              <p className="text-slate-500 text-sm mb-1">No audio clips yet</p>
              <p className="text-slate-600 text-xs">Enter text, choose a voice, and generate</p>
            </div>
          ) : (
            <div className="space-y-3">
              {generating && (
                <div className="flex items-center gap-4 p-4 bg-[#111] border border-white/[0.06] rounded-lg border-dashed border-amber-500/30">
                  <RefreshCw className="w-5 h-5 text-amber-400 animate-spin shrink-0" />
                  <div>
                    <p className="text-sm text-white">Generating audio...</p>
                    <p className="text-xs text-slate-500">Using {VOICES.find((v) => v.id === voice)?.name} voice at {speed}x speed</p>
                  </div>
                </div>
              )}
              {[...clips].reverse().map((clip) => (
                <div key={clip.id} className="bg-[#111] border border-white/[0.06] rounded-lg p-4">
                  <div className="flex items-start gap-4">
                    <button onClick={() => togglePlay(clip.id)}
                      className="w-10 h-10 rounded-full bg-amber-600/20 flex items-center justify-center shrink-0 hover:bg-amber-600/30 transition-colors cursor-pointer">
                      {playingId === clip.id ? <Pause className="w-4 h-4 text-amber-400" /> : <Play className="w-4 h-4 text-amber-400 ml-0.5" />}
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-slate-300 mb-2">{clip.text}</p>
                      {/* Waveform placeholder */}
                      <div className="flex items-end gap-0.5 h-8 mb-2">
                        {Array.from({ length: 50 }, (_, i) => (
                          <div key={i} className={`flex-1 rounded-full transition-colors ${playingId === clip.id && i < 20 ? 'bg-amber-500' : 'bg-white/[0.08]'}`}
                            style={{ height: `${Math.random() * 80 + 20}%` }} />
                        ))}
                      </div>
                      <div className="flex items-center gap-4 text-xs text-slate-500">
                        <span className="flex items-center gap-1"><Volume2 className="w-3 h-3" /> {clip.voice}</span>
                        <span>{clip.speed}x</span>
                        <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {clip.duration}</span>
                        <span>{clip.createdAt}</span>
                      </div>
                    </div>
                    <button className="p-2 text-slate-400 hover:text-white rounded-md hover:bg-white/[0.06] cursor-pointer shrink-0">
                      <Download className="w-4 h-4" />
                    </button>
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
