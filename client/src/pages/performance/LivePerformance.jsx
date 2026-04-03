import { useState, useEffect } from 'react';
import {
  DollarSign,
  TrendingUp,
  TrendingDown,
  ShoppingCart,
  CreditCard,
  BarChart3,
  ArrowUpDown,
  RefreshCw,
} from 'lucide-react';

const statCards = [
  { label: "Today's Revenue", value: '$24,832', change: 12.4, icon: DollarSign },
  { label: 'Ad Spend', value: '$6,210', change: -3.2, icon: CreditCard },
  { label: 'ROAS', value: '4.0x', change: 8.1, icon: BarChart3 },
  { label: 'Orders', value: '312', change: 5.7, icon: ShoppingCart },
  { label: 'AOV', value: '$79.59', change: -1.3, icon: TrendingUp },
];

const campaigns = [
  { id: 1, name: 'Summer Sale - Retargeting', spend: 1420, revenue: 7800, roas: 5.49, cpc: 1.24, conversions: 98 },
  { id: 2, name: 'Brand Awareness - TikTok', spend: 980, revenue: 3200, roas: 3.27, cpc: 0.87, conversions: 64 },
  { id: 3, name: 'Google Shopping - Bestsellers', spend: 1650, revenue: 6450, roas: 3.91, cpc: 1.56, conversions: 82 },
  { id: 4, name: 'Meta - Lookalike Audiences', spend: 890, revenue: 4120, roas: 4.63, cpc: 1.05, conversions: 71 },
  { id: 5, name: 'Email Re-engagement Flow', spend: 210, revenue: 1890, roas: 9.0, cpc: 0.34, conversions: 45 },
  { id: 6, name: 'YouTube Pre-roll', spend: 1060, revenue: 1372, roas: 1.29, cpc: 2.12, conversions: 22 },
];

const tabs = ['Overview', 'Funnels', 'Campaigns', 'Products'];
const fmt = (n) => '$' + n.toLocaleString();

export default function LivePerformance() {
  const [activeTab, setActiveTab] = useState('Overview');
  const [secondsAgo, setSecondsAgo] = useState(0);
  const [sortKey, setSortKey] = useState('revenue');
  const [sortAsc, setSortAsc] = useState(false);

  useEffect(() => {
    const iv = setInterval(() => setSecondsAgo((s) => s + 1), 1000);
    return () => clearInterval(iv);
  }, []);

  const sorted = [...campaigns].sort((a, b) =>
    sortAsc ? a[sortKey] - b[sortKey] : b[sortKey] - a[sortKey]
  );

  const toggleSort = (key) => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(false); }
  };

  const colClass =
    'px-5 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400 cursor-pointer select-none hover:text-white transition-colors';

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Live Performance</h1>
          <p className="text-slate-400 mt-1">Real-time campaign and revenue metrics</p>
        </div>
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
          Last updated: {secondsAgo}s ago
        </div>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
        {statCards.map((s) => {
          const Icon = s.icon;
          const up = s.change >= 0;
          return (
            <div
              key={s.label}
              className="bg-[#111] border border-white/[0.06] rounded-xl p-5"
            >
              <div className="flex items-center justify-between mb-3">
                <div className="p-2 bg-white/5 rounded-lg">
                  <Icon className="w-4 h-4 text-slate-300" />
                </div>
                <div
                  className={`flex items-center gap-1 text-sm ${
                    up ? 'text-emerald-400' : 'text-red-400'
                  }`}
                >
                  {up ? (
                    <TrendingUp className="w-3.5 h-3.5" />
                  ) : (
                    <TrendingDown className="w-3.5 h-3.5" />
                  )}
                  <span>{Math.abs(s.change)}%</span>
                </div>
              </div>
              <p className="text-2xl font-bold text-white">{s.value}</p>
              <p className="text-xs text-slate-500 mt-1">{s.label}</p>
            </div>
          );
        })}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-[#111] border border-white/[0.06] rounded-lg p-1 mb-6 w-fit">
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors cursor-pointer ${
              activeTab === t
                ? 'bg-white/10 text-white'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === 'Campaigns' ? (
        <div className="bg-[#111] border border-white/[0.06] rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-white/[0.06]">
            <h2 className="text-lg font-semibold text-white">Campaigns</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-white/[0.06]">
                  <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Campaign Name
                  </th>
                  {[
                    ['spend', 'Spend'],
                    ['revenue', 'Revenue'],
                    ['roas', 'ROAS'],
                    ['cpc', 'CPC'],
                    ['conversions', 'Conv.'],
                  ].map(([key, label]) => (
                    <th
                      key={key}
                      className={colClass}
                      onClick={() => toggleSort(key)}
                    >
                      <span className="flex items-center gap-1">
                        {label}
                        <ArrowUpDown className="w-3 h-3" />
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((c) => (
                  <tr
                    key={c.id}
                    className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors"
                  >
                    <td className="px-5 py-3 text-sm text-white font-medium">{c.name}</td>
                    <td className="px-5 py-3 text-sm text-slate-300">{fmt(c.spend)}</td>
                    <td className="px-5 py-3 text-sm text-emerald-400 font-medium">{fmt(c.revenue)}</td>
                    <td className="px-5 py-3 text-sm">
                      <span
                        className={
                          c.roas >= 3
                            ? 'text-emerald-400'
                            : c.roas >= 2
                            ? 'text-yellow-400'
                            : 'text-red-400'
                        }
                      >
                        {c.roas.toFixed(2)}x
                      </span>
                    </td>
                    <td className="px-5 py-3 text-sm text-slate-300">${c.cpc.toFixed(2)}</td>
                    <td className="px-5 py-3 text-sm text-slate-300">{c.conversions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="bg-[#111] border border-white/[0.06] rounded-xl p-12 flex items-center justify-center">
          <div className="text-center text-slate-500">
            <BarChart3 className="w-10 h-10 mx-auto mb-3 opacity-50" />
            <p className="text-sm font-medium text-slate-400">{activeTab}</p>
            <p className="text-xs mt-1">Coming soon</p>
          </div>
        </div>
      )}
    </div>
  );
}
