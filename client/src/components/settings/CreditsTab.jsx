import { useState } from 'react';
import { Coins, TrendingUp, ShoppingCart, BarChart3 } from 'lucide-react';

export default function CreditsTab() {
  const credits = { balance: 2450, total: 5000 };
  const pct = (credits.balance / credits.total) * 100;

  const recentUsage = [
    { id: 1, feature: 'AI Text Generation', credits: -120, date: 'Mar 13, 2026', time: '2:34 PM' },
    { id: 2, feature: 'Image Generation', credits: -250, date: 'Mar 12, 2026', time: '11:15 AM' },
    { id: 3, feature: 'Video Rendering', credits: -500, date: 'Mar 11, 2026', time: '4:45 PM' },
    { id: 4, feature: 'Web Scraping', credits: -80, date: 'Mar 10, 2026', time: '9:20 AM' },
    { id: 5, feature: 'AI Text Generation', credits: -60, date: 'Mar 9, 2026', time: '3:10 PM' },
    { id: 6, feature: 'Credit Top-Up', credits: 2000, date: 'Mar 8, 2026', time: '10:00 AM' },
  ];

  const topUpTiers = [
    { credits: 1000, price: '$10', perCredit: '$0.010', popular: false },
    { credits: 5000, price: '$40', perCredit: '$0.008', popular: true },
    { credits: 10000, price: '$70', perCredit: '$0.007', popular: false },
    { credits: 25000, price: '$150', perCredit: '$0.006', popular: false },
  ];

  // SVG progress ring
  const radius = 58;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (pct / 100) * circumference;

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-white mb-1">Credits</h2>
        <p className="text-sm text-white/40">Monitor your credit balance and usage</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Credit Balance with Progress Ring */}
        <div className="bg-[#111] rounded-xl border border-white/[0.06] p-6 flex flex-col items-center justify-center">
          <div className="relative w-36 h-36 mb-4">
            <svg className="w-full h-full -rotate-90" viewBox="0 0 128 128">
              <circle cx="64" cy="64" r={radius} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="8" />
              <circle
                cx="64"
                cy="64"
                r={radius}
                fill="none"
                stroke="#3b82f6"
                strokeWidth="8"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={offset}
                className="transition-all duration-700"
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-2xl font-bold text-white">{credits.balance.toLocaleString()}</span>
              <span className="text-xs text-white/40">credits</span>
            </div>
          </div>
          <p className="text-sm text-white/40">
            {credits.balance.toLocaleString()} of {credits.total.toLocaleString()} remaining
          </p>
        </div>

        {/* Usage Breakdown */}
        <div className="lg:col-span-2 bg-[#111] rounded-xl border border-white/[0.06] p-6">
          <div className="flex items-center gap-2 mb-4">
            <BarChart3 className="w-4 h-4 text-white/50" />
            <h3 className="text-sm font-semibold text-white">Usage Breakdown</h3>
          </div>
          <div className="h-48 flex items-center justify-center border border-dashed border-white/[0.06] rounded-lg">
            <div className="text-center">
              <TrendingUp className="w-8 h-8 text-white/10 mx-auto mb-2" />
              <p className="text-sm text-white/20">Chart visualization coming soon</p>
              <p className="text-xs text-white/10 mt-1">Credit usage by feature over time</p>
            </div>
          </div>
        </div>
      </div>

      {/* Recent Usage Table */}
      <div className="bg-[#111] rounded-xl border border-white/[0.06]">
        <div className="px-6 py-4 border-b border-white/[0.06]">
          <h3 className="text-sm font-semibold text-white">Recent Usage</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-xs text-white/40 border-b border-white/[0.04]">
                <th className="text-left px-6 py-3 font-medium">Feature</th>
                <th className="text-left px-6 py-3 font-medium">Date</th>
                <th className="text-right px-6 py-3 font-medium">Credits</th>
              </tr>
            </thead>
            <tbody>
              {recentUsage.map((item) => (
                <tr key={item.id} className="border-b border-white/[0.03] last:border-0 hover:bg-white/[0.02]">
                  <td className="px-6 py-3 text-sm text-white">{item.feature}</td>
                  <td className="px-6 py-3 text-sm text-white/40">
                    {item.date} at {item.time}
                  </td>
                  <td className={`px-6 py-3 text-sm text-right font-mono ${
                    item.credits > 0 ? 'text-emerald-400' : 'text-white/60'
                  }`}>
                    {item.credits > 0 ? '+' : ''}{item.credits.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Top-Up Section */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <ShoppingCart className="w-4 h-4 text-white/50" />
          <h3 className="text-sm font-semibold text-white">Top Up Credits</h3>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {topUpTiers.map((tier) => (
            <div
              key={tier.credits}
              className={`relative bg-[#111] rounded-xl border p-5 transition-colors cursor-pointer hover:border-blue-500/50 ${
                tier.popular ? 'border-blue-500/40' : 'border-white/[0.06]'
              }`}
            >
              {tier.popular && (
                <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-2.5 py-0.5 text-[10px] font-semibold bg-blue-600 text-white rounded-full">
                  Most Popular
                </span>
              )}
              <div className="flex items-center gap-1.5 mb-3">
                <Coins className="w-4 h-4 text-yellow-500" />
                <span className="text-lg font-bold text-white">{tier.credits.toLocaleString()}</span>
              </div>
              <p className="text-2xl font-bold text-white mb-1">{tier.price}</p>
              <p className="text-xs text-white/40 mb-4">{tier.perCredit} per credit</p>
              <button className={`w-full py-2 text-sm font-medium rounded-lg transition-colors cursor-pointer ${
                tier.popular
                  ? 'bg-blue-600 hover:bg-blue-700 text-white'
                  : 'bg-white/[0.04] hover:bg-white/[0.08] text-white/60 border border-white/[0.08]'
              }`}>
                Purchase
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
