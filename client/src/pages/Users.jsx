import { useState, useEffect } from 'react';
import { Search, UserPlus } from 'lucide-react';
import DataTable from '../components/shared/DataTable';
import Badge from '../components/shared/Badge';
import Button from '../components/shared/Button';
import LoadingSpinner from '../components/shared/LoadingSpinner';
import PermissionGate from '../components/shared/PermissionGate';
import api from '../services/api';

const columns = [
  { key: 'name', label: 'Name', render: (row) => `${row.firstName} ${row.lastName}` },
  { key: 'email', label: 'Email' },
  {
    key: 'roles',
    label: 'Roles',
    render: (row) => (
      <div className="flex gap-1 flex-wrap">
        {(row.roles || []).map((r) => (
          <Badge key={r} role={r} />
        ))}
      </div>
    ),
  },
  {
    key: 'status',
    label: 'Status',
    render: (row) => (
      <Badge color={row.isActive ? 'green' : 'red'}>
        {row.isActive ? 'Active' : 'Inactive'}
      </Badge>
    ),
  },
  {
    key: 'createdAt',
    label: 'Created',
    render: (row) => new Date(row.createdAt).toLocaleDateString(),
  },
];

export default function UsersPage() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  useEffect(() => {
    setLoading(true);
    api
      .get('/users', { params: { page, search, limit: 10 } })
      .then((res) => {
        setUsers(res.data.users || []);
        const total = res.data.total || 0;
        setTotalPages(Math.ceil(total / 10) || 1);
      })
      .catch(() => setUsers([]))
      .finally(() => setLoading(false));
  }, [page, search]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Users</h1>
        <PermissionGate permission="users:create">
          <Button>
            <UserPlus className="w-4 h-4" />
            Add User
          </Button>
        </PermissionGate>
      </div>
      <div className="bg-slate-800 rounded-xl border border-slate-700">
        <div className="p-4 border-b border-slate-700">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search users..."
              className="w-full pl-10 pr-4 py-2 bg-slate-900 border border-slate-600 rounded-lg
                text-white placeholder-slate-500 text-sm focus:outline-none focus:border-accent/50"
            />
          </div>
        </div>
        {loading ? (
          <LoadingSpinner />
        ) : (
          <DataTable
            columns={columns}
            data={users}
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
          />
        )}
      </div>
    </div>
  );
}
