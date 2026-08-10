// Funnel settings — the operator control center. A large modal opened from the
// funnel builder's Settings gear: header (title · funnel path · PUBLISHED/DRAFT
// badge), a grouped left nav, and a routed content pane. Payments is built
// fully; other sections are wired where a backend exists, else clean scaffolds.
import { useEffect, useState } from 'react';
import { X, Settings, Type, Globe, CreditCard, Package, Truck, Repeat, Activity, HeartPulse, Code2, FileCode2, CornerUpRight, Stethoscope, Palette } from 'lucide-react';
import PaymentsSection from './PaymentsSection';
import ThemesSection from './ThemesSection';
import TrackingSection from './TrackingSection';
import ProductsSection from './ProductsSection';
import ShippingSection from './ShippingSection';
import {
  GeneralSection, RedirectsSection, HealthSection,
  TrackingHealthSection, CustomTrackingSection,
  FontsSection, DomainsSection,
  SubscriptionsSection, ScriptsSection,
} from './sections';

const NAV = [
  {
    group: 'General',
    items: [
      { key: 'general', label: 'General', icon: Settings },
      // Themes sits beside General and Fonts because it writes the SAME keys
      // those two write — it is a macro over them, not a separate surface.
      { key: 'themes', label: 'Themes', icon: Palette },
      { key: 'fonts', label: 'Fonts', icon: Type },
      { key: 'domains', label: 'Domains', icon: Globe },
    ],
  },
  {
    group: 'Commerce',
    items: [
      { key: 'payments', label: 'Payments', icon: CreditCard },
      { key: 'products', label: 'Products', icon: Package },
      { key: 'shipping', label: 'Shipping', icon: Truck },
      { key: 'subscriptions', label: 'Subscriptions', icon: Repeat },
    ],
  },
  {
    group: 'Tracking',
    items: [
      { key: 'tracking', label: 'Tracking', icon: Activity },
      { key: 'tracking-health', label: 'Tracking Health', icon: HeartPulse },
      { key: 'custom-tracking', label: 'Custom Tracking Code', icon: Code2 },
    ],
  },
  {
    group: 'Advanced',
    items: [
      { key: 'scripts', label: 'Scripts', icon: FileCode2 },
      { key: 'redirects', label: 'Redirects', icon: CornerUpRight },
      { key: 'health', label: 'Health', icon: Stethoscope },
    ],
  },
];

export default function FunnelSettingsModal({ open, onClose, funnel, initialSection = 'payments', onFunnelUpdated }) {
  const [section, setSection] = useState(initialSection);

  useEffect(() => { if (open) setSection(initialSection); }, [open, initialSection]);

  useEffect(() => {
    if (!open) return undefined;
    document.body.style.overflow = 'hidden';
    const onEsc = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onEsc);
    return () => { document.body.style.overflow = ''; window.removeEventListener('keydown', onEsc); };
  }, [open, onClose]);

  if (!open || !funnel) return null;

  const published = funnel.status === 'published' || funnel.status === 'live';
  const publicPath = `/f/${funnel.slug}`;
  const funnelId = funnel.id;

  const render = () => {
    switch (section) {
      case 'general': return <GeneralSection funnel={funnel} onFunnelUpdated={onFunnelUpdated} />;
      case 'themes': return <ThemesSection funnel={funnel} onFunnelUpdated={onFunnelUpdated} />;
      case 'fonts': return <FontsSection funnel={funnel} onFunnelUpdated={onFunnelUpdated} />;
      case 'domains': return <DomainsSection funnel={funnel} onFunnelUpdated={onFunnelUpdated} />;
      case 'payments': return <PaymentsSection funnelId={funnelId} />;
      case 'products': return <ProductsSection funnel={funnel} />;
      case 'shipping': return <ShippingSection funnel={funnel} onFunnelUpdated={onFunnelUpdated} />;
      case 'subscriptions': return <SubscriptionsSection />;
      case 'tracking': return <TrackingSection funnel={funnel} onFunnelUpdated={onFunnelUpdated} />;
      case 'tracking-health': return <TrackingHealthSection funnel={funnel} />;
      case 'custom-tracking': return <CustomTrackingSection funnel={funnel} />;
      case 'scripts': return <ScriptsSection funnel={funnel} onFunnelUpdated={onFunnelUpdated} />;
      case 'redirects': return <RedirectsSection funnel={funnel} />;
      case 'health': return <HealthSection funnelId={funnelId} />;
      default: return null;
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="w-full max-w-5xl h-[85vh] flex flex-col bg-bg-card border border-border-default rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-5 py-3.5 border-b border-border-subtle">
          <div className="flex items-center gap-3 min-w-0">
            <h2 className="text-base font-semibold text-text-primary">Funnel settings</h2>
            <span className="text-xs text-text-faint font-mono truncate hidden sm:inline">{publicPath}</span>
            <span
              className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded-full border
                ${published ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border-amber-500/20'}`}
            >
              {published ? 'Published' : 'Draft'}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body: nav + content */}
        <div className="flex-1 flex min-h-0">
          <nav className="w-52 shrink-0 border-r border-border-subtle overflow-y-auto py-3 px-2 bg-bg-elevated/30">
            {NAV.map((grp) => (
              <div key={grp.group} className="mb-4">
                <div className="px-2 mb-1 text-[10px] font-semibold uppercase tracking-wider text-text-faint">{grp.group}</div>
                {grp.items.map((it) => {
                  const Icon = it.icon;
                  const active = section === it.key;
                  return (
                    <button
                      key={it.key}
                      onClick={() => setSection(it.key)}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left cursor-pointer transition-colors
                        ${active ? 'bg-accent-muted text-accent-text font-medium' : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'}`}
                    >
                      <Icon className="w-4 h-4 shrink-0" /> <span className="truncate">{it.label}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>
          <div className="flex-1 overflow-y-auto px-6 py-5">{render()}</div>
        </div>
      </div>
    </div>
  );
}
