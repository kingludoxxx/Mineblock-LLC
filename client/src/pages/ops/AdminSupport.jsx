import { useState } from 'react';
import {
  ArrowLeft,
  Clock,
  User,
  Send,
  AlertTriangle,
  CheckCircle2,
  Circle,
  Loader2,
} from 'lucide-react';

const tickets = [
  {
    id: 'TK-1001',
    subject: 'Cannot access dashboard after password reset',
    status: 'Open',
    priority: 'High',
    assignee: 'Sarah Chen',
    created: '2026-03-13T09:14:00Z',
    messages: [
      { from: 'customer', name: 'John Doe', time: '2026-03-13T09:14:00Z', text: 'After resetting my password I keep getting a 403 error when trying to access the main dashboard. I have tried clearing my cache and using incognito mode.' },
      { from: 'agent', name: 'Sarah Chen', time: '2026-03-13T09:32:00Z', text: 'Hi John, I can see your session token was not invalidated properly after the reset. I have flushed your session. Could you try logging in again?' },
      { from: 'customer', name: 'John Doe', time: '2026-03-13T09:45:00Z', text: 'That worked, thank you! But now I notice my saved filters are gone.' },
    ],
  },
  {
    id: 'TK-1002',
    subject: 'Billing discrepancy on March invoice',
    status: 'In Progress',
    priority: 'Medium',
    assignee: 'Mike Torres',
    created: '2026-03-12T14:22:00Z',
    messages: [
      { from: 'customer', name: 'Alice Wang', time: '2026-03-12T14:22:00Z', text: 'My March invoice shows $499 but my plan is $299/mo. Please clarify the extra charge.' },
    ],
  },
  {
    id: 'TK-1003',
    subject: 'API rate limiting too aggressive',
    status: 'Open',
    priority: 'Critical',
    assignee: 'Sarah Chen',
    created: '2026-03-13T07:05:00Z',
    messages: [
      { from: 'customer', name: 'DevTeam Bot', time: '2026-03-13T07:05:00Z', text: 'We are hitting 429 errors after only 50 requests/min. Our plan should allow 500/min.' },
    ],
  },
  {
    id: 'TK-1004',
    subject: 'Feature request: Export to CSV',
    status: 'Resolved',
    priority: 'Low',
    assignee: 'Jordan Kim',
    created: '2026-03-10T11:30:00Z',
    messages: [
      { from: 'customer', name: 'Pat Riley', time: '2026-03-10T11:30:00Z', text: 'It would be great to export reports as CSV files.' },
      { from: 'agent', name: 'Jordan Kim', time: '2026-03-10T16:00:00Z', text: 'Great news -- CSV export has been shipped in v2.4. You can find the export button in the top-right of any report.' },
    ],
  },
  {
    id: 'TK-1005',
    subject: 'Account deactivation request',
    status: 'Closed',
    priority: 'Medium',
    assignee: 'Mike Torres',
    created: '2026-03-08T08:12:00Z',
    messages: [
      { from: 'customer', name: 'Sam Lee', time: '2026-03-08T08:12:00Z', text: 'Please deactivate my account effective immediately.' },
      { from: 'agent', name: 'Mike Torres', time: '2026-03-08T10:00:00Z', text: 'Your account has been deactivated. You can reactivate within 30 days by contacting support.' },
    ],
  },
  {
    id: 'TK-1006',
    subject: 'Scraping worker crash on large datasets',
    status: 'Open',
    priority: 'High',
    assignee: 'Sarah Chen',
    created: '2026-03-13T06:48:00Z',
    messages: [
      { from: 'customer', name: 'Ops Monitor', time: '2026-03-13T06:48:00Z', text: 'Worker pod scrapy-worker-7 OOM killed processing query with 10k+ results. Need memory limit increase or pagination fix.' },
    ],
  },
];

const statusConfig = {
  Open: { color: 'bg-accent-muted text-accent-text border-accent/30', icon: Circle },
  'In Progress': { color: 'bg-yellow-600/20 text-yellow-400 border-yellow-600/30', icon: Loader2 },
  Resolved: { color: 'bg-emerald-600/20 text-emerald-400 border-emerald-600/30', icon: CheckCircle2 },
  Closed: { color: 'bg-slate-600/20 text-slate-400 border-slate-600/30', icon: CheckCircle2 },
};

