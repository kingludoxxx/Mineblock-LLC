import { useState, useEffect } from 'react';
import { Users, Building2, ScrollText, Shield } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import StatCard from '../components/shared/StatCard';
import LoadingSpinner from '../components/shared/LoadingSpinner';
import api from '../services/api';

export default function Dashboard() {
  const { user } = useAuth();
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get('/dashboard/stats')
      .then((res) => setStats(res.data))
      .catch(() =>
        setStats({
          totalUsers: 0,
          totalDepartments: 0,
          recentAuditLogs: 0,
          activeRoles: 0,
        })
      )
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">
          Welcome back, {user?.firstName || 'Admin'}
        </h1>
        <p className="text-slate-400 mt-1">Here is what is happening in your organization.</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard
          icon={Users}
          label="Total Users"
          value={stats?.totalUsers ?? 0}
          trend={12}
        />
        <StatCard
          icon={Building2}
          label="Departments"
          value={stats?.totalDepartments ?? 0}
          trend={4}
        />
        <StatCard
          icon={ScrollText}
          label="Audit Logs"
          value={stats?.recentAuditLogs ?? 0}
          trend={-2}
        />
        <StatCard
          icon={Shield}
          label="Active Roles"
          value={stats?.activeRoles ?? 0}
        />
      </div>
    </div>
  );
}
