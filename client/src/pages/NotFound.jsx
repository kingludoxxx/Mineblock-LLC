import { Link } from 'react-router-dom';
import { Home } from 'lucide-react';
import Button from '../components/shared/Button';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
      <div className="text-center">
        <h1 className="text-7xl font-bold text-slate-700">404</h1>
        <h2 className="text-2xl font-semibold text-white mt-4">Page Not Found</h2>
        <p className="text-slate-400 mt-2 mb-8">
          The page you are looking for does not exist or has been moved.
        </p>
        <Link to="/dashboard">
          <Button>
            <Home className="w-4 h-4" />
            Back to Dashboard
          </Button>
        </Link>
      </div>
    </div>
  );
}
