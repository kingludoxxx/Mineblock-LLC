import { usePermissions } from '../../hooks/usePermissions';
import { Lock } from 'lucide-react';

export default function PageGate({ permission, children }) {
  const { hasPermission } = usePermissions();

  if (!permission) return children;
  if (hasPermission(permission)) return children;

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-gray-400">
      <Lock className="w-16 h-16 mb-4 text-gray-600" />
      <h2 className="text-xl font-semibold text-white mb-2">Access Restricted</h2>
      <p className="text-gray-500">You don't have permission to view this page.</p>
      <p className="text-gray-600 text-sm mt-1">Contact your admin to request access.</p>
    </div>
  );
}
