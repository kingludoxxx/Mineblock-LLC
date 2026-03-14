import { useState } from 'react';
import {
  Play,
  RotateCcw,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  Search,
} from 'lucide-react';

const initialJobs = [
  { id: 'SCR-001', platform: 'Meta Ads', query: 'summer sale fashion', status: 'Completed', adsFound: 342, duration: '2m 14s', started: '2026-03-13T10:20:00Z' },
  { id: 'SCR-002', platform: 'Google Ads', query: 'buy sneakers online', status: 'Running', adsFound: 128, duration: '1m 02s', started: '2026-03-13T10:35:00Z' },
  { id: 'SCR-003', platform: 'TikTok Ads', query: 'skincare routine', status: 'Completed', adsFound: 567, duration: '3m 48s', started: '2026-03-13T09:50:00Z' },
  { id: 'SCR-004', platform: 'Meta Ads', query: 'home decor minimalist', status: 'Failed', adsFound: 0, duration: '0m 32s', started: '2026-03-13T09:30:00Z' },
  { id: 'SCR-005', platform: 'Google Ads', query: 'protein powder supplement', status: 'Queued', adsFound: 0, duration: '--', started: '2026-03-13T10:42:00Z' },
  { id: 'SCR-006', platform: 'TikTok Ads', query: 'wireless earbuds 2026', status: 'Completed', adsFound: 234, duration: '1m 55s', started: '2026-03-13T08:15:00Z' },
  { id: 'SCR-007', platform: 'Meta Ads', query: 'yoga mat premium', status: 'Failed', adsFound: 0, duration: '0m 12s', started: '2026-03-13T08:00:00Z' },
  { id: 'SCR-008', platform: 'Google Ads', query: 'standing desk ergonomic', status: 'Completed', adsFound: 189, duration: '2m 30s', started: '2026-03-13T07:45:00Z' },
];

const statusConfig = {
  Queued: { color: 'bg-slate-600/20 text-slate-400 border-slate-600/30', icon: Clock },
  Running: { color: 'bg-blue-600/20 text-blue-400 border-blue-600/30', icon: Loader2 },
  Completed: { color: 'bg-emerald-600/20 text-emerald-400 border-emerald-600/30', icon: CheckCircle2 },
  Failed: { color: 'bg-red-600/20 text-red-400 border-red-600/30', icon: XCircle },
};

export default function ScrapeRuns() {
  const [jobs, setJobs] = useState(initialJobs);
  const [showNew, setShowNew] = useState(false);
  const [newPlatform, setNewPlatform] = useState('Meta Ads');
  const [newQuery, setNewQuery] = useState('');

  const failedJobs = jobs.filter((j) => j.status === 'Failed');

  const handleNewRun = () => {
    if (!newQuery.trim()) return;
    const job = {
      id: `SCR-${String(jobs.length + 1).padStart(3, '0')}`,
      platform: newPlatform,
      query: newQuery,
      status: 'Queued',
      adsFound: 0,
      duration: '--',
      started: new Date().toISOString(),
    };
    setJobs([job, ...jobs]);
    setNewQuery('');
    setShowNew(false);
  };

  const retryFailed = () => {
    setJobs(
      jobs.map((j) =>
        j.status === 'Failed' ? { ...j, status: 'Queued', adsFound: 0, duration: '--', started: new Date().toISOString() } : j
      )
    );
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-8 gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Scrape Runs</h1>
          <p className="text-slate-400 mt-1">Manage ad scraping jobs across platforms</p>
        </div>
        <div className="flex items-center gap-3">
          {failedJobs.length > 0 && (
            <button
              onClick={retryFailed}
              className="flex items-center gap-2 bg-red-600/20 border border-red-600/30 text-red-400 hover:bg-red-600/30 text-sm font-medium px-4 py-2 rounded-lg transition-colors cursor-pointer"
            >
              <RotateCcw className="w-4 h-4" />
              Retry Failed ({failedJobs.length})
            </button>
          )}
          <button
            onClick={() => setShowNew(!showNew)}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors cursor-pointer"
          >
            <Play className="w-4 h-4" />
            New Scrape Run
          </button>
        </div>
      </div>

      {/* New Scrape Run Form */}
      {showNew && (
        <div className="bg-[#111] border border-white/[0.06] rounded-xl p-5 mb-6">
          <h3 className="text-sm font-semibold text-white mb-4">New Scrape Run</h3>
          <div className="flex flex-col sm:flex-row gap-4">
            <select
              value={newPlatform}
              onChange={(e) => setNewPlatform(e.target.value)}
              className="bg-[#0a0a0a] border border-white/[0.06] rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none cursor-pointer"
            >
              <option>Meta Ads</option>
              <option>Google Ads</option>
              <option>TikTok Ads</option>
            </select>
            <div className="flex-1 flex items-center gap-2 bg-[#0a0a0a] border border-white/[0.06] rounded-lg px-4 py-2.5">
              <Search className="w-4 h-4 text-slate-500" />
              <input
                type="text"
                value={newQuery}
                onChange={(e) => setNewQuery(e.target.value)}
                placeholder="Enter search query..."
                className="bg-transparent text-white text-sm w-full focus:outline-none"
                onKeyDown={(e) => e.key === 'Enter' && handleNewRun()}
              />
            </div>
            <button
              onClick={handleNewRun}
              className="bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium px-6 py-2.5 rounded-lg transition-colors cursor-pointer"
            >
              Start
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="bg-[#111] border border-white/[0.06] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-white/[0.06]">
                {['Job ID', 'Platform', 'Query', 'Status', 'Ads Found', 'Duration', 'Started'].map((h) => (
                  <th key={h} className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => {
                const sc = statusConfig[j.status];
                const StatusIcon = sc.icon;
                return (
                  <tr key={j.id} className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors">
                    <td className="px-5 py-3 text-sm text-slate-400 font-mono">{j.id}</td>
                    <td className="px-5 py-3 text-sm text-white">{j.platform}</td>
                    <td className="px-5 py-3 text-sm text-slate-300 max-w-xs truncate">{j.query}</td>
                    <td className="px-5 py-3 text-sm">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border ${sc.color}`}>
                        <StatusIcon className={`w-3 h-3 ${j.status === 'Running' ? 'animate-spin' : ''}`} />
                        {j.status}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-sm text-slate-300">{j.adsFound > 0 ? j.adsFound.toLocaleString() : '--'}</td>
                    <td className="px-5 py-3 text-sm text-slate-400">{j.duration}</td>
                    <td className="px-5 py-3 text-sm text-slate-400">{new Date(j.started).toLocaleTimeString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
