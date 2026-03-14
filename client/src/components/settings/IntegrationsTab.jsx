import { useState } from 'react';
import {
  Globe, Bot, Palette, Video, Zap, BarChart3, MessageSquare,
  CheckCircle, Settings, FlaskConical, X, Eye, EyeOff, Layers
} from 'lucide-react';

const categories = [
  { id: 'all', label: 'All', icon: Layers },
  { id: 'scraping', label: 'Scraping', icon: Globe },
  { id: 'ai-text', label: 'AI / Text', icon: Bot },
  { id: 'ai-creative', label: 'AI / Creative', icon: Palette },
  { id: 'ai-video', label: 'AI / Video', icon: Video },
  { id: 'automation', label: 'Automation', icon: Zap },
  { id: 'analytics', label: 'Analytics', icon: BarChart3 },
  { id: 'pm-comms', label: 'PM & Comms', icon: MessageSquare },
];

const integrations = [
  { id: 1, name: 'Bright Data', description: 'Web scraping & data collection platform', category: 'scraping', connected: true, envVar: 'BRIGHTDATA_API_KEY' },
  { id: 2, name: 'ScrapingBee', description: 'Web scraping API with headless browser', category: 'scraping', connected: false, envVar: 'SCRAPINGBEE_KEY' },
  { id: 3, name: 'Apify', description: 'Web scraping and automation platform', category: 'scraping', connected: true, envVar: 'APIFY_TOKEN' },
  { id: 4, name: 'OpenAI', description: 'GPT models for text generation', category: 'ai-text', connected: true, envVar: 'OPENAI_API_KEY' },
  { id: 5, name: 'Anthropic', description: 'Claude models for AI assistance', category: 'ai-text', connected: true, envVar: 'ANTHROPIC_API_KEY' },
  { id: 6, name: 'Replicate', description: 'Run ML models in the cloud', category: 'ai-creative', connected: false, envVar: 'REPLICATE_API_TOKEN' },
  { id: 7, name: 'Stability AI', description: 'Image generation with Stable Diffusion', category: 'ai-creative', connected: true, envVar: 'STABILITY_API_KEY' },
  { id: 8, name: 'ElevenLabs', description: 'AI voice synthesis and cloning', category: 'ai-creative', connected: false, envVar: 'ELEVENLABS_API_KEY' },
  { id: 9, name: 'HeyGen', description: 'AI video generation with avatars', category: 'ai-video', connected: false, envVar: 'HEYGEN_API_KEY' },
  { id: 10, name: 'Runway', description: 'AI-powered video generation', category: 'ai-video', connected: false, envVar: 'RUNWAY_API_KEY' },
  { id: 11, name: 'Zapier', description: 'Workflow automation & integrations', category: 'automation', connected: true, envVar: 'ZAPIER_WEBHOOK_URL' },
  { id: 12, name: 'Make (Integromat)', description: 'Visual automation platform', category: 'automation', connected: false, envVar: 'MAKE_API_KEY' },
  { id: 13, name: 'Google Analytics', description: 'Website traffic analytics', category: 'analytics', connected: true, envVar: 'GA_MEASUREMENT_ID' },
  { id: 14, name: 'Mixpanel', description: 'Product analytics platform', category: 'analytics', connected: false, envVar: 'MIXPANEL_TOKEN' },
  { id: 15, name: 'Slack', description: 'Team messaging & notifications', category: 'pm-comms', connected: true, envVar: 'SLACK_WEBHOOK_URL' },
  { id: 16, name: 'Linear', description: 'Project management for teams', category: 'pm-comms', connected: false, envVar: 'LINEAR_API_KEY' },
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
    scraping: Globe,
    'ai-text': Bot,
    'ai-creative': Palette,
    'ai-video': Video,
    automation: Zap,
    analytics: BarChart3,
    'pm-comms': MessageSquare,
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
