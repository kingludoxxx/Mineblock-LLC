import { useSearchParams } from 'react-router-dom';
import {
  User, Shield, CreditCard, Coins, Building2, Plug, Bot, DollarSign,
} from 'lucide-react';
import ProfileTab from '../components/settings/ProfileTab';
import SecurityTab from '../components/settings/SecurityTab';
import BillingTab from '../components/settings/BillingTab';
import CreditsTab from '../components/settings/CreditsTab';
import WorkspaceTab from '../components/settings/WorkspaceTab';
import IntegrationsTab from '../components/settings/IntegrationsTab';
import AIProvidersTab from '../components/settings/AIProvidersTab';
import CostsTab from '../components/settings/CostsTab';

const tabs = [
  { id: 'profile', label: 'Profile', icon: User, component: ProfileTab },
  { id: 'security', label: 'Security', icon: Shield, component: SecurityTab },
  { id: 'billing', label: 'Billing', icon: CreditCard, component: BillingTab },
  { id: 'credits', label: 'Credits', icon: Coins, component: CreditsTab },
  { id: 'workspace', label: 'Workspace', icon: Building2, component: WorkspaceTab },
  { id: 'integrations', label: 'Integrations', icon: Plug, component: IntegrationsTab },
  { id: 'ai-providers', label: 'AI Providers', icon: Bot, component: AIProvidersTab },
  { id: 'costs', label: 'Costs', icon: DollarSign, component: CostsTab },
];

export default function Settings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get('tab') || 'profile';

  const currentTab = tabs.find((t) => t.id === activeTab) || tabs[0];
  const ActiveComponent = currentTab.component;

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <p className="text-white/40 text-sm mt-1">Manage your account, workspace, and integrations</p>
      </div>

      {/* Tab Bar */}
      <div className="flex flex-wrap gap-1 mb-8 p-1 bg-white/[0.02] rounded-xl border border-white/[0.04]">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              onClick={() => setSearchParams({ tab: tab.id })}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                isActive
                  ? 'bg-white/[0.08] text-white'
                  : 'text-white/40 hover:text-white/60 hover:bg-white/[0.03]'
              }`}
            >
              <tab.icon className="w-4 h-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab Content */}
      <ActiveComponent />
    </div>
  );
}
