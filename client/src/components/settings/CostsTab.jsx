import { useState } from 'react';
import { DollarSign, TrendingUp, Bell, Plus, Trash2 } from 'lucide-react';

export default function CostsTab() {
  const monthlyTotal = 111.50;

  const providerCosts = [
    { provider: 'OpenAI', calls: 12400, cost: 34.20, pctOfTotal: 30.7 },
    { provider: 'Anthropic', calls: 8200, cost: 28.50, pctOfTotal: 25.6 },
    { provider: 'HeyGen', calls: 45, cost: 22.50, pctOfTotal: 20.2 },
    { provider: 'Stability AI', calls: 1560, cost: 12.40, pctOfTotal: 11.1 },
    { provider: 'ElevenLabs', calls: 220, cost: 8.80, pctOfTotal: 7.9 },
    { provider: 'Replicate', calls: 340, cost: 5.10, pctOfTotal: 4.6 },
  ];

  const [alerts, setAlerts] = useState([
    { id: 1, name: 'Monthly Budget', threshold: 150, type: 'total', enabled: true },
    { id: 2, name: 'OpenAI Limit', threshold: 50, type: 'provider', provider: 'OpenAI', enabled: true },
  ]);

  const [newAlert, setNewAlert] = useState({ name: '', threshold: '' });

  const addAlert = () => {
    if (!newAlert.name || !newAlert.threshold) return;
    setAlerts([
      ...alerts,
      { id: Date.now(), name: newAlert.name, threshold: Number(newAlert.threshold), type: 'total', enabled: true },
    ]);
    setNewAlert({ name: '', threshold: '' });
  };

  const removeAlert = (id) => {
    setAlerts(alerts.filter((a) => a.id !== id));
  };

  const toggleAlert = (id) => {
    setAlerts(alerts.map((a) => (a.id === id ? { ...a, enabled: !a.enabled } : a)));
  };

  const barColors = [
    'bg-blue-500', 'bg-violet-500', 'bg-emerald-500', 'bg-orange-500', 'bg-pink-500', 'bg-cyan-500',
  ];

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-white mb-1">Costs</h2>
        <p className="text-sm text-white/40">Track spending across AI providers and set budget alerts</p>
      </div>

      {/* Monthly Overview */}
      <div className="bg-[#111] rounded-xl border border-white/[0.06] p-6">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-lg bg-accent-muted flex items-center justify-center">
            <DollarSign className="w-5 h-5 text-accent-text" />
          </div>
          <div>
            <p className="text-xs text-white/40">Monthly Total (March 2026)</p>
            <p className="text-3xl font-bold text-white">${monthlyTotal.toFixed(2)}</p>
          </div>
        </div>
        {/* Mini bar */}
        <div className="flex h-2 rounded-full overflow-hidden mt-4">
          {providerCosts.map((p, i) => (
            <div
              key={p.provider}
              className={`${barColors[i]} transition-all`}
              style={{ width: `${p.pctOfTotal}%` }}
              title={`${p.provider}: $${p.cost}`}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3">
          {providerCosts.map((p, i) => (
            <div key={p.provider} className="flex items-center gap-1.5 text-xs text-white/40">
              <div className={`w-2 h-2 rounded-full ${barColors[i]}`} />
              {p.provider}
            </div>
          ))}
        </div>
      </div>

      {/* Per-Provider Breakdown */}
      <div className="bg-[#111] rounded-xl border border-white/[0.06]">
        <div className="px-6 py-4 border-b border-white/[0.06]">
          <h3 className="text-sm font-semibold text-white">Per-Provider Breakdown</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-xs text-white/40 border-b border-white/[0.04]">
                <th className="text-left px-6 py-3 font-medium">Provider</th>
                <th className="text-right px-6 py-3 font-medium">API Calls</th>
                <th className="text-right px-6 py-3 font-medium">Cost</th>
                <th className="text-right px-6 py-3 font-medium">% of Total</th>
                <th className="text-left px-6 py-3 font-medium w-40" />
              </tr>
            </thead>
            <tbody>
              {providerCosts.map((p, i) => (
                <tr key={p.provider} className="border-b border-white/[0.03] last:border-0 hover:bg-white/[0.02]">
                  <td className="px-6 py-3">
                    <div className="flex items-center gap-2">
                      <div className={`w-2 h-2 rounded-full ${barColors[i]}`} />
                      <span className="text-sm text-white">{p.provider}</span>
                    </div>
                  </td>
                  <td className="px-6 py-3 text-sm text-white/60 text-right font-mono">
                    {p.calls.toLocaleString()}
                  </td>
                  <td className="px-6 py-3 text-sm text-white text-right font-mono">
                    ${p.cost.toFixed(2)}
                  </td>
                  <td className="px-6 py-3 text-sm text-white/40 text-right">
                    {p.pctOfTotal}%
                  </td>
                  <td className="px-6 py-3">
                    <div className="w-full h-1.5 bg-white/[0.04] rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${barColors[i]}`} style={{ width: `${p.pctOfTotal}%` }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Daily Chart Placeholder */}
      <div className="bg-[#111] rounded-xl border border-white/[0.06] p-6">
        <h3 className="text-sm font-semibold text-white mb-4">Daily Cost Trend</h3>
        <div className="h-48 flex items-center justify-center border border-dashed border-white/[0.06] rounded-lg">
          <div className="text-center">
            <TrendingUp className="w-8 h-8 text-white/10 mx-auto mb-2" />
            <p className="text-sm text-white/20">Daily cost chart coming soon</p>
            <p className="text-xs text-white/10 mt-1">Costs broken down by day and provider</p>
          </div>
        </div>
      </div>

      {/* Budget Alerts */}
      <div className="bg-[#111] rounded-xl border border-white/[0.06] p-6">
        <div className="flex items-center gap-2 mb-5">
          <Bell className="w-4 h-4 text-white/50" />
          <h3 className="text-sm font-semibold text-white">Budget Alerts</h3>
        </div>

        <div className="space-y-3 mb-5">
          {alerts.map((alert) => (
            <div
              key={alert.id}
              className="flex items-center justify-between p-3 rounded-lg bg-white/[0.02] border border-white/[0.04]"
            >
              <div className="flex items-center gap-3">
                <button
                  onClick={() => toggleAlert(alert.id)}
                  className={`relative w-9 h-5 rounded-full transition-colors cursor-pointer ${
                    alert.enabled ? 'bg-accent' : 'bg-white/[0.1]'
                  }`}
                >
                  <div
                    className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                      alert.enabled ? 'translate-x-4.5' : 'translate-x-0.5'
                    }`}
                  />
                </button>
                <div>
                  <p className="text-sm text-white">{alert.name}</p>
                  <p className="text-xs text-white/40">Alert when costs exceed ${alert.threshold}</p>
                </div>
              </div>
              <button
                onClick={() => removeAlert(alert.id)}
                className="p-1.5 text-white/20 hover:text-red-400 transition-colors cursor-pointer"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>

        {/* Add Alert */}
        <div className="flex gap-3">
          <input
            type="text"
            value={newAlert.name}
            onChange={(e) => setNewAlert({ ...newAlert, name: e.target.value })}
            placeholder="Alert name"
            className="flex-1 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-lg text-white text-sm
              focus:outline-none focus:border-white/[0.2] placeholder-white/20"
          />
          <input
            type="number"
            value={newAlert.threshold}
            onChange={(e) => setNewAlert({ ...newAlert, threshold: e.target.value })}
            placeholder="$ threshold"
            className="w-32 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-lg text-white text-sm
              focus:outline-none focus:border-white/[0.2] placeholder-white/20"
          />
          <button
            onClick={addAlert}
            disabled={!newAlert.name || !newAlert.threshold}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg
              transition-colors disabled:opacity-50 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
