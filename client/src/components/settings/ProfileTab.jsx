import { useState } from 'react';
import { Camera, Save, User } from 'lucide-react';

export default function ProfileTab() {
  const [profile, setProfile] = useState({
    fullName: 'John Doe',
    email: 'john@mineblock.io',
    timezone: 'America/New_York',
  });
  const [avatarHover, setAvatarHover] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const timezones = [
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'America/Anchorage',
    'Pacific/Honolulu',
    'Europe/London',
    'Europe/Paris',
    'Europe/Berlin',
    'Asia/Tokyo',
    'Asia/Shanghai',
    'Asia/Kolkata',
    'Australia/Sydney',
    'Pacific/Auckland',
  ];

  const handleSave = async () => {
    setSaving(true);
    await new Promise((r) => setTimeout(r, 800));
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleAvatarUpload = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {};
    input.click();
  };

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-white mb-1">Profile</h2>
        <p className="text-sm text-white/40">Manage your personal information</p>
      </div>

      {/* Avatar */}
      <div className="flex items-center gap-6">
        <div
          className="relative w-24 h-24 rounded-full bg-white/[0.06] border border-white/[0.08] flex items-center justify-center cursor-pointer overflow-hidden"
          onMouseEnter={() => setAvatarHover(true)}
          onMouseLeave={() => setAvatarHover(false)}
          onClick={handleAvatarUpload}
        >
          <User className="w-10 h-10 text-white/30" />
          {avatarHover && (
            <div className="absolute inset-0 bg-black/60 flex items-center justify-center transition-opacity">
              <Camera className="w-6 h-6 text-white" />
            </div>
          )}
        </div>
        <div>
          <p className="text-sm font-medium text-white">Profile Photo</p>
          <p className="text-xs text-white/40 mt-1">Click to upload. JPG, PNG up to 2MB.</p>
        </div>
      </div>

      {/* Full Name */}
      <div>
        <label className="block text-sm font-medium text-white/70 mb-2">Full Name</label>
        <input
          type="text"
          value={profile.fullName}
          onChange={(e) => setProfile({ ...profile, fullName: e.target.value })}
          className="w-full px-4 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-lg text-white text-sm
            focus:outline-none focus:border-white/[0.2] transition-colors placeholder-white/20"
          placeholder="Enter your full name"
        />
      </div>

      {/* Email */}
      <div>
        <label className="block text-sm font-medium text-white/70 mb-2">Email</label>
        <input
          type="email"
          value={profile.email}
          readOnly
          className="w-full px-4 py-2.5 bg-white/[0.02] border border-white/[0.06] rounded-lg text-white/50 text-sm
            cursor-not-allowed"
        />
        <p className="text-xs text-white/30 mt-1.5">Email cannot be changed. Contact support for assistance.</p>
      </div>

      {/* Timezone */}
      <div>
        <label className="block text-sm font-medium text-white/70 mb-2">Timezone</label>
        <select
          value={profile.timezone}
          onChange={(e) => setProfile({ ...profile, timezone: e.target.value })}
          className="w-full px-4 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-lg text-white text-sm
            focus:outline-none focus:border-white/[0.2] transition-colors appearance-none cursor-pointer"
        >
          {timezones.map((tz) => (
            <option key={tz} value={tz} className="bg-[#111] text-white">
              {tz.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
      </div>

      {/* Save */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg
            transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {saving ? (
            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          ) : (
            <Save className="w-4 h-4" />
          )}
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
        {saved && <span className="text-sm text-emerald-400">Profile updated successfully</span>}
      </div>
    </div>
  );
}
