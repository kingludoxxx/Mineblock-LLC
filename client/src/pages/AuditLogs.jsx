import { useState, useEffect } from 'react';
import { Filter } from 'lucide-react';
import DataTable from '../components/shared/DataTable';
import Badge from '../components/shared/Badge';
import LoadingSpinner from '../components/shared/LoadingSpinner';
import api from '../services/api';

const actionColors = {
  CREATE: 'green',
  UPDATE: 'blue',
  DELETE: 'red',
  LOGIN: 'purple',
  LOGOUT: 'slate',
};

const columns = [
  {
    key: 'timestamp',
    label: 'Timestamp',
    render: (row) => new Date(row.timestamp || row.createdAt).toLocaleString(),
  },
  { key: 'user', label: 'User', render: (row) => row.userEmail || row.user?.email || 'System' },
  {
    key: 'action',
    label: 'Action',
    render: (row) => (
      <Badge color={actionColors[row.action] || 'slate'}>{row.action}</Badge>
    ),
  },
  { key: 'resource', label: 'Resource' },
  { key: 'details', label: 'Details', render: (row) => row.details || '-' },
];

export default function AuditLogs() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [actionFilter, setActionFilter] = useState('');

  useEffect(() => {
    setLoading(true);
    const params = { page, limit: 15 };
    if (actionFilter) params.action = actionFilter;
    api
      .get('/audit-logs', { params })
      .then((res) => {
        setLogs(res.data.logs || []);
        const total = res.data.total || 0;
        const limit = res.data.limit || 15;
        setTotalPages(Math.ceil(total / limit) || 1);
      })
      .catch(() => setLogs([]))
      .finally(() => setLoading(false));
  }, [page, actionFilter]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Audit Logs</h1>
      </div>
      <div className="bg-slate-800 rounded-xl border border-slate-700">
        <div className="p-4 border-b border-slate-700 flex items-center gap-4">
          <div className="flex items-center gap-2 text-slate-400">
            <Filter className="w-4 h-4" />
            <span className="text-sm">Filter:</span>
          </div>
          <select
            value={actionFilter}
            onChange={(e) => {
              setActionFilter(e.target.value);
              setPage(1);
            }}
            className="bg-slate-900 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-white
              focus:outline-none focus:border-accent/50 cursor-pointer"
          >
            <option value="">All Actions</option>
            <option value="CREATE">Create</option>
            <option value="UPDATE">Update</option>
            <option value="DELETE">Delete</option>
            <option value="LOGIN">Login</option>
            <option value="LOGOUT">Logout</option>
          </select>
        </div>
        {loading ? (
          <LoadingSpinner />
        ) : (
          <DataTable
            columns={columns}
            data={logs}
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
          />
        )}
      </div>
    </div>
  );
}
