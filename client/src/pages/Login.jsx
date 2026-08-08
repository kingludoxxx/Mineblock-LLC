import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Mail, Lock, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { BRAND_SHORT_NAME, BRAND_LOGO_WHITE } from '../config/brand';

// Minimal, theme-aware login page. Every color goes through CSS vars so
// dark (Mineblock) / light (Puure) themes both look right without branch
// logic. No background animation — clean centered card.
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
      const status = err.response?.status;
      const data = err.response?.data;
      const rawMsg = data?.error?.message || (typeof data?.error === 'string' ? data.error : null) || data?.message;
      setError(
        status >= 500
          ? 'Service temporarily unavailable. Please try again later.'
          : rawMsg || 'Invalid credentials. Please try again.',
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-bg-main flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        {/* Brand */}
        <div className="text-center mb-10">
          <img
            src={BRAND_LOGO_WHITE}
            alt={BRAND_SHORT_NAME}
            className="h-10 w-auto mx-auto mb-5"
          />
          <p className="text-text-muted text-sm">Sign in to your account</p>
        </div>

        {/* Card */}
        <div className="bg-bg-card border border-border-default rounded-2xl p-8 shadow-sm">
          {error && (
            <div className="mb-5 rounded-lg bg-red-500/10 border border-red-500/20 px-4 py-3 text-red-500 text-sm">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
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
                  placeholder={`you@${BRAND_SHORT_NAME?.toLowerCase() || 'example'}.co`}
                  className="bg-bg-elevated border border-border-default rounded-lg pl-10 pr-3 py-2.5 text-text-primary text-sm w-full placeholder:text-text-faint focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition"
                />
              </div>
            </div>

            <div>
              <label className="block text-text-muted text-sm mb-1.5">Password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-faint" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  name="password"
                  value={form.password}
                  onChange={handleChange}
                  required
                  placeholder="••••••••"
                  className="bg-bg-elevated border border-border-default rounded-lg pl-10 pr-10 py-2.5 text-text-primary text-sm w-full placeholder:text-text-faint focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-text-faint hover:text-text-muted transition cursor-pointer"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div className="flex justify-end pt-1">
              <Link
                to="/forgot-password"
                className="text-text-muted hover:text-text-primary text-sm transition"
              >
                Forgot password?
              </Link>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-bg-main font-semibold rounded-lg px-4 py-2.5 w-full text-sm transition flex items-center justify-center gap-2 cursor-pointer mt-2"
            >
              {loading ? (
                <>
                  <span className="w-4 h-4 border-2 border-bg-main/30 border-t-bg-main rounded-full animate-spin" />
                  Signing in...
                </>
              ) : (
                'Sign In'
              )}
            </button>
          </form>

          <p className="text-center text-text-muted text-sm mt-6">
            Don&apos;t have an account?{' '}
            <Link to="/signup" className="text-text-primary hover:opacity-70 font-medium transition">
              Sign up
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
