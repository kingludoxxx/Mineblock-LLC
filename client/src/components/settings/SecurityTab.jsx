import { useState } from 'react';
import { Shield, Monitor, Smartphone, Lock, Eye, EyeOff, X } from 'lucide-react';

export default function SecurityTab() {
  const [passwords, setPasswords] = useState({ current: '', newPass: '', confirm: '' });
  const [showPasswords, setShowPasswords] = useState({ current: false, newPass: false, confirm: false });
  const [twoFactor, setTwoFactor] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [message, setMessage] = useState('');

  const sessions = [
    { id: 1, browser: 'Chrome on macOS', ip: '192.168.1.42', lastActive: '2 minutes ago', current: true, icon: Monitor },
    { id: 2, browser: 'Safari on iPhone', ip: '10.0.0.15', lastActive: '1 hour ago', current: false, icon: Smartphone },
    { id: 3, browser: 'Firefox on Windows', ip: '172.16.0.88', lastActive: '3 days ago', current: false, icon: Monitor },
  ];

  const getPasswordStrength = (pass) => {
    if (!pass) return { level: 0, label: '', color: '' };
    let score = 0;
    if (pass.length >= 8) score++;
    if (pass.length >= 12) score++;
    if (/[A-Z]/.test(pass)) score++;
    if (/[0-9]/.test(pass)) score++;
    if (/[^A-Za-z0-9]/.test(pass)) score++;

    if (score <= 1) return { level: 1, label: 'Weak', color: 'bg-red-500' };
    if (score <= 2) return { level: 2, label: 'Fair', color: 'bg-orange-500' };
    if (score <= 3) return { level: 3, label: 'Good', color: 'bg-yellow-500' };
    if (score <= 4) return { level: 4, label: 'Strong', color: 'bg-emerald-500' };
    return { level: 5, label: 'Very Strong', color: 'bg-emerald-400' };
  };

  const strength = getPasswordStrength(passwords.newPass);

  const handleUpdatePassword = async () => {
    if (passwords.newPass !== passwords.confirm) {
      setMessage('Passwords do not match');
      return;
    }
    setUpdating(true);
    await new Promise((r) => setTimeout(r, 800));
    setUpdating(false);
    setPasswords({ current: '', newPass: '', confirm: '' });
    setMessage('Password updated successfully');
    setTimeout(() => setMessage(''), 3000);
  };

  const PasswordInput = ({ label, field }) => (
    <div>
      <label className="block text-sm font-medium text-white/70 mb-2">{label}</label>
      <div className="relative">
        <input
          type={showPasswords[field] ? 'text' : 'password'}
          value={passwords[field]}
          onChange={(e) => setPasswords({ ...passwords, [field]: e.target.value })}
          className="w-full px-4 py-2.5 pr-10 bg-white/[0.04] border border-white/[0.08] rounded-lg text-white text-sm
            focus:outline-none focus:border-white/[0.2] transition-colors"
          placeholder={`Enter ${label.toLowerCase()}`}
        />
        <button
          type="button"
          onClick={() => setShowPasswords({ ...showPasswords, [field]: !showPasswords[field] })}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60 cursor-pointer"
        >
          {showPasswords[field] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );

  return (
    <div className="max-w-2xl space-y-10">
      <div>
        <h2 className="text-lg font-semibold text-white mb-1">Security</h2>
        <p className="text-sm text-white/40">Manage your password, 2FA, and active sessions</p>
      </div>

      {message && (
        <div className={`p-3 rounded-lg text-sm border ${
          message.includes('success')
            ? 'bg-emerald-600/20 border-emerald-600/30 text-emerald-400'
            : 'bg-red-600/20 border-red-600/30 text-red-400'
        }`}>
          {message}
        </div>
      )}

      {/* Change Password */}
      <div className="bg-[#111] rounded-xl border border-white/[0.06] p-6 space-y-5">
        <div className="flex items-center gap-2 mb-2">
          <Lock className="w-5 h-5 text-white/50" />
          <h3 className="text-sm font-semibold text-white">Change Password</h3>
        </div>

        <PasswordInput label="Current Password" field="current" />
        <PasswordInput label="New Password" field="newPass" />

        {/* Strength indicator */}
        {passwords.newPass && (
          <div className="space-y-1.5">
            <div className="flex gap-1">
              {[1, 2, 3, 4, 5].map((i) => (
                <div
                  key={i}
                  className={`h-1 flex-1 rounded-full transition-colors ${
                    i <= strength.level ? strength.color : 'bg-white/[0.06]'
                  }`}
                />
              ))}
            </div>
            <p className="text-xs text-white/40">Password strength: <span className="text-white/60">{strength.label}</span></p>
          </div>
        )}

        <PasswordInput label="Confirm Password" field="confirm" />

        <button
          onClick={handleUpdatePassword}
          disabled={updating || !passwords.current || !passwords.newPass || !passwords.confirm}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg
            transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {updating ? (
            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          ) : null}
          {updating ? 'Updating...' : 'Update Password'}
        </button>
      </div>

      {/* Two-Factor Authentication */}
      <div className="bg-[#111] rounded-xl border border-white/[0.06] p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Shield className="w-5 h-5 text-white/50" />
            <div>
              <h3 className="text-sm font-semibold text-white">Two-Factor Authentication</h3>
              <p className="text-xs text-white/40 mt-0.5">Add an extra layer of security to your account</p>
            </div>
          </div>
          <button
            onClick={() => setTwoFactor(!twoFactor)}
            className={`relative w-11 h-6 rounded-full transition-colors cursor-pointer ${
              twoFactor ? 'bg-blue-600' : 'bg-white/[0.1]'
            }`}
          >
            <div
              className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                twoFactor ? 'translate-x-5.5' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
      </div>

      {/* Active Sessions */}
      <div className="bg-[#111] rounded-xl border border-white/[0.06] p-6">
        <h3 className="text-sm font-semibold text-white mb-4">Active Sessions</h3>
        <div className="space-y-3">
          {sessions.map((session) => (
            <div
              key={session.id}
              className="flex items-center justify-between p-3 rounded-lg bg-white/[0.02] border border-white/[0.04]"
            >
              <div className="flex items-center gap-3">
                <session.icon className="w-5 h-5 text-white/40" />
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-white">{session.browser}</span>
                    {session.current && (
                      <span className="px-1.5 py-0.5 text-[10px] font-medium bg-emerald-500/20 text-emerald-400 rounded">
                        Current
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-white/40 mt-0.5">
                    {session.ip} &middot; {session.lastActive}
                  </p>
                </div>
              </div>
              {!session.current && (
                <button className="text-xs text-red-400 hover:text-red-300 transition-colors cursor-pointer flex items-center gap-1">
                  <X className="w-3 h-3" />
                  Revoke
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
