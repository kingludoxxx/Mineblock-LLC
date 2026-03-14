import { useState } from 'react';
import {
  Globe, Bot, Zap, CheckCircle, Settings, FlaskConical, X, Eye, EyeOff, Layers
} from 'lucide-react';

const categories = [
  { id: 'all', label: 'All', icon: Layers },
  { id: 'ai', label: 'AI Providers', icon: Bot },
  { id: 'infrastructure', label: 'Infrastructure', icon: Globe },
  { id: 'auth', label: 'Auth & Security', icon: Zap },
];

const integrations = [
  { id: 1, name: 'Anthropic', description: 'Claude models — powers Magic Writer & AI features', category: 'ai', connected: true, envVar: 'ANTHROPIC_API_KEY' },
  { id: 2, name: 'Google Gemini', description: 'Gemini models for multimodal AI tasks', category: 'ai', connected: true, envVar: 'GEMINI_API_KEY' },
  { id: 3, name: 'PostgreSQL', description: 'Primary database hosted on Render', category: 'infrastructure', connected: true, envVar: 'DATABASE_URL' },
  { id: 4, name: 'Redis', description: 'Session cache, rate limiting & response cache', category: 'infrastructure', connected: false, envVar: 'REDIS_URL' },
  { id: 5, name: 'Render', description: 'Hosting platform — web service & database', category: 'infrastructure', connected: true, envVar: 'NODE_ENV' },
  { id: 6, name: 'CORS Origin', description: 'Allowed frontend origin for API requests', category: 'infrastructure', connected: true, envVar: 'CORS_ORIGIN' },
  { id: 7, name: 'JWT Access Token', description: 'Secret for signing short-lived access tokens (15min)', category: 'auth', connected: true, envVar: 'JWT_ACCESS_SECRET' },
  { id: 8, name: 'JWT Refresh Token', description: 'Secret for signing long-lived refresh tokens (7 days)', category: 'auth', connected: true, envVar: 'JWT_REFRESH_SECRET' },
];

export default function IntegrationsTab() {
  const [activeCategory, setActiveCategory] = useState('all');
  const [configModal, setConfigModal] = useState(null);
  const [envValue, setEnvValue] = useState('');
  const [showEnv, setShowEnv] = useState(false);
  const [testing, setTesting] = useState(null);

  const filtered = activeCategory === 'all'
    ? integrations
    : integrations.filter((i) => i.category === activeCategory);

  const handleTest = async (id) => {
    setTesting(id);
    await new Promise((r) => setTimeout(r, 1500));
    setTesting(null);
  };

  const iconMap = {
    ai: Bot,
    infrastructure: Globe,
    auth: Zap,
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-white mb-1">Integrations</h2>
        <p className="text-sm text-white/40">Connect external services and manage API keys</p>
      </div>

      <div className="flex gap-6">
        {/* Category Sidebar */}
        <div className="w-48 shrink-0 space-y-1">
          {categories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setActiveCategory(cat.id)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors cursor-pointer text-left ${
                activeCategory === cat.id
                  ? 'bg-white/[0.08] text-white'
                  : 'text-white/40 hover:text-white/60 hover:bg-white/[0.03]'
              }`}
            >
              <cat.icon className="w-4 h-4 shrink-0" />
              {cat.label}
            </button>
          ))}
        </div>

        {/* Card Grid */}
        <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4">
          {filtered.map((integration) => {
            const Icon = iconMap[integration.category] || Zap;
            return (
              <div
                key={integration.id}
                className="bg-[#111] rounded-xl border border-white/[0.06] p-5 flex flex-col"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-white/[0.04] border border-white/[0.06] flex items-center justify-center">
                      <Icon className="w-5 h-5 text-white/40" />
                    </div>
                    <div>
                      <h4 className="text-sm font-medium text-white">{integration.name}</h4>
                      <p className="text-xs text-white/30 mt-0.5">{integration.description}</p>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 mb-4">
                  {integration.connected ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium bg-emerald-500/20 text-emerald-400 rounded">
                      <CheckCircle className="w-3 h-3" />
                      Connected
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 text-[10px] font-medium bg-white/[0.04] text-white/30 rounded">
                      Not Configured
                    </span>
                  )}
                  <span className="px-2 py-0.5 text-[10px] font-mono font-medium bg-yellow-500/15 text-yellow-500 rounded">
                    {integration.envVar}
                  </span>
                </div>

                <div className="flex gap-2 mt-auto">
                  <button
                    onClick={() => handleTest(integration.id)}
                    disabled={!integration.connected || testing === integration.id}
                    className="flex-1 px-3 py-1.5 text-xs font-medium bg-white/[0.04] hover:bg-white/[0.08] text-white/60 rounded-lg border border-white/[0.08]
                      transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer flex items-center justify-center gap-1.5"
                  >
                    {testing === integration.id ? (
                      <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    ) : (
                      <FlaskConical className="w-3 h-3" />
                    )}
                    Test
                  </button>
                  <button
                    onClick={() => {
                      setConfigModal(integration);
                      setEnvValue('');
                      setShowEnv(false);
                    }}
                    className="flex-1 px-3 py-1.5 text-xs font-medium bg-white/[0.04] hover:bg-white/[0.08] text-white/60 rounded-lg border border-white/[0.08]
                      transition-colors cursor-pointer flex items-center justify-center gap-1.5"
                  >
                    <Settings className="w-3 h-3" />
                    Env Vars
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Config Modal */}
      {configModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-[#111] rounded-xl border border-white/[0.08] w-full max-w-md mx-4 p-6">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-sm font-semibold text-white">Configure {configModal.name}</h3>
              <button
                onClick={() => setConfigModal(null)}
                className="p-1 text-white/30 hover:text-white/60 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div>
              <label className="block text-sm font-medium text-white/70 mb-2">
                {configModal.envVar}
              </label>
              <div className="relative">
                <input
                  type={showEnv ? 'text' : 'password'}
                  value={envValue}
                  onChange={(e) => setEnvValue(e.target.value)}
                  placeholder="Enter API key or value..."
                  className="w-full px-4 py-2.5 pr-10 bg-white/[0.04] border border-white/[0.08] rounded-lg text-white text-sm font-mono
                    focus:outline-none focus:border-white/[0.2] transition-colors placeholder-white/20"
                />
                <button
                  onClick={() => setShowEnv(!showEnv)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60 cursor-pointer"
                >
                  {showEnv ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setConfigModal(null)}
                className="flex-1 px-4 py-2 bg-white/[0.04] hover:bg-white/[0.08] text-white/60 text-sm font-medium rounded-lg border border-white/[0.08] transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => setConfigModal(null)}
                className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
