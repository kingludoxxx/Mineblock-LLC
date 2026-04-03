import {
  Layers,
  Cpu,
  Database,
  HardDrive,
  AlertTriangle,
  CheckCircle2,
  Clock,
  XCircle,
} from 'lucide-react';

const queueStats = [
  { label: 'Pending', value: 23, color: 'text-yellow-400' },
  { label: 'Processing', value: 8, color: 'text-accent-text' },
  { label: 'Completed', value: 1482, color: 'text-emerald-400' },
  { label: 'Failed', value: 12, color: 'text-red-400' },
];

const workerStats = [
  { label: 'Active', value: 6, color: 'text-emerald-400', icon: CheckCircle2 },
  { label: 'Idle', value: 2, color: 'text-slate-400', icon: Clock },
  { label: 'Errored', value: 1, color: 'text-red-400', icon: XCircle },
];

const dbMetrics = [
  { label: 'Active Connections', value: '24 / 100' },
  { label: 'Query Latency (p95)', value: '12ms' },
  { label: 'Slow Queries (24h)', value: '3' },
  { label: 'DB Size', value: '4.2 GB' },
];

const redisMetrics = [
  { label: 'Memory Usage', value: '128 MB / 512 MB' },
  { label: 'Hit Rate', value: '94.2%' },
  { label: 'Connected Clients', value: '18' },
  { label: 'Evicted Keys (24h)', value: '0' },
];

const recentErrors = [
  { time: '2026-03-13T10:38:22Z', message: 'GET /api/v1/reports/export - 500 Internal Server Error', source: 'API Gateway' },
  { time: '2026-03-13T10:33:15Z', message: 'POST /api/v1/webhooks - 500 Connection timeout to stripe.com', source: 'Webhook Service' },
  { time: '2026-03-13T09:15:42Z', message: 'Worker scrapy-worker-7 OOM killed (memory limit: 512MB)', source: 'Scrape Worker' },
  { time: '2026-03-13T08:22:10Z', message: 'Redis connection pool exhausted, retry in 5s', source: 'Cache Layer' },
  { time: '2026-03-13T07:05:33Z', message: 'Rate limit exceeded for OpenAI API key sk-***prod', source: 'AI Provider' },
];

export default function OpsDashboard() {
  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">Ops Dashboard</h1>
        <p className="text-slate-400 mt-1">System health and infrastructure metrics</p>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        {/* Queue Stats */}
        <div className="bg-[#111] border border-white/[0.06] rounded-xl p-5">
          <div className="flex items-center gap-2 mb-5">
            <Layers className="w-5 h-5 text-accent-text" />
            <h2 className="text-lg font-semibold text-white">Queue Stats</h2>
          </div>
          <div className="grid grid-cols-2 gap-4">
            {queueStats.map((s) => (
              <div key={s.label} className="bg-[#0a0a0a] border border-white/[0.06] rounded-lg p-4">
                <p className="text-xs text-slate-500 mb-1">{s.label}</p>
                <p className={`text-2xl font-bold ${s.color}`}>{s.value.toLocaleString()}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Worker Status */}
        <div className="bg-[#111] border border-white/[0.06] rounded-xl p-5">
          <div className="flex items-center gap-2 mb-5">
            <Cpu className="w-5 h-5 text-purple-400" />
            <h2 className="text-lg font-semibold text-white">Worker Status</h2>
          </div>
          <div className="space-y-4">
            {workerStats.map((w) => {
              const Icon = w.icon;
              return (
                <div key={w.label} className="flex items-center justify-between bg-[#0a0a0a] border border-white/[0.06] rounded-lg p-4">
                  <div className="flex items-center gap-3">
                    <Icon className={`w-5 h-5 ${w.color}`} />
                    <span className="text-sm text-slate-300">{w.label}</span>
                  </div>
                  <span className={`text-xl font-bold ${w.color}`}>{w.value}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Database Metrics */}
        <div className="bg-[#111] border border-white/[0.06] rounded-xl p-5">
          <div className="flex items-center gap-2 mb-5">
            <Database className="w-5 h-5 text-emerald-400" />
            <h2 className="text-lg font-semibold text-white">Database</h2>
          </div>
          <div className="space-y-3">
            {dbMetrics.map((m) => (
              <div key={m.label} className="flex items-center justify-between py-2 border-b border-white/[0.04] last:border-0">
                <span className="text-sm text-slate-400">{m.label}</span>
                <span className="text-sm text-white font-medium">{m.value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Redis Metrics */}
        <div className="bg-[#111] border border-white/[0.06] rounded-xl p-5">
          <div className="flex items-center gap-2 mb-5">
            <HardDrive className="w-5 h-5 text-red-400" />
            <h2 className="text-lg font-semibold text-white">Redis</h2>
          </div>
          <div className="space-y-3">
            {redisMetrics.map((m) => (
              <div key={m.label} className="flex items-center justify-between py-2 border-b border-white/[0.04] last:border-0">
                <span className="text-sm text-slate-400">{m.label}</span>
                <span className="text-sm text-white font-medium">{m.value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Recent Errors */}
      <div className="bg-[#111] border border-white/[0.06] rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-white/[0.06] flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-red-400" />
          <h2 className="text-lg font-semibold text-white">Recent Errors</h2>
        </div>
        <div className="divide-y divide-white/[0.04]">
          {recentErrors.map((err, i) => (
            <div key={i} className="px-5 py-4 hover:bg-white/[0.02] transition-colors">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-red-400 font-mono truncate">{err.message}</p>
                  <p className="text-xs text-slate-500 mt-1">{err.source}</p>
                </div>
                <span className="text-xs text-slate-500 whitespace-nowrap">
                  {new Date(err.time).toLocaleTimeString()}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
