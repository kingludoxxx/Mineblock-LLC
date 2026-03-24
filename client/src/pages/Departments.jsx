import { useState, useEffect } from 'react';
import { Building2, Users } from 'lucide-react';
import Badge from '../components/shared/Badge';
import LoadingSpinner from '../components/shared/LoadingSpinner';
import PermissionGate from '../components/shared/PermissionGate';
import api from '../services/api';

export default function Departments() {
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get('/departments')
      .then((res) => setDepartments(res.data.departments || []))
      .catch(() => setDepartments([]))
      .finally(() => setLoading(false));
  }, []);

  const toggleDepartment = async (id, isActive) => {
    try {
      await api.patch(`/departments/${id}/status`);
      setDepartments((prev) =>
        prev.map((d) => (d.id === id ? { ...d, is_active: !isActive } : d))
      );
    } catch {
      // ignore
    }
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Departments</h1>
      </div>
      {departments.length === 0 ? (
        <div className="bg-slate-800 rounded-xl border border-slate-700 p-12 text-center">
          <Building2 className="w-12 h-12 text-slate-600 mx-auto mb-4" />
          <p className="text-slate-400">No departments found</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {departments.map((dept) => (
            <div
              key={dept.id}
              className="bg-slate-800 rounded-xl border border-slate-700 p-6"
            >
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-blue-600/20 rounded-lg">
                    <Building2 className="w-5 h-5 text-blue-400" />
                  </div>
                  <div>
                    <h3 className="text-white font-medium">{dept.name}</h3>
                    <p className="text-slate-400 text-sm">{dept.code}</p>
                  </div>
                </div>
                <Badge color={dept.is_active ? 'green' : 'red'}>
                  {dept.is_active ? 'Active' : 'Inactive'}
                </Badge>
              </div>
              {dept.description && (
                <p className="text-slate-400 text-sm mb-4">{dept.description}</p>
              )}
              <div className="flex items-center justify-between pt-4 border-t border-slate-700">
                <div className="flex items-center gap-2 text-sm text-slate-400">
                  <Users className="w-4 h-4" />
                  <span>{dept.member_count ?? 0} members</span>
                </div>
                <PermissionGate permission="departments:manage">
                  <button
                    onClick={() => toggleDepartment(dept.id, dept.is_active)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer
                      ${dept.is_active ? 'bg-blue-600' : 'bg-slate-600'}`}
                  >
                    <span
                      className={`inline-block h-4 w-4 rounded-full bg-white transition-transform
                        ${dept.is_active ? 'translate-x-6' : 'translate-x-1'}`}
                    />
                  </button>
                </PermissionGate>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
