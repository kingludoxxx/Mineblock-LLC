import { useState } from 'react';
import {
  ArrowLeft,
  Filter,
  Clock,
  Globe,
  ChevronDown,
} from 'lucide-react';

const apiLogs = [
  { id: 1, timestamp: '2026-03-13T10:42:18Z', endpoint: '/api/v1/campaigns', method: 'GET', status: 200, duration: 124, user: 'sarah@mineblock.io' },
  { id: 2, timestamp: '2026-03-13T10:41:55Z', endpoint: '/api/v1/scrapes', method: 'POST', status: 201, duration: 342, user: 'system' },
  { id: 3, timestamp: '2026-03-13T10:41:30Z', endpoint: '/api/v1/users/me', method: 'GET', status: 200, duration: 45, user: 'mike@mineblock.io' },
  { id: 4, timestamp: '2026-03-13T10:40:12Z', endpoint: '/api/v1/auth/login', method: 'POST', status: 401, duration: 89, user: 'unknown' },
  { id: 5, timestamp: '2026-03-13T10:39:48Z', endpoint: '/api/v1/campaigns/42', method: 'PUT', status: 200, duration: 210, user: 'sarah@mineblock.io' },
  { id: 6, timestamp: '2026-03-13T10:38:22Z', endpoint: '/api/v1/reports/export', method: 'GET', status: 500, duration: 5012, user: 'jordan@mineblock.io' },
  { id: 7, timestamp: '2026-03-13T10:37:10Z', endpoint: '/api/v1/scrapes/run', method: 'POST', status: 202, duration: 156, user: 'system' },
  { id: 8, timestamp: '2026-03-13T10:36:44Z', endpoint: '/api/v1/users', method: 'GET', status: 403, duration: 32, user: 'guest@external.com' },
  { id: 9, timestamp: '2026-03-13T10:35:18Z', endpoint: '/api/v1/ai/generate', method: 'POST', status: 200, duration: 2840, user: 'sarah@mineblock.io' },
  { id: 10, timestamp: '2026-03-13T10:34:02Z', endpoint: '/api/v1/campaigns', method: 'DELETE', status: 404, duration: 67, user: 'mike@mineblock.io' },
  { id: 11, timestamp: '2026-03-13T10:33:15Z', endpoint: '/api/v1/webhooks', method: 'POST', status: 500, duration: 8200, user: 'system' },
  { id: 12, timestamp: '2026-03-13T10:32:00Z', endpoint: '/api/v1/dashboard/stats', method: 'GET', status: 200, duration: 98, user: 'jordan@mineblock.io' },
];

const mockDetail = {
  request: {
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ***redacted***' },
    body: '{ "query": "summer sale", "platform": "meta" }',
  },
  response: {
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'req_abc123' },
    body: '{ "success": true, "data": { "id": 42, "status": "created" } }',
  },
};

const statusColor = (s) => {
  if (s >= 500) return 'bg-red-600/20 text-red-400 border-red-600/30';
  if (s >= 400) return 'bg-yellow-600/20 text-yellow-400 border-yellow-600/30';
  return 'bg-emerald-600/20 text-emerald-400 border-emerald-600/30';
};

const methodColor = (m) => {
  const map = { GET: 'text-blue-400', POST: 'text-emerald-400', PUT: 'text-yellow-400', DELETE: 'text-red-400', PATCH: 'text-purple-400' };
  return map[m] || 'text-slate-400';
};

const endpoints = [...new Set(apiLogs.map((l) => l.endpoint))];

