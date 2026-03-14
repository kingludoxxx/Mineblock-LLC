import { useState } from 'react';
import { DollarSign, Users, TrendingUp, Calendar } from 'lucide-react';

const cohorts = ['2025-Q4', '2025-Q3', '2025-Q2', '2025-Q1', '2024-Q4'];

const ltvMetrics = {
  '2025-Q4': { avg: 312, d30: 48, d60: 89, d90: 142 },
  '2025-Q3': { avg: 287, d30: 42, d60: 81, d90: 128 },
  '2025-Q2': { avg: 305, d30: 45, d60: 86, d90: 138 },
  '2025-Q1': { avg: 265, d30: 38, d60: 72, d90: 112 },
  '2024-Q4': { avg: 298, d30: 44, d60: 84, d90: 135 },
};

const cohortTable = [
  { month: 'Month 0', '2025-Q4': 100, '2025-Q3': 100, '2025-Q2': 100, '2025-Q1': 100, '2024-Q4': 100 },
  { month: 'Month 1', '2025-Q4': 68, '2025-Q3': 62, '2025-Q2': 65, '2025-Q1': 58, '2024-Q4': 64 },
  { month: 'Month 2', '2025-Q4': 52, '2025-Q3': 48, '2025-Q2': 50, '2025-Q1': 44, '2024-Q4': 49 },
  { month: 'Month 3', '2025-Q4': 41, '2025-Q3': 38, '2025-Q2': 40, '2025-Q1': 35, '2024-Q4': 39 },
  { month: 'Month 4', '2025-Q4': 34, '2025-Q3': 31, '2025-Q2': 33, '2025-Q1': 28, '2024-Q4': 32 },
  { month: 'Month 5', '2025-Q4': 29, '2025-Q3': 26, '2025-Q2': 28, '2025-Q1': 24, '2024-Q4': 27 },
  { month: 'Month 6', '2025-Q4': null, '2025-Q3': 22, '2025-Q2': 24, '2025-Q1': 20, '2024-Q4': 23 },
];

const fmt = (n) => '$' + n.toLocaleString();

export default function LTV() {
  const [selectedCohort, setSelectedCohort] = useState('2025-Q4');
  const m = ltvMetrics[selectedCohort];

  const metricCards = [
    { label: 'Average LTV', value: fmt(m.avg), icon: DollarSign, color: 'text-emerald-400' },
    { label: '30-Day LTV', value: fmt(m.d30), icon: Calendar, color: 'text-blue-400' },
    { label: '60-Day LTV', value: fmt(m.d60), icon: TrendingUp, color: 'text-purple-400' },
    { label: '90-Day LTV', value: fmt(m.d90), icon: Users, color: 'text-yellow-400' },
  ];

  const cellColor = (v) => {
    if (v === null) return 'text-slate-600';
    if (v >= 60) return 'text-emerald-400 bg-emerald-500/10';
    if (v >= 40) return 'text-yellow-400 bg-yellow-500/10';
    if (v >= 25) return 'text-orange-400 bg-orange-500/10';
    return 'text-red-400 bg-red-500/10';
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-8 gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Customer Lifetime Value</h1>
          <p className="text-slate-400 mt-1">Cohort-based LTV projections and retention</p>
        </div>
        <select
          value={selectedCohort}
          onChange={(e) => setSelectedCohort(e.target.value)}
          className="bg-[#111] border border-white/[0.06] rounded-lg px-4 py-2 text-sm text-white focus:outline-none cursor-pointer"
        >
          {cohorts.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>

      {/* LTV Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {metricCards.map((mc) => {
          const Icon = mc.icon;
          return (
            <div
              key={mc.label}
              className="bg-[#111] border border-white/[0.06] rounded-xl p-5"
            >
              <div className="flex items-center gap-2 mb-3">
                <div className="p-2 bg-white/5 rounded-lg">
                  <Icon className={`w-4 h-4 ${mc.color}`} />
                </div>
                <span className="text-sm text-slate-400">{mc.label}</span>
              </div>
              <p className={`text-2xl font-bold ${mc.color}`}>{mc.value}</p>
            </div>
          );
        })}
      </div>

      {/* Retention Curve Placeholder */}
      <div className="bg-[#111] border border-white/[0.06] rounded-xl p-6 mb-8">
        <h2 className="text-lg font-semibold text-white mb-2">Retention Curve</h2>
        <p className="text-sm text-slate-400 mb-4">
          Cohort: {selectedCohort} -- Percentage of customers returning each month
        </p>
        <div className="h-48 flex items-center justify-center border border-dashed border-white/[0.08] rounded-lg">
          <div className="text-center text-slate-500">
            <TrendingUp className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">Retention curve chart</p>
            <p className="text-xs mt-1">Displays customer retention over time for the selected cohort</p>
          </div>
        </div>
      </div>

      {/* Cohort Table */}
      <div className="bg-[#111] border border-white/[0.06] rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-white/[0.06]">
          <h2 className="text-lg font-semibold text-white">Cohort Retention Table</h2>
          <p className="text-sm text-slate-400 mt-1">Monthly retention percentage by cohort</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-white/[0.06]">
                <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Period
                </th>
                {cohorts.map((c) => (
                  <th
                    key={c}
                    className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400"
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cohortTable.map((row, i) => (
                <tr
                  key={i}
                  className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors"
                >
                  <td className="px-5 py-3 text-sm text-white font-medium">{row.month}</td>
                  {cohorts.map((c) => (
                    <td key={c} className="px-5 py-3 text-sm">
                      <span className={`px-2 py-0.5 rounded ${cellColor(row[c])}`}>
                        {row[c] !== null ? `${row[c]}%` : '--'}
                      </span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
