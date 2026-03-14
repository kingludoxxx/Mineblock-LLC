import { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Mail } from 'lucide-react';
import api from '../services/api';

export default function VerifyEmail() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  const [status, setStatus] = useState('loading'); // loading | success | error
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setMessage('Verification link is invalid. No token provided.');
      return;
    }

    let cancelled = false;

    async function verify() {
      try {
        const res = await api.get(`/auth/verify-email?token=${token}`);
        if (!cancelled) {
          setStatus('success');
          setMessage(
            res.data?.message || 'Your email has been verified successfully.',
          );
        }
      } catch (err) {
        if (!cancelled) {
          setStatus('error');
          setMessage(
            err.response?.data?.message ||
              'Verification failed. The link may be expired or invalid.',
          );
        }
      }
    }

    verify();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center px-4">
      <div className="bg-[#111] border border-white/[0.08] rounded-xl p-8 w-full max-w-md text-center">
        {/* Brand */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white tracking-tight">
            Mineblock
          </h1>
        </div>

        {status === 'loading' && (
          <>
            <div className="w-12 h-12 rounded-full bg-blue-500/10 border border-blue-500/20 flex items-center justify-center mx-auto mb-4">
              <span className="w-6 h-6 border-2 border-blue-400/30 border-t-blue-400 rounded-full animate-spin" />
            </div>
            <h2 className="text-white font-medium mb-2">
              Verifying your email
            </h2>
            <p className="text-white/50 text-sm">
              Please wait while we verify your email address...
            </p>
          </>
        )}

        {status === 'success' && (
          <>
            <div className="w-12 h-12 rounded-full bg-green-500/10 border border-green-500/20 flex items-center justify-center mx-auto mb-4">
              <Mail className="w-6 h-6 text-green-400" />
            </div>
            <h2 className="text-white font-medium mb-2">Email verified</h2>
            <p className="text-white/50 text-sm mb-6">{message}</p>
            <Link
              to="/dashboard"
              className="inline-block bg-blue-600 hover:bg-blue-700 text-white rounded-md px-6 py-2 text-sm font-medium transition"
            >
              Continue to Dashboard
            </Link>
          </>
        )}

        {status === 'error' && (
          <>
            <div className="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto mb-4">
              <Mail className="w-6 h-6 text-red-400" />
            </div>
            <h2 className="text-white font-medium mb-2">
              Verification failed
            </h2>
            <p className="text-white/50 text-sm mb-6">{message}</p>
            <Link
              to="/login"
              className="text-blue-400 hover:text-blue-300 text-sm transition"
            >
              Go to sign in
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