const priorityConfig = {
  Low: 'text-slate-400',
  Medium: 'text-yellow-400',
  High: 'text-red-400',
  Critical: 'text-red-400 animate-pulse',
};

export default function AdminSupport() {
  const [selected, setSelected] = useState(null);
  const [replyText, setReplyText] = useState('');

  const ticket = selected ? tickets.find((t) => t.id === selected) : null;

  const handleReply = () => {
    if (!replyText.trim()) return;
    alert(`Reply sent to ${ticket.id}: "${replyText.trim()}"`);
    setReplyText('');
  };

  if (ticket) {
    const sc = statusConfig[ticket.status];
    const StatusIcon = sc.icon;
    return (
      <div className="min-h-screen bg-[#0a0a0a]">
        <button
          onClick={() => setSelected(null)}
          className="flex items-center gap-2 text-slate-400 hover:text-white text-sm mb-6 cursor-pointer transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> Back to tickets
        </button>

        <div className="bg-[#111] border border-white/[0.06] rounded-xl p-6 mb-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
            <div>
              <span className="text-xs text-slate-500">{ticket.id}</span>
              <h2 className="text-xl font-bold text-white mt-1">{ticket.subject}</h2>
            </div>
            <div className="flex items-center gap-3">
              <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${sc.color}`}>
                <StatusIcon className="w-3 h-3" />
                {ticket.status}
              </span>
              <span className={`text-sm font-medium ${priorityConfig[ticket.priority]}`}>
                {ticket.priority === 'High' || ticket.priority === 'Critical' ? (
                  <span className="flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" />{ticket.priority}</span>
                ) : ticket.priority}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-4 text-sm text-slate-500">
            <span className="flex items-center gap-1"><User className="w-3.5 h-3.5" />{ticket.assignee}</span>
            <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5" />{new Date(ticket.created).toLocaleString()}</span>
          </div>
        </div>

        {/* Thread */}
        <div className="space-y-4 mb-6">
          {ticket.messages.map((msg, i) => (
            <div
              key={i}
              className={`bg-[#111] border border-white/[0.06] rounded-xl p-5 ${
                msg.from === 'agent' ? 'ml-8' : ''
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-white">{msg.name}</span>
                <span className="text-xs text-slate-500">{new Date(msg.time).toLocaleString()}</span>
              </div>
              <p className="text-sm text-slate-300 leading-relaxed">{msg.text}</p>
            </div>
          ))}
        </div>

        {/* Reply */}
        <div className="bg-[#111] border border-white/[0.06] rounded-xl p-5">
          <textarea
            rows={3}
            placeholder="Type your reply..."
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            className="w-full bg-[#0a0a0a] border border-white/[0.06] rounded-lg px-4 py-3 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-accent/50 resize-none"
          />
          <div className="flex justify-end mt-3">
            <button
              onClick={handleReply}
              className="flex items-center gap-2 bg-accent hover:bg-accent-hover text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors cursor-pointer"
            >
              <Send className="w-4 h-4" /> Send Reply
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Support Tickets</h1>
          <p className="text-slate-400 mt-1">Manage and respond to support requests</p>
        </div>
      </div>

      <div className="bg-[#111] border border-white/[0.06] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-white/[0.06]">
                {['ID', 'Subject', 'Status', 'Priority', 'Assignee', 'Created'].map((h) => (
                  <th key={h} className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tickets.map((t) => {
                const sc = statusConfig[t.status];
                const StatusIcon = sc.icon;
                return (
                  <tr
                    key={t.id}
                    onClick={() => setSelected(t.id)}
                    className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors cursor-pointer"
                  >
                    <td className="px-5 py-3 text-sm text-slate-400 font-mono">{t.id}</td>
                    <td className="px-5 py-3 text-sm text-white font-medium max-w-xs truncate">{t.subject}</td>
                    <td className="px-5 py-3 text-sm">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border ${sc.color}`}>
                        <StatusIcon className="w-3 h-3" />
                        {t.status}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-sm">
                      <span className={`font-medium ${priorityConfig[t.priority]}`}>
                        {t.priority}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-sm text-slate-300">{t.assignee}</td>
                    <td className="px-5 py-3 text-sm text-slate-400">{new Date(t.created).toLocaleDateString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
