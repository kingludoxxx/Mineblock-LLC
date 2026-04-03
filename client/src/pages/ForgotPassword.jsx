import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Mail, ArrowLeft } from 'lucide-react';
import api from '../services/api';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      await api.post('/auth/forgot-password', { email });
      setSubmitted(true);
    } catch (err) {
      setError(
        err.response?.data?.message ||
          'Something went wrong. Please try again.',
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center px-4">
      <div className="bg-[#111] border border-white/[0.08] rounded-xl p-8 w-full max-w-md">
        {/* Brand */}
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-white tracking-tight">
            Mineblock
          </h1>
          <p className="text-white/50 text-sm mt-1">Reset your password</p>
        </div>

        {submitted ? (
          /* Success state */
          <div className="text-center">
            <div className="w-12 h-12 rounded-full bg-green-500/10 border border-green-500/20 flex items-center justify-center mx-auto mb-4">
              <Mail className="w-6 h-6 text-green-400" />
            </div>
            <h2 className="text-white font-medium mb-2">Check your email</h2>
            <p className="text-white/50 text-sm mb-6">
              We sent a password reset link to{' '}
              <span className="text-white/70">{email}</span>. Check your inbox
              and follow the instructions.
            </p>
            <Link
              to="/login"
              className="inline-flex items-center gap-2 text-accent-text hover:text-accent text-sm transition"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to sign in
            </Link>
          </div>
        ) : (
          <>
            <p className="text-white/50 text-sm mb-6 text-center">
              Enter the email address associated with your account and
              we&apos;ll send you a link to reset your password.
            </p>

            {/* Error */}
            {error && (
              <div className="mb-4 rounded-md bg-red-500/10 border border-red-500/20 px-4 py-3 text-red-400 text-sm">
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-white/60 text-sm mb-1.5">
                  Email
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      if (error) setError('');
                    }}
                    required
                    placeholder="you@example.com"
                    className="bg-white/[0.04] border border-white/[0.08] rounded-md pl-10 pr-3 py-2 text-white text-sm w-full placeholder:text-white/25 focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/25 transition"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-md px-4 py-2 w-full text-sm font-medium transition flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Sending...
                  </>
                ) : (
                  'Send Reset Link'
                )}
              </button>
            </form>

            <div className="text-center mt-6">
              <Link
                to="/login"
                className="inline-flex items-center gap-2 text-accent-text hover:text-accent text-sm transition"
              >
                <ArrowLeft className="w-4 h-4" />
                Back to sign in
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
