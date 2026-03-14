import { useAuth } from '../hooks/useAuth';
import Card from '../components/ui/Card';

export default function Dashboard() {
  const { user } = useAuth();

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-white">
          Welcome back{(user?.name || user?.firstName) ? `, ${user.name || user.firstName}` : ''}
        </h1>
        <p className="text-sm text-text-muted mt-1">
          Here is an overview of your workspace
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <p className="text-xs text-text-muted font-medium uppercase tracking-wider">Active Campaigns</p>
          <p className="text-2xl font-bold text-text-primary mt-2">--</p>
        </Card>
        <Card>
          <p className="text-xs text-text-muted font-medium uppercase tracking-wider">Total Spend</p>
          <p className="text-2xl font-bold text-text-primary mt-2">--</p>
        </Card>
        <Card>
          <p className="text-xs text-text-muted font-medium uppercase tracking-wider">Revenue</p>
          <p className="text-2xl font-bold text-text-primary mt-2">--</p>
        </Card>
        <Card>
          <p className="text-xs text-text-muted font-medium uppercase tracking-wider">ROAS</p>
          <p className="text-2xl font-bold text-text-primary mt-2">--</p>
        </Card>
      </div>

      <Card>
        <p className="text-sm text-text-muted">Dashboard widgets and analytics coming soon.</p>
      </Card>
    </div>
  );
}