export default function APIRuns() {
  const [selected, setSelected] = useState(null);
  const [endpointFilter, setEndpointFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const filtered = apiLogs.filter((l) => {
    if (endpointFilter && l.endpoint !== endpointFilter) return false;
    if (statusFilter === '2xx' && (l.status < 200 || l.status >= 300)) return false;
    if (statusFilter === '4xx' && (l.status < 400 || l.status >= 500)) return false;
    if (statusFilter === '5xx' && l.status < 500) return false;
    return true;
  });

  const detail = selected ? apiLogs.find((l) => l.id === selected) : null;

  if (detail) {
    return (
      <div className="min-h-screen bg-[#0a0a0a]">
        <button
          onClick={() => setSelected(null)}
          className="flex items-center gap-2 text-slate-400 hover:text-white text-sm mb-6 cursor-pointer transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> Back to logs
        </button>

        <div className="bg-[#111] border border-white/[0.06] rounded-xl p-6 mb-6">
          <div className="flex flex-wrap items-center gap-4 mb-4">
            <span className={`font-mono text-sm font-bold ${methodColor(detail.method)}`}>{detail.method}</span>
            <span className="text-white font-mono text-sm">{detail.endpoint}</span>
            <span className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-medium border ${statusColor(detail.status)}`}>
              {detail.status}
            </span>
          </div>
          <div className="flex items-center gap-6 text-sm text-slate-500">
            <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5" />{detail.duration}ms</span>
            <span className="flex items-center gap-1"><Globe className="w-3.5 h-3.5" />{detail.user}</span>
            <span>{new Date(detail.timestamp).toLocaleString()}</span>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-[#111] border border-white/[0.06] rounded-xl p-5">
            <h3 className="text-sm font-semibold text-white mb-3">Request</h3>
            <div className="mb-3">
              <p className="text-xs text-slate-500 mb-1">Headers</p>
              <pre className="bg-[#0a0a0a] border border-white/[0.06] rounded-lg p-3 text-xs text-slate-300 overflow-auto">
                {JSON.stringify(mockDetail.request.headers, null, 2)}
              </pre>
            </div>
            <div>
              <p className="text-xs text-slate-500 mb-1">Body</p>
              <pre className="bg-[#0a0a0a] border border-white/[0.06] rounded-lg p-3 text-xs text-slate-300 overflow-auto">
                {mockDetail.request.body}
              </pre>
            </div>
          </div>

          <div className="bg-[#111] border border-white/[0.06] rounded-xl p-5">
            <h3 className="text-sm font-semibold text-white mb-3">Response</h3>
            <div className="mb-3">
              <p className="text-xs text-slate-500 mb-1">Headers</p>
              <pre className="bg-[#0a0a0a] border border-white/[0.06] rounded-lg p-3 text-xs text-slate-300 overflow-auto">
                {JSON.stringify(mockDetail.response.headers, null, 2)}
              </pre>
            </div>
            <div>
              <p className="text-xs text-slate-500 mb-1">Body</p>
              <pre className="bg-[#0a0a0a] border border-white/[0.06] rounded-lg p-3 text-xs text-slate-300 overflow-auto">
                {mockDetail.response.body}
              </pre>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">API Runs</h1>
          <p className="text-slate-400 mt-1">API call history and request inspection</p>
        </div>
      </div>

      <div className="bg-[#111] border border-white/[0.06] rounded-xl overflow-hidden">
        {/* Filters */}
        <div className="p-4 border-b border-white/[0.06] flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2 text-slate-400">
            <Filter className="w-4 h-4" />
            <span className="text-sm">Filters:</span>
          </div>
          <div className="relative">
            <select
              value={endpointFilter}
              onChange={(e) => setEndpointFilter(e.target.value)}
              className="bg-[#0a0a0a] border border-white/[0.06] rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none cursor-pointer appearance-none pr-8"
            >
              <option value="">All Endpoints</option>
              {endpoints.map((ep) => (
                <option key={ep} value={ep}>{ep}</option>
              ))}
            </select>
            <ChevronDown className="w-3.5 h-3.5 text-slate-500 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>
          <div className="relative">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="bg-[#0a0a0a] border border-white/[0.06] rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none cursor-pointer appearance-none pr-8"
            >
              <option value="">All Status</option>
              <option value="2xx">2xx Success</option>
              <option value="4xx">4xx Client Error</option>
              <option value="5xx">5xx Server Error</option>
            </select>
            <ChevronDown className="w-3.5 h-3.5 text-slate-500 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-white/[0.06]">
                {['Timestamp', 'Endpoint', 'Method', 'Status', 'Duration', 'User'].map((h) => (
                  <th key={h} className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((l) => (
                <tr
                  key={l.id}
                  onClick={() => setSelected(l.id)}
                  className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors cursor-pointer"
                >
                  <td className="px-5 py-3 text-sm text-slate-400 font-mono text-xs">
                    {new Date(l.timestamp).toLocaleTimeString()}
                  </td>
                  <td className="px-5 py-3 text-sm text-white font-mono text-xs">{l.endpoint}</td>
                  <td className="px-5 py-3 text-sm">
                    <span className={`font-mono font-bold text-xs ${methodColor(l.method)}`}>{l.method}</span>
                  </td>
                  <td className="px-5 py-3 text-sm">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium border ${statusColor(l.status)}`}>
                      {l.status}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-sm text-slate-300">{l.duration}ms</td>
                  <td className="px-5 py-3 text-sm text-slate-400">{l.user}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-5 py-8 text-center text-slate-500">No matching API logs</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
