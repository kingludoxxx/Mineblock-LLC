import { useState } from 'react';
import {
  Share2,
  Search,
  Leaf,
  Mail,
  MousePointer,
  TrendingUp,
  Calendar,
  ArrowRight,
} from 'lucide-react';

const channels = [
  {
    name: 'Paid Social',
    icon: Share2,
    revenue: 128450,
    roas: 4.2,
    pct: 34,
    color: 'bg-accent',
  },
  {
    name: 'Paid Search',
    icon: Search,
    revenue: 96200,
    roas: 3.8,
    pct: 25,
    color: 'bg-purple-500',
  },
  {
    name: 'Organic',
    icon: Leaf,
    revenue: 72300,
    roas: null,
    pct: 19,
    color: 'bg-emerald-500',
  },
  {
    name: 'Email',
    icon: Mail,
    revenue: 54100,
    roas: 8.6,
    pct: 14,
    color: 'bg-yellow-500',
  },
  {
    name: 'Direct',
    icon: MousePointer,
    revenue: 30950,
    roas: null,
    pct: 8,
    color: 'bg-slate-400',
  },
];

const conversionPaths = [
  { path: ['Paid Social', 'Email', 'Direct'], conversions: 342, revenue: 28400 },
  { path: ['Paid Search', 'Direct'], conversions: 287, revenue: 22100 },
  { path: ['Organic', 'Email', 'Paid Social'], conversions: 198, revenue: 18750 },
  { path: ['Paid Social', 'Direct'], conversions: 176, revenue: 14200 },
  { path: ['Email', 'Direct'], conversions: 154, revenue: 11800 },
];

const fmt = (n) => '$' + n.toLocaleString();

export default function Attribution() {
  const [range, setRange] = useState('30d');
  const [compare, setCompare] = useState(true);

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-8 gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Multi-Touch Attribution</h1>
          <p className="text-slate-400 mt-1">Understand how channels contribute to revenue</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 bg-[#111] border border-white/[0.06] rounded-lg px-3 py-2">
            <Calendar className="w-4 h-4 text-slate-400" />
            <select
              value={range}
              onChange={(e) => setRange(e.target.value)}
              className="bg-transparent text-sm text-white focus:outline-none cursor-pointer"
            >
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="90d">Last 90 days</option>
            </select>
          </div>
          <button
            onClick={() => setCompare(!compare)}
            className={`text-sm px-3 py-2 rounded-lg border transition-colors cursor-pointer ${
              compare
                ? 'border-accent bg-accent-muted text-accent-text'
                : 'border-white/[0.06] bg-[#111] text-slate-400'
            }`}
          >
            Compare Period
          </button>
        </div>
      </div>

      {/* Channel Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
        {channels.map((ch) => {
          const Icon = ch.icon;
          return (
            <div
              key={ch.name}
              className="bg-[#111] border border-white/[0.06] rounded-xl p-5"
            >
              <div className="flex items-center gap-2 mb-4">
                <div className="p-2 bg-white/5 rounded-lg">
                  <Icon className="w-4 h-4 text-slate-300" />
                </div>
                <span className="text-sm font-medium text-slate-300">{ch.name}</span>
              </div>
              <p className="text-xl font-bold text-white mb-1">{fmt(ch.revenue)}</p>
              {compare && (
                <p className="text-xs text-slate-500 mb-1">vs prev: {fmt(Math.round(ch.revenue * 0.91))}</p>
              )}
              {ch.roas !== null && (
                <div className="flex items-center gap-1 text-emerald-400 text-sm mb-3">
                  <TrendingUp className="w-3 h-3" />
                  <span>{ch.roas}x ROAS</span>
                </div>
              )}
              {ch.roas === null && <p className="text-sm text-slate-500 mb-3">N/A ROAS</p>}
              <div className="w-full bg-white/5 rounded-full h-2">
                <div
                  className={`${ch.color} h-2 rounded-full transition-all`}
                  style={{ width: `${ch.pct}%` }}
                />
              </div>
              <p className="text-xs text-slate-500 mt-1">{ch.pct}% of revenue</p>
            </div>
          );
        })}
      </div>

      {/* Conversion Paths */}
      <div className="bg-[#111] border border-white/[0.06] rounded-xl">
        <div className="p-5 border-b border-white/[0.06]">
          <h2 className="text-lg font-semibold text-white">Top Conversion Paths</h2>
          <p className="text-sm text-slate-400 mt-1">Multi-touch journeys leading to conversions</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-white/[0.06]">
                <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Path
                </th>
                <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Conversions
                </th>
                <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Revenue
                </th>
              </tr>
            </thead>
            <tbody>
              {conversionPaths.map((cp, i) => (
                <tr
                  key={i}
                  className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors"
                >
                  <td className="px-5 py-3 text-sm text-slate-300">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {cp.path.map((step, si) => (
                        <span key={si} className="flex items-center gap-1.5">
                          <span className="bg-white/5 border border-white/[0.06] rounded px-2 py-0.5 text-xs">
                            {step}
                          </span>
                          {si < cp.path.length - 1 && (
                            <ArrowRight className="w-3 h-3 text-slate-600" />
                          )}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-5 py-3 text-sm text-slate-300">{cp.conversions}</td>
                  <td className="px-5 py-3 text-sm text-white font-medium">
                    {fmt(cp.revenue)}
                    {compare && (
                      <span className="text-xs text-slate-500 ml-2">vs {fmt(Math.round(cp.revenue * 0.91))}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
