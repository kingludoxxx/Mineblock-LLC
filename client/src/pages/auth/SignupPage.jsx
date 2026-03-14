import { useState } from 'react';
import { Link } from 'react-router-dom';
import Input from '../../components/ui/Input';
import Button from '../../components/ui/Button';

export default function SignupPage() {
  const [form, setForm] = useState({ name: '', email: '', password: '', confirmPassword: '' });
  const [loading, setLoading] = useState(false);

  const handleSubmit = (e) => {
    e.preventDefault();
    // TODO: implement signup
  };

  return (
    <div className="min-h-screen bg-bg-main flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-accent flex items-center justify-center text-white font-bold text-xl mx-auto mb-4">
            M
          </div>
          <h1 className="text-xl font-semibold text-text-primary">Create your account</h1>
          <p className="text-sm text-text-muted mt-1">Get started with Mineblock</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input label="Full name" placeholder="John Doe" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Input label="Email" type="email" placeholder="you@example.com" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <Input label="Password" type="password" placeholder="Min 8 characters" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <Input label="Confirm password" type="password" placeholder="Repeat password" value={form.confirmPassword} onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })} />
          <Button type="submit" loading={loading} className="w-full">Sign up</Button>
        </form>
        <p className="text-sm text-text-muted text-center mt-6">
          Already have an account?{' '}
          <Link to="/login" className="text-accent hover:underline">Log in</Link>
        </p>
      </div>
    </div>
  );
}
