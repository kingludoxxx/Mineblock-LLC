import { useState } from 'react';
import { Link } from 'react-router-dom';
import Input from '../../components/ui/Input';
import Button from '../../components/ui/Button';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);

  const handleSubmit = (e) => {
    e.preventDefault();
    // TODO: implement
    setSent(true);
  };

  return (
    <div className="min-h-screen bg-bg-main flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-xl font-semibold text-text-primary">Reset your password</h1>
          <p className="text-sm text-text-muted mt-1">We will send you a reset link</p>
        </div>
        {sent ? (
          <div className="text-center">
            <p className="text-sm text-text-muted">Check your email for a reset link.</p>
            <Link to="/login" className="text-sm text-accent hover:underline mt-4 inline-block">Back to login</Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input label="Email" type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <Button type="submit" className="w-full">Send reset link</Button>
          </form>
        )}
        <p className="text-sm text-text-muted text-center mt-6">
          <Link to="/login" className="text-accent hover:underline">Back to login</Link>
        </p>
      </div>
    </div>
  );
}
