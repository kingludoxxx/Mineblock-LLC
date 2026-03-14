import { Link } from 'react-router-dom';
import Button from '../../components/ui/Button';

export default function VerifyEmailPage() {
  return (
    <div className="min-h-screen bg-bg-main flex items-center justify-center px-4">
      <div className="w-full max-w-sm text-center">
        <div className="w-12 h-12 rounded-xl bg-accent flex items-center justify-center text-white font-bold text-xl mx-auto mb-4">
          M
        </div>
        <h1 className="text-xl font-semibold text-text-primary">Verify your email</h1>
        <p className="text-sm text-text-muted mt-2">
          We sent a verification link to your email address. Please check your inbox and click the link to verify.
        </p>
        <div className="mt-6">
          <Link to="/login">
            <Button variant="secondary">Back to login</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
