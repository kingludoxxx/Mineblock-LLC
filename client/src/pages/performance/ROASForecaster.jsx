import { useState } from 'react';
import {
  Calculator,
  DollarSign,
  TrendingUp,
  BarChart3,
  Calendar,
  Target,
} from 'lucide-react';

const channelOptions = ['All Channels', 'Paid Social', 'Paid Search', 'Email', 'YouTube'];

const benchmarks = [
  { channel: 'Paid Social', avgRoas: 3.8, topRoas: 6.2, industryAvg: 2.9 },
  { channel: 'Paid Search', avgRoas: 4.1, topRoas: 7.5, industryAvg: 3.2 },
  { channel: 'Email', avgRoas: 8.4, topRoas: 14.0, industryAvg: 6.1 },
  { channel: 'YouTube', avgRoas: 1.8, topRoas: 3.4, industryAvg: 1.5 },
];

const fmt = (n) => '$' + n.toLocaleString();

export default function ROASForecaster() {
  const [budget, setBudget] = useState(10000);
  const [channel, setChannel] = useState('All Channels');
  const [range, setRange] = useState('30d');
  const [forecast, setForecast] = useState(null);

  const calculate = () => {
    const multiplier =
      channel === 'Email' ? 8.4 : channel === 'Paid Search' ? 4.1 : channel === 'Paid Social' ? 3.8 : channel === 'YouTube' ? 1.8 : 3.9;
    const projected = Math.round(budget * multiplier);
    const low = Math.round(projected * 0.82);
    const high = Math.round(projected * 1.18);
    setForecast({ projected, roas: multiplier, low, high });
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">ROAS Forecaster</h1>
        <p className="text-slate-400 mt-1">Project revenue and ROAS based on ad spend budget</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Input Section */}
        <div className="bg-[#111] border border-white/[0.06] rounded-xl p-6">
          <h2 className="text-lg font-semibold text-white mb-6">Forecast Parameters</h2>

          <div className="space-y-5">
            {/* Budget Input */}
            <div>
              <label className="block text-sm text-slate-400 mb-2">Ad Spend Budget</label>
              <div className="flex items-center gap-2 bg-[#0a0a0a] border border-white/[0.06] rounded-lg px-4 py-3">
                <DollarSign className="w-4 h-4 text-slate-500" />
                <input
                  type="number"
                  value={budget}
                  onChange={(e) => setBudget(Number(e.target.value))}
                  className="bg-transparent text-white text-sm w-full focus:outline-none"
                  placeholder="Enter budget"
                />
              </div>
            </div>

            {/* Date Range */}
            <div>
              <label className="block text-sm text-slate-400 mb-2">Date Range</label>
              <div className="flex items-center gap-2 bg-[#0a0a0a] border border-white/[0.06] rounded-lg px-4 py-3">
                <Calendar className="w-4 h-4 text-slate-500" />
                <select
                  value={range}
                  onChange={(e) => setRange(e.target.value)}
                  className="bg-transparent text-white text-sm w-full focus:outline-none cursor-pointer"
                >
                  <option value="7d">Next 7 days</option>
                  <option value="30d">Next 30 days</option>
                  <option value="90d">Next 90 days</option>
                </select>
              </div>
            </div>

            {/* Channel Selector */}
            <div>
              <label className="block text-sm text-slate-400 mb-2">Channel</label>
              <div className="flex items-center gap-2 bg-[#0a0a0a] border border-white/[0.06] rounded-lg px-4 py-3">
                <Target className="w-4 h-4 text-slate-500" />
                <select
                  value={channel}
                  onChange={(e) => setChannel(e.target.value)}
                  className="bg-transparent text-white text-sm w-full focus:outline-none cursor-pointer"
                >
                  {channelOptions.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            </div>

            <button
              onClick={calculate}
              className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 rounded-lg transition-colors cursor-pointer"
            >
              <Calculator className="w-4 h-4" />
              Calculate Forecast
            </button>
          </div>
        </div>

        {/* Output Section */}
        <div className="space-y-6">
          {forecast ? (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-[#111] border border-white/[0.06] rounded-xl p-5">
                  <div className="flex items-center gap-2 mb-3">
                    <DollarSign className="w-4 h-4 text-emerald-400" />
                    <span className="text-sm text-slate-400">Projected Revenue</span>
                  </div>
                  <p className="text-2xl font-bold text-emerald-400">{fmt(forecast.projected)}</p>
                </div>
                <div className="bg-[#111] border border-white/[0.06] rounded-xl p-5">
                  <div className="flex items-center gap-2 mb-3">
                    <TrendingUp className="w-4 h-4 text-blue-400" />
                    <span className="text-sm text-slate-400">Projected ROAS</span>
                  </div>
                  <p className="text-2xl font-bold text-blue-400">{forecast.roas.toFixed(1)}x</p>
                </div>
              </div>

              <div className="bg-[#111] border border-white/[0.06] rounded-xl p-5">
                <div className="flex items-center gap-2 mb-3">
                  <BarChart3 className="w-4 h-4 text-purple-400" />
                  <span className="text-sm text-slate-400">Confidence Interval (82% - 118%)</span>
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-slate-500 mb-1">Low Estimate</p>
                    <p className="text-lg font-semibold text-red-400">{fmt(forecast.low)}</p>
                  </div>
                  <div className="flex-1 mx-6 h-2 bg-white/5 rounded-full relative">
                    <div className="absolute inset-y-0 left-[15%] right-[15%] bg-gradient-to-r from-red-500/40 via-emerald-500/40 to-red-500/40 rounded-full" />
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-3 bg-emerald-400 rounded-full border-2 border-[#111]" />
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-slate-500 mb-1">High Estimate</p>
                    <p className="text-lg font-semibold text-emerald-400">{fmt(forecast.high)}</p>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="bg-[#111] border border-white/[0.06] rounded-xl p-12 flex items-center justify-center">
              <div className="text-center text-slate-500">
                <Calculator className="w-10 h-10 mx-auto mb-3 opacity-50" />
                <p className="text-sm">Enter your parameters and click Calculate</p>
                <p className="text-xs mt-1">Forecast results will appear here</p>
              </div>
            </div>
          )}

          {/* Benchmark Comparison */}
          <div className="bg-[#111] border border-white/[0.06] rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-white/[0.06]">
              <h2 className="text-lg font-semibold text-white">Benchmark Comparison</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-white/[0.06]">
                    <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Channel</th>
                    <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Your Avg ROAS</th>
                    <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Your Top ROAS</th>
                    <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Industry Avg</th>
                  </tr>
                </thead>
                <tbody>
                  {benchmarks.map((b) => (
                    <tr
                      key={b.channel}
                      className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors"
                    >
                      <td className="px-5 py-3 text-sm text-white font-medium">{b.channel}</td>
                      <td className="px-5 py-3 text-sm text-emerald-400">{b.avgRoas}x</td>
                      <td className="px-5 py-3 text-sm text-blue-400">{b.topRoas}x</td>
                      <td className="px-5 py-3 text-sm text-slate-400">{b.industryAvg}x</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
