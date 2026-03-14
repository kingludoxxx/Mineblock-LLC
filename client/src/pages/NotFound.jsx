import { Link } from 'react-router-dom';
import Button from '../components/ui/Button';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-bg-main flex items-center justify-center px-4">
      <div className="text-center">
        <p className="text-6xl font-bold text-text-faint">404</p>
        <h1 className="text-xl font-semibold text-text-primary mt-4">Page not found</h1>
        <p className="text-sm text-text-muted mt-2">
          The page you are looking for does not exist or has been moved.
        </p>
        <div className="mt-6">
          <Link to="/app/dashboard">
            <Button>Go to Dashboard</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
