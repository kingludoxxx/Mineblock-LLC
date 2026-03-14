import {
  Database,
  HardDrive,
  Globe,
  Cpu,
  Brain,
  Clock,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';

const services = [
  { name: 'Database (PostgreSQL)', icon: Database, status: 'operational', latency: '8ms', uptime: '99.98%' },
  { name: 'Redis Cache', icon: HardDrive, status: 'operational', latency: '2ms', uptime: '99.99%' },
  { name: 'API Gateway', icon: Globe, status: 'degraded', latency: '145ms', uptime: '99.82%' },
  { name: 'Scraping Workers', icon: Cpu, status: 'operational', latency: '34ms', uptime: '99.91%' },
  { name: 'AI Providers (OpenAI)', icon: Brain, status: 'outage', latency: '--', uptime: '98.40%' },
];

const statusDot = {
  operational: 'bg-emerald-400',
  degraded: 'bg-yellow-400 animate-pulse',
  outage: 'bg-red-500 animate-pulse',
};

const statusLabel = {
  operational: { text: 'Operational', color: 'text-emerald-400' },
  degraded: { text: 'Degraded', color: 'text-yellow-400' },
  outage: { text: 'Outage', color: 'text-red-400' },
};

const incidents = [
  {
    date: '2026-03-13',
    title: 'OpenAI API intermittent failures',
    status: 'Investigating',
    statusColor: 'text-yellow-400',
    updates: [
      { time: '10:30 AM', text: 'We are seeing elevated error rates from OpenAI endpoints. AI-dependent features may be slow or unavailable.' },
      { time: '10:15 AM', text: 'Monitoring alert triggered for OpenAI API response times exceeding 10s threshold.' },
    ],
  },
  {
    date: '2026-03-13',
    title: 'API Gateway elevated latency',
    status: 'Monitoring',
    statusColor: 'text-blue-400',
    updates: [
      { time: '09:45 AM', text: 'Latency has improved after scaling up API gateway pods. Continuing to monitor.' },
      { time: '09:20 AM', text: 'API response times spiked to 500ms+ due to increased traffic. Scaling horizontally.' },
    ],
  },
  {
    date: '2026-03-12',
    title: 'Scheduled maintenance: Database migration',
    status: 'Resolved',
    statusColor: 'text-emerald-400',
    updates: [
      { time: '04:00 AM', text: 'Maintenance completed successfully. All services are operational.' },
      { time: '02:00 AM', text: 'Starting scheduled database migration. Expected downtime: 1-2 hours.' },
    ],
  },
  {
    date: '2026-03-10',
    title: 'Redis cache eviction storm',
    status: 'Resolved',
    statusColor: 'text-emerald-400',
    updates: [
      { time: '03:15 PM', text: 'Root cause identified: memory limit was too low for current dataset. Increased to 512MB.' },
      { time: '02:45 PM', text: 'Cache hit rate dropped to 60%. Investigating memory pressure.' },
    ],
  },
];

export default function StatusPage() {
  const allOperational = services.every((s) => s.status === 'operational');

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">System Status</h1>
        <p className="text-slate-400 mt-1">Service health, latency, and incident history</p>
      </div>

      {/* Overall Status Banner */}
      <div className={`rounded-xl p-4 mb-8 border ${
        allOperational
          ? 'bg-emerald-600/10 border-emerald-600/20'
          : 'bg-yellow-600/10 border-yellow-600/20'
      }`}>
        <div className="flex items-center gap-3">
          {allOperational ? (
            <CheckCircle2 className="w-5 h-5 text-emerald-400" />
          ) : (
            <AlertTriangle className="w-5 h-5 text-yellow-400" />
          )}
          <span className={`font-medium ${allOperational ? 'text-emerald-400' : 'text-yellow-400'}`}>
            {allOperational
              ? 'All systems operational'
              : 'Some systems are experiencing issues'}
          </span>
        </div>
      </div>

      {/* Service Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-10">
        {services.map((svc) => {
          const Icon = svc.icon;
          const sl = statusLabel[svc.status];
          return (
            <div
              key={svc.name}
              className="bg-[#111] border border-white/[0.06] rounded-xl p-5"
            >
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-white/5 rounded-lg">
                    <Icon className="w-4 h-4 text-slate-300" />
                  </div>
                  <span className="text-sm font-medium text-white">{svc.name}</span>
                </div>
                <div className={`w-2.5 h-2.5 rounded-full ${statusDot[svc.status]}`} />
              </div>
              <div className="flex items-center justify-between">
                <span className={`text-sm font-medium ${sl.color}`}>{sl.text}</span>
              </div>
              <div className="flex items-center gap-6 mt-3 text-xs text-slate-500">
                <span className="flex items-center gap-1">
                  <Clock className="w-3 h-3" /> Latency: {svc.latency}
                </span>
                <span>Uptime: {svc.uptime}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Incident History */}
      <div className="bg-[#111] border border-white/[0.06] rounded-xl">
        <div className="px-5 py-4 border-b border-white/[0.06]">
          <h2 className="text-lg font-semibold text-white">Incident History</h2>
        </div>
        <div className="divide-y divide-white/[0.04]">
          {incidents.map((inc, i) => (
            <div key={i} className="px-5 py-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
                <div>
                  <h3 className="text-sm font-medium text-white">{inc.title}</h3>
                  <span className="text-xs text-slate-500">{inc.date}</span>
                </div>
                <span className={`text-xs font-medium ${inc.statusColor}`}>{inc.status}</span>
              </div>
              <div className="ml-3 border-l border-white/[0.06] pl-4 space-y-2">
                {inc.updates.map((u, ui) => (
                  <div key={ui} className="flex gap-3 text-sm">
                    <span className="text-xs text-slate-500 whitespace-nowrap mt-0.5">{u.time}</span>
                    <p className="text-slate-400">{u.text}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
