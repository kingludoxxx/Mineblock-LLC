import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Mail, Lock, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';

export default function Login() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [form, setForm] = useState({ email: '', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
    if (error) setError('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      await login(form.email, form.password);
      navigate('/app/dashboard');
    } catch (err) {
      setError(
        err.response?.data?.error || err.response?.data?.message || 'Invalid credentials. Please try again.',
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-bg-main flex items-center justify-center px-4">
      <div className="bg-bg-card border border-border-default rounded-xl p-8 w-full max-w-md">
        {/* Brand */}
        <div className="text-center mb-8">
          <img src="/logo-white.png" alt="Mineblock" className="h-6 w-auto mx-auto mb-4" />
          <p className="text-text-muted text-sm mt-1">
            Sign in to your account
          </p>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 rounded-md bg-red-500/10 border border-red-500/20 px-4 py-3 text-red-400 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Email */}
          <div>
            <label className="block text-text-muted text-sm mb-1.5">Email</label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-faint" />
              <input
                type="email"
                name="email"
                value={form.email}
                onChange={handleChange}
                required
                placeholder="you@example.com"
                className="bg-bg-elevated border border-border-default rounded-lg pl-10 pr-3 py-2 text-text-primary text-sm w-full placeholder:text-text-faint focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/25 transition"
              />
            </div>
          </div>

          {/* Password */}
          <div>
            <label className="block text-text-muted text-sm mb-1.5">
              Password
            </label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-faint" />
              <input
                type={showPassword ? 'text' : 'password'}
                name="password"
                value={form.password}
                onChange={handleChange}
                required
                placeholder="••••••••"
                className="bg-bg-elevated border border-border-default rounded-lg pl-10 pr-10 py-2 text-text-primary text-sm w-full placeholder:text-text-faint focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/25 transition"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-text-faint hover:text-text-muted transition cursor-pointer"
              >
                {showPassword ? (
                  <EyeOff className="w-4 h-4" />
                ) : (
                  <Eye className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>

          {/* Forgot password */}
          <div className="flex justify-end">
            <Link
              to="/forgot-password"
              className="text-accent hover:text-accent-hover text-sm transition"
            >
              Forgot password?
            </Link>
          </div>

          {/* Submit */}
          <button
            type="submit"
            disabled={loading}
            className="bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg px-4 py-2 w-full text-sm font-medium transition flex items-center justify-center gap-2 cursor-pointer"
          >
            {loading ? (
              <>
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Signing in...
              </>
            ) : (
              'Sign In'
            )}
          </button>
        </form>

        {/* Sign up link */}
        <p className="text-center text-text-muted text-sm mt-6">
          Don&apos;t have an account?{' '}
          <Link
            to="/signup"
            className="text-accent hover:underline transition"
          >
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}
