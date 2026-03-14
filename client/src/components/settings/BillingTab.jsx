import { useState } from 'react';
import { CreditCard, Check, Download, ArrowUpRight, Zap } from 'lucide-react';

export default function BillingTab() {
  const [plan] = useState({
    name: 'Pro',
    price: '$49',
    period: '/month',
    features: ['Unlimited projects', '50,000 API calls/mo', '10 GB storage', 'Priority support', 'Custom integrations'],
  });

  const usage = [
    { label: 'API Calls', used: 32450, total: 50000, unit: 'calls' },
    { label: 'Storage', used: 4.2, total: 10, unit: 'GB' },
  ];

  const paymentMethod = {
    brand: 'Visa',
    last4: '4242',
    expiry: '12/27',
  };

  const invoices = [
    { id: 'INV-2026-003', date: 'Mar 1, 2026', amount: '$49.00', status: 'Paid' },
    { id: 'INV-2026-002', date: 'Feb 1, 2026', amount: '$49.00', status: 'Paid' },
    { id: 'INV-2026-001', date: 'Jan 1, 2026', amount: '$49.00', status: 'Paid' },
    { id: 'INV-2025-012', date: 'Dec 1, 2025', amount: '$29.00', status: 'Paid' },
    { id: 'INV-2025-011', date: 'Nov 1, 2025', amount: '$29.00', status: 'Paid' },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-white mb-1">Billing</h2>
        <p className="text-sm text-white/40">Manage your plan, usage, and payment methods</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Current Plan */}
        <div className="bg-[#111] rounded-xl border border-white/[0.06] p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-white">Current Plan</h3>
            <span className="px-2.5 py-1 text-xs font-medium bg-blue-500/20 text-blue-400 rounded-full">
              {plan.name}
            </span>
          </div>
          <div className="mb-5">
            <span className="text-3xl font-bold text-white">{plan.price}</span>
            <span className="text-white/40 text-sm">{plan.period}</span>
          </div>
          <ul className="space-y-2 mb-6">
            {plan.features.map((feature) => (
              <li key={feature} className="flex items-center gap-2 text-sm text-white/60">
                <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                {feature}
              </li>
            ))}
          </ul>
          <div className="flex gap-3">
            <button className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer flex items-center justify-center gap-1.5">
              <ArrowUpRight className="w-4 h-4" />
              Upgrade
            </button>
            <button className="flex-1 px-4 py-2 bg-white/[0.04] hover:bg-white/[0.08] text-white/60 text-sm font-medium rounded-lg border border-white/[0.08] transition-colors cursor-pointer">
              Downgrade
            </button>
          </div>
        </div>

        {/* Payment Method */}
        <div className="bg-[#111] rounded-xl border border-white/[0.06] p-6">
          <h3 className="text-sm font-semibold text-white mb-4">Payment Method</h3>
          <div className="flex items-center gap-4 p-4 rounded-lg bg-white/[0.02] border border-white/[0.04] mb-6">
            <div className="w-12 h-8 bg-white/[0.06] rounded flex items-center justify-center">
              <CreditCard className="w-5 h-5 text-white/50" />
            </div>
            <div className="flex-1">
              <p className="text-sm text-white">{paymentMethod.brand} ending in {paymentMethod.last4}</p>
              <p className="text-xs text-white/40">Expires {paymentMethod.expiry}</p>
            </div>
          </div>
          <button className="w-full px-4 py-2 bg-white/[0.04] hover:bg-white/[0.08] text-white/60 text-sm font-medium rounded-lg border border-white/[0.08] transition-colors cursor-pointer">
            Update Payment Method
          </button>

          {/* Usage */}
          <div className="mt-8">
            <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
              <Zap className="w-4 h-4 text-white/50" />
              Usage This Period
            </h3>
            <div className="space-y-4">
              {usage.map((item) => {
                const pct = (item.used / item.total) * 100;
                return (
                  <div key={item.label}>
                    <div className="flex justify-between text-sm mb-1.5">
                      <span className="text-white/60">{item.label}</span>
                      <span className="text-white/40">
                        {typeof item.used === 'number' && item.used > 999
                          ? (item.used / 1000).toFixed(1) + 'k'
                          : item.used}{' '}
                        / {item.total} {item.unit}
                      </span>
                    </div>
                    <div className="w-full h-2 bg-white/[0.06] rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${
                          pct > 80 ? 'bg-orange-500' : 'bg-blue-500'
                        }`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Invoice History */}
      <div className="bg-[#111] rounded-xl border border-white/[0.06]">
        <div className="px-6 py-4 border-b border-white/[0.06]">
          <h3 className="text-sm font-semibold text-white">Invoice History</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-xs text-white/40 border-b border-white/[0.04]">
                <th className="text-left px-6 py-3 font-medium">Invoice</th>
                <th className="text-left px-6 py-3 font-medium">Date</th>
                <th className="text-left px-6 py-3 font-medium">Amount</th>
                <th className="text-left px-6 py-3 font-medium">Status</th>
                <th className="text-right px-6 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} className="border-b border-white/[0.03] last:border-0 hover:bg-white/[0.02]">
                  <td className="px-6 py-3 text-sm text-white font-mono">{inv.id}</td>
                  <td className="px-6 py-3 text-sm text-white/60">{inv.date}</td>
                  <td className="px-6 py-3 text-sm text-white">{inv.amount}</td>
                  <td className="px-6 py-3">
                    <span className="px-2 py-0.5 text-xs font-medium bg-emerald-500/20 text-emerald-400 rounded">
                      {inv.status}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-right">
                    <button className="text-white/30 hover:text-white/60 cursor-pointer">
                      <Download className="w-4 h-4" />
                    </button>
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
