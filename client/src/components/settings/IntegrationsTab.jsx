import { useState } from 'react';
import {
  Globe, Bot, Zap, CheckCircle, Settings, FlaskConical, X, Eye, EyeOff, Layers, Shield
} from 'lucide-react';

/* ── Brand logos (inline SVG for zero external deps) ── */

function AnthropicLogo({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M13.827 3.52h3.603L24 20.48h-3.603l-6.57-16.96zm-7.258 0H10.172L16.74 20.48h-3.603l-1.326-3.63H5.862l-1.333 3.63H.93L6.57 3.52zm-.223 10.48h4.603L8.724 7.52l-2.378 6.48z" fill="#D4A27F" />
    </svg>
  );
}

function GeminiLogo({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M12 24A14.3 14.3 0 0 0 0 12 14.3 14.3 0 0 0 12 0a14.3 14.3 0 0 0 0 24z" fill="url(#gemini-grad)" />
      <defs>
        <linearGradient id="gemini-grad" x1="0" y1="0" x2="24" y2="24">
          <stop stopColor="#4285F4" />
          <stop offset="0.5" stopColor="#9B72CB" />
          <stop offset="1" stopColor="#D96570" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function PostgresLogo({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M17.128 0a10.134 10.134 0 0 0-2.755.403l-.063.02A10.922 10.922 0 0 0 12.6.258C11.422.238 10.253.524 9.35 1.09c-.582-.259-1.86-.761-3.386-.71C4.14.434 2.16 1.053 1.199 3.2.04 5.757.381 9.39 1.574 12.082c.375.843 3.04 6.486 5.937 5.538.235-.077.46-.188.665-.33l.2.068c.712.218 1.456.261 2.15.132l.04.03a5.892 5.892 0 0 0-.38 1.248 11.57 11.57 0 0 0-.148 2.41l.015.153.14.067c1.618.773 2.98.602 3.88.07.903-.534 1.4-1.397 1.478-2.324.047-.574.07-1.15.089-1.593l.015-.398.097-.508c.088-.173.134-.28.16-.332l.032.007c.473.092.961.06 1.4-.056 1.594-.483 2.576-1.694 3.088-3.022.503-1.302.64-2.763.58-3.727-.032-.512-.09-.895-.134-1.127l.012-.022c.388-.72.664-1.63.834-2.56.176-.954.267-2.03.082-2.891C21.508 2.5 20.11.647 17.128 0z" fill="#336791" />
      <path d="M16.934.803c-2.452-.09-4.086.838-4.883 1.368-.43-.134-.913-.287-1.45-.312-1.07-.05-2.15.199-3.04.818-.394-.196-1.274-.58-2.555-.593-1.626-.016-3.341.515-4.198 2.433-1.09 2.438-.753 5.89.377 8.438.43.967 2.94 6.088 5.36 5.298.105-.034.208-.084.308-.147.08-.05.158-.11.232-.177l.528.172c.59.18 1.214.232 1.816.142a5.284 5.284 0 0 0-.383 1.47 10.84 10.84 0 0 0-.123 2.335c1.414.675 2.606.519 3.396.051.79-.468 1.204-1.196 1.273-2.04.047-.574.068-1.15.088-1.595.015-.34.027-.635.046-.87.045-.535.092-.675.233-.98l.018-.04.04.008c.377.073.77.044 1.129-.06 1.47-.444 2.376-1.564 2.86-2.813.479-1.237.616-2.636.558-3.545-.03-.457-.08-.803-.12-1.024a9.45 9.45 0 0 0 .778-2.408c.17-.916.253-1.924.079-2.69-.36-1.596-1.595-3.208-4.363-3.385z" fill="white" />
    </svg>
  );
}

function RedisLogo({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M23.56 14.012c-.467.24-2.876 1.236-3.393 1.504-.516.268-0.803.256-1.21.037-.406-.22-2.992-1.24-3.45-1.47-.456-.233-.424-.51.024-.734.45-.225 2.866-1.19 3.35-1.4.484-.207.71-.195 1.178.048.47.244 3.046 1.263 3.5 1.483.456.22.47.292 0 .532zm-6.155-3.46l3.53-.894.925 2.06-4.455-1.167zm-3.332 1.12l6.35-1.96-.07 2.22-6.28 2.42V11.67zm-.47-3.104c2.662-.796 4.262-.28 4.262-.28l-4.263 1.334-4.86 1.523c0 0 2.186-1.775 4.86-2.577z" fill="#DC382D" />
      <path d="M10.483 8.108L12 7.6l1.747 1.117-1.62.488-1.644-1.097z" fill="#DC382D" />
      <path d="M23.56 11.11c-.467.24-2.876 1.236-3.393 1.504-.516.268-.803.256-1.21.037-.406-.22-2.992-1.24-3.45-1.47-.456-.233-.424-.51.024-.734.45-.225 2.866-1.19 3.35-1.4.484-.207.71-.195 1.178.048.47.244 3.046 1.263 3.5 1.483.456.22.47.292 0 .532z" fill="#DC382D" />
      <path d="M23.56 8.205c-.467.24-2.876 1.236-3.393 1.504-.516.268-.803.256-1.21.037-.406-.22-2.992-1.24-3.45-1.47-.456-.232-.424-.51.024-.733.45-.225 2.866-1.19 3.35-1.4.484-.208.71-.196 1.178.047.47.244 3.046 1.263 3.5 1.483.456.22.47.292 0 .532z" fill="#DC382D" />
    </svg>
  );
}

function RenderLogo({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <rect width="24" height="24" rx="4" fill="#46E3B7" />
      <path d="M7 7h4.2c2.1 0 3.3 1.3 3.3 3.1 0 1.4-.8 2.4-2 2.8L15 17h-2.4l-2.2-3.8H9.2V17H7V7zm4 4.6c.9 0 1.5-.5 1.5-1.3s-.6-1.3-1.5-1.3H9.2v2.6H11z" fill="white" />
    </svg>
  );
}

function JwtLogo({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M12 0L10.39 7.36H13.61L12 0Z" fill="#F26D6D" />
      <path d="M12 24L13.61 16.64H10.39L12 24Z" fill="#F26D6D" />
      <path d="M0.69 7.36L7.16 11.09L8.77 7.98L0.69 7.36Z" fill="#FBFCFC" />
      <path d="M23.31 16.64L16.84 12.91L15.23 16.02L23.31 16.64Z" fill="#FBFCFC" />
      <path d="M7.16 12.91L0.69 16.64L8.77 16.02L7.16 12.91Z" fill="#00B9F1" />
      <path d="M16.84 11.09L23.31 7.36L15.23 7.98L16.84 11.09Z" fill="#00B9F1" />
      <path d="M12 15.28L8.77 16.02L10.39 16.64H13.61L15.23 16.02L12 15.28Z" fill="#D63AFF" />
      <path d="M12 8.72L15.23 7.98L13.61 7.36H10.39L8.77 7.98L12 8.72Z" fill="#D63AFF" />
    </svg>
  );
}

/* ── Logo map ── */
const logoMap = {
  Anthropic: AnthropicLogo,
  'Google Gemini': GeminiLogo,
  PostgreSQL: PostgresLogo,
  Redis: RedisLogo,
  Render: RenderLogo,
  'JWT Access Token': JwtLogo,
  'JWT Refresh Token': JwtLogo,
};

/* ── Data ── */

const categories = [
  { id: 'all', label: 'All', icon: Layers },
  { id: 'ai', label: 'AI Providers', icon: Bot },
  { id: 'infrastructure', label: 'Infrastructure', icon: Globe },
  { id: 'auth', label: 'Auth & Security', icon: Shield },
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

/* ── Component ── */

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
            const BrandLogo = logoMap[integration.name];
            return (
              <div
                key={integration.id}
                className="bg-[#111] rounded-xl border border-white/[0.06] p-5 flex flex-col"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-white/[0.04] border border-white/[0.06] flex items-center justify-center overflow-hidden">
                      {BrandLogo ? (
                        <BrandLogo className="w-6 h-6" />
                      ) : (
                        <Globe className="w-5 h-5 text-white/40" />
                      )}
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
              <div className="flex items-center gap-3">
                {(() => {
                  const ModalLogo = logoMap[configModal.name];
                  return ModalLogo ? (
                    <div className="w-8 h-8 rounded-lg bg-white/[0.04] border border-white/[0.06] flex items-center justify-center overflow-hidden">
                      <ModalLogo className="w-5 h-5" />
                    </div>
                  ) : null;
                })()}
                <h3 className="text-sm font-semibold text-white">Configure {configModal.name}</h3>
              </div>
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
