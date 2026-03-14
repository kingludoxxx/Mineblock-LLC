import { useState } from 'react';
import { Video, Sparkles, RefreshCw, Download, Play, Clock, Film, MonitorPlay } from 'lucide-react';

const VIDEO_TYPES = [
  { value: 'text-to-video', label: 'Text to Video', icon: Film, description: 'Generate video from a text prompt' },
  { value: 'image-to-video', label: 'Image to Video', icon: MonitorPlay, description: 'Animate a still image' },
];

const DURATIONS = ['5s', '10s', '15s', '30s'];
const RESOLUTIONS = ['720p', '1080p', '4K'];

export default function VideoStudio() {
  const [videoType, setVideoType] = useState('text-to-video');
  const [prompt, setPrompt] = useState('');
  const [duration, setDuration] = useState('10s');
  const [resolution, setResolution] = useState('1080p');
  const [generating, setGenerating] = useState(false);
  const [videos, setVideos] = useState([]);

  const canGenerate = prompt.trim().length > 0;

  const handleGenerate = async () => {
    if (!canGenerate) return;
    setGenerating(true);
    await new Promise((r) => setTimeout(r, 3000));
    setVideos([
      ...videos,
      {
        id: Date.now(),
        prompt,
        duration,
        resolution,
        type: videoType,
        createdAt: new Date().toLocaleTimeString(),
      },
    ]);
    setGenerating(false);
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 rounded-lg bg-violet-500/20"><Video className="w-5 h-5 text-violet-400" /></div>
        <div>
          <h1 className="text-2xl font-bold text-white">Video Studio</h1>
          <p className="text-sm text-slate-400">AI-powered video generation</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Controls */}
        <div className="lg:col-span-1">
          <div className="bg-[#111] border border-white/[0.06] rounded-lg p-5 space-y-4">
            <div>
              <label className="text-xs text-slate-400 mb-1.5 block">Video Type</label>
              <div className="space-y-2">
                {VIDEO_TYPES.map((vt) => (
                  <button key={vt.value} onClick={() => setVideoType(vt.value)}
                    className={`w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-colors cursor-pointer ${videoType === vt.value ? 'bg-violet-600/20 border-violet-500/40 text-white' : 'border-white/[0.06] text-slate-400 hover:text-white hover:border-white/[0.12]'}`}>
                    <vt.icon className="w-5 h-5 shrink-0" />
                    <div>
                      <div className="text-sm font-medium">{vt.label}</div>
                      <div className="text-xs text-slate-500">{vt.description}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Prompt</label>
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)}
                placeholder="Describe the video scene you want to create..."
                rows={4} className="w-full bg-black/30 border border-white/[0.06] rounded-lg p-2.5 text-sm text-white placeholder-slate-500 resize-none focus:outline-none focus:border-violet-500/50" />
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1.5 block">Duration</label>
              <div className="flex gap-2">
                {DURATIONS.map((d) => (
                  <button key={d} onClick={() => setDuration(d)}
                    className={`flex-1 py-2 rounded-lg border text-xs font-medium transition-colors cursor-pointer ${duration === d ? 'bg-violet-600 border-violet-500 text-white' : 'border-white/[0.06] text-slate-400 hover:text-white'}`}>
                    {d}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1.5 block">Resolution</label>
              <div className="flex gap-2">
                {RESOLUTIONS.map((r) => (
                  <button key={r} onClick={() => setResolution(r)}
                    className={`flex-1 py-2 rounded-lg border text-xs font-medium transition-colors cursor-pointer ${resolution === r ? 'bg-violet-600 border-violet-500 text-white' : 'border-white/[0.06] text-slate-400 hover:text-white'}`}>
                    {r}
                  </button>
                ))}
              </div>
            </div>
            <button onClick={handleGenerate} disabled={!canGenerate || generating}
              className={`w-full py-3 rounded-lg font-semibold text-sm flex items-center justify-center gap-2 transition-all cursor-pointer ${canGenerate && !generating ? 'bg-gradient-to-r from-violet-600 to-purple-600 text-white hover:from-violet-500 hover:to-purple-500 shadow-lg shadow-violet-500/25' : 'bg-slate-800 text-slate-500 cursor-not-allowed'}`}>
              {generating ? <><RefreshCw className="w-4 h-4 animate-spin" /> Generating Video...</> : <><Sparkles className="w-4 h-4" /> Generate Video</>}
            </button>
          </div>
        </div>

        {/* Output */}
        <div className="lg:col-span-2">
          {videos.length === 0 && !generating ? (
            <div className="flex flex-col items-center justify-center h-80 bg-[#111] border border-white/[0.06] rounded-lg">
              <Video className="w-16 h-16 text-slate-700 mb-3" />
              <p className="text-slate-500 text-sm mb-1">No videos generated yet</p>
              <p className="text-slate-600 text-xs">Describe a scene and click Generate</p>
            </div>
          ) : (
            <div className="space-y-4">
              {generating && (
                <div className="flex flex-col items-center justify-center h-48 bg-[#111] border border-white/[0.06] rounded-lg border-dashed border-violet-500/30">
                  <RefreshCw className="w-8 h-8 text-violet-400 animate-spin mb-3" />
                  <p className="text-slate-400 text-sm">Generating {duration} video at {resolution}...</p>
                  <p className="text-slate-600 text-xs mt-1">This may take a moment</p>
                </div>
              )}
              {[...videos].reverse().map((video) => (
                <div key={video.id} className="bg-[#111] border border-white/[0.06] rounded-lg overflow-hidden">
                  {/* Video placeholder */}
                  <div className="relative aspect-video bg-gradient-to-br from-violet-900/40 to-purple-900/40 flex items-center justify-center">
                    <div className="absolute inset-0 flex items-center justify-center">
                      <button className="w-16 h-16 rounded-full bg-white/10 backdrop-blur-sm flex items-center justify-center hover:bg-white/20 transition-colors cursor-pointer">
                        <Play className="w-7 h-7 text-white ml-1" />
                      </button>
                    </div>
                    <div className="absolute bottom-3 right-3 flex items-center gap-1 px-2 py-1 bg-black/50 rounded text-xs text-white backdrop-blur-sm">
                      <Clock className="w-3 h-3" /> {video.duration}
                    </div>
                  </div>
                  <div className="p-4 flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white truncate">{video.prompt}</p>
                      <div className="flex items-center gap-3 mt-1 text-xs text-slate-500">
                        <span>{video.type === 'text-to-video' ? 'Text to Video' : 'Image to Video'}</span>
                        <span>{video.resolution}</span>
                        <span>{video.createdAt}</span>
                      </div>
                    </div>
                    <button className="p-2 text-slate-400 hover:text-white rounded-md hover:bg-white/[0.06] cursor-pointer">
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
