import { useState, useEffect } from 'react';
import { Save } from 'lucide-react';
import Button from '../components/shared/Button';
import LoadingSpinner from '../components/shared/LoadingSpinner';
import api from '../services/api';

export default function Settings() {
  const [settings, setSettings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    api
      .get('/settings')
      .then((res) => setSettings(res.data.settings || []))
      .catch(() => setSettings([]))
      .finally(() => setLoading(false));
  }, []);

  const updateSetting = (key, value) => {
    setSettings((prev) =>
      prev.map((s) => (s.key === key ? { ...s, value } : s))
    );
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage('');
    try {
      await api.put('/settings', { settings });
      setMessage('Settings saved successfully');
    } catch {
      setMessage('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Settings</h1>
          <p className="text-slate-400 text-sm mt-1">SuperAdmin only - manage system settings</p>
        </div>
        <Button onClick={handleSave} loading={saving}>
          <Save className="w-4 h-4" />
          Save Changes
        </Button>
      </div>
      {message && (
        <div
          className={`mb-6 p-3 rounded-lg text-sm border ${
            message.includes('success')
              ? 'bg-emerald-600/20 border-emerald-600/30 text-emerald-400'
              : 'bg-red-600/20 border-red-600/30 text-red-400'
          }`}
        >
          {message}
        </div>
      )}
      <div className="bg-slate-800 rounded-xl border border-slate-700">
        {settings.length === 0 ? (
          <div className="p-12 text-center text-slate-400">No settings configured</div>
        ) : (
          <div className="divide-y divide-slate-700">
            {settings.map((setting) => (
              <div key={setting.key} className="flex items-center gap-6 p-4">
                <div className="flex-1">
                  <label className="block text-sm font-medium text-white">{setting.key}</label>
                  {setting.description && (
                    <p className="text-xs text-slate-400 mt-0.5">{setting.description}</p>
                  )}
                </div>
                <input
                  type="text"
                  value={setting.value}
                  onChange={(e) => updateSetting(setting.key, e.target.value)}
                  className="w-80 px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg
                    text-white text-sm focus:outline-none focus:border-blue-500"
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
