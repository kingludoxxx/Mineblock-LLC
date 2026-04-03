import { useState } from 'react';
import { Eye, EyeOff, Save, Activity } from 'lucide-react';

const providersData = [
  {
    id: 'openai',
    name: 'OpenAI',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo', 'o1', 'o1-mini'],
    defaultModel: 'gpt-4o',
    usage: { calls: 12400, cost: '$34.20' },
    connected: true,
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    models: ['claude-opus-4-20250514', 'claude-sonnet-4-20250514', 'claude-3.5-haiku-20241022'],
    defaultModel: 'claude-sonnet-4-20250514',
    usage: { calls: 8200, cost: '$28.50' },
    connected: true,
  },
  {
    id: 'replicate',
    name: 'Replicate',
    models: ['sdxl', 'llama-3.1-405b', 'flux-1.1-pro', 'whisper'],
    defaultModel: 'flux-1.1-pro',
    usage: { calls: 340, cost: '$5.10' },
    connected: false,
  },
  {
    id: 'stability',
    name: 'Stability AI',
    models: ['stable-diffusion-3', 'sd-xl-turbo', 'stable-video-diffusion'],
    defaultModel: 'stable-diffusion-3',
    usage: { calls: 1560, cost: '$12.40' },
    connected: true,
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    models: ['eleven_multilingual_v2', 'eleven_turbo_v2', 'eleven_monolingual_v1'],
    defaultModel: 'eleven_multilingual_v2',
    usage: { calls: 220, cost: '$8.80' },
    connected: false,
  },
  {
    id: 'heygen',
    name: 'HeyGen',
    models: ['avatar-v2', 'avatar-v1', 'instant-avatar'],
    defaultModel: 'avatar-v2',
    usage: { calls: 45, cost: '$22.50' },
    connected: false,
  },
];

export default function AIProvidersTab() {
  const [providers, setProviders] = useState(
    providersData.map((p) => ({ ...p, apiKey: '', showKey: false, selectedModel: p.defaultModel }))
  );
  const [saving, setSaving] = useState(null);

  const updateProvider = (id, field, value) => {
    setProviders((prev) => prev.map((p) => (p.id === id ? { ...p, [field]: value } : p)));
  };

  const handleSave = async (id) => {
    setSaving(id);
    await new Promise((r) => setTimeout(r, 800));
    setSaving(null);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-white mb-1">AI Providers</h2>
        <p className="text-sm text-white/40">Configure AI service providers and manage API keys</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
        {providers.map((provider) => (
          <div
            key={provider.id}
            className="bg-[#111] rounded-xl border border-white/[0.06] p-5 flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-white/[0.04] border border-white/[0.06] flex items-center justify-center">
                  <span className="text-xs font-bold text-white/40">
                    {provider.name.slice(0, 2).toUpperCase()}
                  </span>
                </div>
                <div>
                  <h4 className="text-sm font-medium text-white">{provider.name}</h4>
                  {provider.connected ? (
                    <span className="text-[10px] font-medium text-emerald-400">Connected</span>
                  ) : (
                    <span className="text-[10px] font-medium text-white/30">Not configured</span>
                  )}
                </div>
              </div>
            </div>

            {/* Model Selector */}
            <div className="mb-3">
              <label className="block text-xs font-medium text-white/40 mb-1.5">Model</label>
              <select
                value={provider.selectedModel}
                onChange={(e) => updateProvider(provider.id, 'selectedModel', e.target.value)}
                className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-lg text-white text-xs
                  focus:outline-none focus:border-white/[0.2] appearance-none cursor-pointer"
              >
                {provider.models.map((model) => (
                  <option key={model} value={model} className="bg-[#111]">{model}</option>
                ))}
              </select>
            </div>

            {/* API Key */}
            <div className="mb-4">
              <label className="block text-xs font-medium text-white/40 mb-1.5">API Key</label>
              <div className="relative">
                <input
                  type={provider.showKey ? 'text' : 'password'}
                  value={provider.apiKey}
                  onChange={(e) => updateProvider(provider.id, 'apiKey', e.target.value)}
                  placeholder={provider.connected ? '••••••••••••••••' : 'Enter API key'}
                  className="w-full px-3 py-2 pr-9 bg-white/[0.04] border border-white/[0.08] rounded-lg text-white text-xs font-mono
                    focus:outline-none focus:border-white/[0.2] transition-colors placeholder-white/20"
                />
                <button
                  onClick={() => updateProvider(provider.id, 'showKey', !provider.showKey)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60 cursor-pointer"
                >
                  {provider.showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>

            {/* Usage Stats */}
            <div className="flex items-center gap-4 p-3 rounded-lg bg-white/[0.02] border border-white/[0.04] mb-4">
              <Activity className="w-4 h-4 text-white/20 shrink-0" />
              <div className="flex-1 flex justify-between text-xs">
                <div>
                  <span className="text-white/30">Calls:</span>{' '}
                  <span className="text-white/60">{provider.usage.calls.toLocaleString()}</span>
                </div>
                <div>
                  <span className="text-white/30">Cost:</span>{' '}
                  <span className="text-white/60">{provider.usage.cost}</span>
                </div>
              </div>
            </div>

            {/* Save */}
            <button
              onClick={() => handleSave(provider.id)}
              disabled={saving === provider.id}
              className="mt-auto w-full inline-flex items-center justify-center gap-2 px-4 py-2 bg-accent hover:bg-accent-hover text-white text-xs font-medium rounded-lg
                transition-colors disabled:opacity-50 cursor-pointer"
            >
              {saving === provider.id ? (
                <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <Save className="w-3.5 h-3.5" />
              )}
              {saving === provider.id ? 'Saving...' : 'Save Configuration'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
