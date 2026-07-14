import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { User, Lock, Eye, EyeOff, ArrowLeft, Loader2 } from 'lucide-react';
import api from '../services/api';

// Match ResetPassword.jsx conventions so styling and strength meter are
// visually consistent with the rest of the auth flow.
function getPasswordStrength(password) {
  let score = 0;
  if (password.length >= 8)         score++;
  if (/[A-Z]/.test(password))       score++;
  if (/[a-z]/.test(password))       score++;
  if (/[0-9]/.test(password))       score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;
  return score;
}
const strengthLabels = ['', 'Weak', 'Fair', 'Good', 'Strong', 'Very strong'];
const strengthColors = [
  'bg-white/10',
  'bg-red-500',
  'bg-orange-500',
  'bg-yellow-500',
  'bg-green-500',
  'bg-emerald-400',
];

export default function AcceptInvite() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const navigate = useNavigate();

  // Peek phase — we validate the token BEFORE showing the form so an
  // expired/bad link renders a friendly message instead of a form that
  // will just error on submit.
  const [peekLoading, setPeekLoading] = useState(true);
  const [peekError, setPeekError]     = useState('');
  const [inviteInfo, setInviteInfo]   = useState(null); // { email, inviterName }

  const [form, setForm] = useState({
    firstName: '', lastName: '', password: '', confirmPassword: '',
  });
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm]   = useState(false);
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(false);

  const strength = getPasswordStrength(form.password);

  useEffect(() => {
    let alive = true;
    async function peek() {
      if (!token) {
        setPeekError('This invite link is missing its token.');
        setPeekLoading(false);
        return;
      }
      try {
        const { data } = await api.get('/auth/invite-info', { params: { token } });
        if (!alive) return;
        setInviteInfo(data);
      } catch (err) {
        if (!alive) return;
        setPeekError(
          err?.response?.data?.error ||
          'This invite is invalid or has expired. Ask your admin to send a new one.',
        );
      } finally {
        if (alive) setPeekLoading(false);
      }
    }
    peek();
    return () => { alive = false; };
  }, [token]);

  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
    if (error) setError('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!form.firstName.trim() || !form.lastName.trim()) {
      setError('First and last name are required.');
      return;
    }
    if (form.password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (form.password !== form.confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      await api.post('/auth/accept-invite', {
        token,
        firstName: form.firstName.trim(),
        lastName:  form.lastName.trim(),
        password:  form.password,
      });
      // Cookies are set by the server; land on the dashboard signed in.
      navigate('/', { replace: true });
    } catch (err) {
      setError(
        err?.response?.data?.error ||
        'Something went wrong. Try again, or ask your admin to resend the invite.',
      );
      setLoading(false);
    }
  };

  // ---------------- render states ----------------

  if (peekLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-950 px-4">
        <div className="flex items-center gap-3 text-zinc-400">
          <Loader2 className="w-5 h-5 animate-spin" />
          Checking your invite…
        </div>
      </div>
    );
  }

  if (peekError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-950 px-4">
        <div className="max-w-md w-full bg-zinc-900 border border-white/10 rounded-2xl p-8 text-center">
          <h1 className="text-xl font-semibold text-white mb-3">Invite unavailable</h1>
          <p className="text-zinc-400 mb-6">{peekError}</p>
          <Link
            to="/login"
            className="inline-flex items-center gap-2 text-sm text-zinc-300 hover:text-white"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950 px-4">
      <div className="max-w-md w-full bg-zinc-900 border border-white/10 rounded-2xl p-8">
        <h1 className="text-2xl font-semibold text-white mb-1">Welcome</h1>
        <p className="text-zinc-400 text-sm mb-6">
          <span className="text-white">{inviteInfo.inviterName}</span> invited you to
          the Mineblock Dashboard as <span className="text-white">{inviteInfo.email}</span>.
          Set up your account below.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-zinc-400">First name</span>
              <div className="relative mt-1">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                <input
                  type="text"
                  name="firstName"
                  value={form.firstName}
                  onChange={handleChange}
                  autoComplete="given-name"
                  required
                  className="w-full pl-9 pr-3 py-2 bg-zinc-950 border border-white/10 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-500"
                  placeholder="Jane"
                />
              </div>
            </label>
            <label className="block">
              <span className="text-xs text-zinc-400">Last name</span>
              <input
                type="text"
                name="lastName"
                value={form.lastName}
                onChange={handleChange}
                autoComplete="family-name"
                required
                className="w-full mt-1 px-3 py-2 bg-zinc-950 border border-white/10 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-500"
                placeholder="Doe"
              />
            </label>
          </div>

          <label className="block">
            <span className="text-xs text-zinc-400">Password</span>
            <div className="relative mt-1">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
              <input
                type={showPassword ? 'text' : 'password'}
                name="password"
                value={form.password}
                onChange={handleChange}
                autoComplete="new-password"
                required
                minLength={8}
                className="w-full pl-9 pr-10 py-2 bg-zinc-950 border border-white/10 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-500"
                placeholder="At least 8 characters"
              />
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                tabIndex={-1}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            {form.password && (
              <div className="mt-2">
                <div className="flex gap-1">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <div key={i} className={`h-1 flex-1 rounded ${i <= strength ? strengthColors[strength] : 'bg-white/5'}`} />
                  ))}
                </div>
                <p className="text-xs text-zinc-500 mt-1">{strengthLabels[strength]}</p>
              </div>
            )}
          </label>

          <label className="block">
            <span className="text-xs text-zinc-400">Confirm password</span>
            <div className="relative mt-1">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
              <input
                type={showConfirm ? 'text' : 'password'}
                name="confirmPassword"
                value={form.confirmPassword}
                onChange={handleChange}
                autoComplete="new-password"
                required
                minLength={8}
                className="w-full pl-9 pr-10 py-2 bg-zinc-950 border border-white/10 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-500"
                placeholder="Repeat password"
              />
              <button
                type="button"
                onClick={() => setShowConfirm((s) => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                tabIndex={-1}
              >
                {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </label>

          {error && (
            <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-3">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-white text-zinc-950 font-medium rounded-lg hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {loading ? (<><Loader2 className="w-4 h-4 animate-spin" /> Setting up…</>) : 'Accept invite & sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
