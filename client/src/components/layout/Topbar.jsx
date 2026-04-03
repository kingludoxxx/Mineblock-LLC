import { Link, useLocation } from 'react-router-dom';
import { Bell, Settings, ChevronRight } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import Badge from '../ui/Badge';

const routeLabels = {
  dashboard: 'Dashboard',
  settings: 'Settings',
  meta: 'Meta',
  google: 'Google',
  youtube: 'YouTube',
  'tiktok-ads': 'TikTok Ads',
  'tiktok-shop': 'TikTok Shop',
  'tiktok-organic': 'TikTok Organic',
  brands: 'Brand Spy',
  following: 'Following',
  saved: 'Saved',
  avatars: 'Avatars',
  mechanisms: 'Mechanisms',
  offers: 'Offers',
  products: 'Products',
  funnels: 'Funnels',
  'magic-writer': 'Magic Writer',
  'magic-ads': 'Magic Ads',
  images: 'Images',
  video: 'Video',
  audio: 'Audio',
  'team-hub': 'Team Hub',
  assets: 'Assets',
  todo: 'To Do',
  attribution: 'Attribution',
  live: 'Live',
  ltv: 'LTV',
  roas: 'ROAS',
  support: 'Support',
  'api-runs': 'API Runs',
  'ops-dashboard': 'Dashboard',
  'scrape-runs': 'Scrape Runs',
  status: 'Status',
  'brief-pipeline': 'Brief Pipeline',
  'brief-agent': 'Brief Agent',
  'iteration-king': 'Iteration King',
  'statics-generation': 'Static Ads',
  'creative-analysis': 'Creative Analysis',
  'kpi-system': 'KPI Dashboard',
  'ads-control-center': 'Ads Control Center',
  'creative-intelligence': 'Creative Intelligence',
  'fee-breakdown': 'Fee Breakdown',
  'supplier-costs': 'Supplier Costs',
};

const sectionLabels = {
  meta: 'Intel',
  google: 'Intel',
  youtube: 'Intel',
  'tiktok-ads': 'Intel',
  'tiktok-shop': 'Intel',
  'tiktok-organic': 'Intel',
  brands: 'Intel',
  following: 'Intel',
  saved: 'Intel',
  avatars: 'Lab',
  mechanisms: 'Lab',
  offers: 'Lab',
  products: 'Lab',
  funnels: 'Lab',
  'magic-writer': 'Production',
  'magic-ads': 'Production',
  images: 'Production',
  video: 'Production',
  audio: 'Production',
  'brief-pipeline': 'Production',
  'brief-agent': 'Production',
  'iteration-king': 'Production',
  'statics-generation': 'Production',
  'team-hub': 'Library',
  assets: 'Library',
  todo: 'Library',
  'creative-intelligence': 'Intel',
  attribution: 'Performance',
  live: 'Performance',
  ltv: 'Performance',
  roas: 'Performance',
  'creative-analysis': 'Performance',
  'kpi-system': 'Performance',
  'ads-control-center': 'Performance',
  'fee-breakdown': 'Performance',
  'supplier-costs': 'Performance',
  support: 'Ops',
  'api-runs': 'Ops',
  'ops-dashboard': 'Ops',
  'scrape-runs': 'Ops',
  status: 'Ops',
};

export default function Topbar() {
  const { user } = useAuth();
  const location = useLocation();

  const segments = location.pathname.replace('/app/', '').split('/').filter(Boolean);
  const currentPage = segments[0] || 'dashboard';
  const section = sectionLabels[currentPage];

  const fullName = user?.name || [user?.firstName, user?.lastName].filter(Boolean).join(' ') || '';
  const initials = fullName
    ? fullName.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)
    : '??';

  const firstRole = user?.roles?.[0];
  const displayRole = typeof firstRole === 'string' ? firstRole : firstRole?.name || 'User';

  return (
    <header className="h-[var(--topbar-h)] bg-bg-main border-b border-border-subtle flex items-center justify-between px-4 shrink-0">
      {/* Breadcrumbs */}
      <div className="flex items-center gap-1.5 text-sm">
        <Link to="/app/dashboard" className="text-text-muted hover:text-text-primary transition-colors">
          App
        </Link>
        {section && (
          <>
            <ChevronRight className="w-3.5 h-3.5 text-text-faint" />
            <span className="text-text-muted">{section}</span>
          </>
        )}
        <ChevronRight className="w-3.5 h-3.5 text-text-faint" />
        <span className="text-text-primary font-medium">
          {routeLabels[currentPage] || currentPage}
        </span>
      </div>

      {/* Right side */}
      <div className="flex items-center gap-3">
        <button className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer relative">
          <Bell className="w-4 h-4" />
        </button>
        <Link
          to="/app/settings"
          className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
        >
          <Settings className="w-4 h-4" />
        </Link>
        <div className="h-5 w-px bg-border-default" />
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-full bg-accent flex items-center justify-center text-xs font-medium text-bg-main">
            {initials}
          </div>
          <div className="hidden sm:flex flex-col">
            <span className="text-xs font-medium text-text-primary leading-none">
              {fullName || 'User'}
            </span>
            <span className="text-[10px] text-text-muted leading-none mt-0.5">
              {displayRole}
            </span>
          </div>
          <Badge variant={displayRole === 'SuperAdmin' ? 'danger' : displayRole === 'Admin' ? 'primary' : 'default'}>
            {displayRole}
          </Badge>
        </div>
      </div>
    </header>
  );
}
