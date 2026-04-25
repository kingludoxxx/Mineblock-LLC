import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useSidebar } from './AppLayout';
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Radar,
  FlaskConical,
  Factory,
  FolderOpen,
  BarChart3,
  Wrench,
  Settings,
  LayoutDashboard,
  // Intel icons
  Facebook,
  Search,
  Youtube,
  Megaphone,
  ShoppingBag,
  TrendingUp,
  Eye,
  UserCheck,
  Bookmark,
  // Lab icons
  Users,
  Cog,
  Tag,
  Package,
  GitBranch,
  // Production icons
  Wand2,
  Crown,
  Image,
  Layers,
  Video,
  Music,
  Sparkles,
  FileText,
  Rocket,
  Globe,
  // Performance icons
  Target,
  Activity,
  Clock,
  DollarSign,
  // Library icons
  UsersRound,
  Archive,
  CheckSquare,
  Shield,
  // Ops icons
  Headphones,
  Zap,
  Monitor,
  Bug,
  Signal,
  Brain,
} from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { usePermissions } from '../../hooks/usePermissions';

const navGroups = [
{
    label: 'Production',
    icon: Factory,
    items: [
      { to: '/app/brief-agent', icon: Sparkles, label: 'Brief Agent', permission: 'brief-agent:access' },
      { to: '/app/iteration-king', icon: Crown, label: 'Iteration King', permission: 'iteration-king:access' },
      { to: '/app/statics-generation', icon: Layers, label: 'Statics Generation', permission: 'statics-generation:access' },
      { to: '/app/brief-pipeline', icon: FileText, label: 'Brief Pipeline', permission: 'brief-pipeline:access' },
      { to: '/app/ads-launcher', icon: Rocket, label: 'Ads Launcher', permission: 'ads-launcher:access' },
      { to: '/app/languages-pipeline', icon: Globe, label: 'Languages Pipeline', permission: 'languages-pipeline:access' },
    ],
  },
  {
    label: 'Library',
    icon: FolderOpen,
    items: [
      { to: '/app/team-hub', icon: UsersRound, label: 'Team Hub', permission: 'team-hub:access' },
      { to: '/app/assets', icon: Package, label: 'Product Library', permission: 'assets:access' },
    ],
  },
  {
    label: 'Performance',
    icon: BarChart3,
    items: [
      { to: '/app/creative-analysis', icon: BarChart3, label: 'Creative Analysis', permission: 'creative-analysis:access' },
      { to: '/app/ads-control-center', icon: Zap, label: 'Ads Control', permission: 'ads-control-center:access' },
      {
        icon: DollarSign,
        label: 'KPI System',
        permission: 'kpi-system:access',
        children: [
          { to: '/app/kpi-system', label: 'Dashboard' },
          { to: '/app/kpi-system/cost-sheet', label: 'Supplier Costs' },
          { to: '/app/kpi-system/fees', label: 'Fee Breakdown' },
        ],
      },
    ],
  },
  {
    label: 'Ops',
    icon: Wrench,
    items: [
      { to: '/app/team', icon: Shield, label: 'Team', permission: 'team:manage' },
      { to: '/app/support', icon: Headphones, label: 'Support', permission: 'support:access' },
      { to: '/app/api-runs', icon: Zap, label: 'API Runs', permission: 'api-runs:access' },
      { to: '/app/ops-dashboard', icon: Monitor, label: 'Dashboard', permission: 'ops-dashboard:access' },
      { to: '/app/scrape-runs', icon: Bug, label: 'Scrape Runs', permission: 'scrape-runs:access' },
      { to: '/app/status', icon: Signal, label: 'Status', permission: 'status:access' },
    ],
  },
];

export default function Sidebar() {
  const { collapsed, setCollapsed } = useSidebar();
  const [expandedGroups, setExpandedGroups] = useState(() => {
    const initial = {};
    navGroups.forEach((g) => {
      initial[g.label] = true;
    });
    return initial;
  });
  const [expandedItems, setExpandedItems] = useState({});
  const { user } = useAuth();
  const { hasPermission } = usePermissions();
  const location = useLocation();

  const toggleGroup = (label) => {
    setExpandedGroups((prev) => ({ ...prev, [label]: !prev[label] }));
  };

  const toggleItem = (label) => {
    setExpandedItems((prev) => ({ ...prev, [label]: !prev[label] }));
  };

  const isItemParentActive = (item) => {
    return item.children?.some((child) => location.pathname === child.to);
  };

  const isGroupActive = (group) => {
    return group.items.some((item) =>
      item.children
        ? item.children.some((child) => location.pathname.startsWith(child.to))
        : location.pathname.startsWith(item.to)
    );
  };

  return (
    <aside
      className="fixed top-0 left-0 h-screen flex flex-col bg-bg-card border-r border-border-default transition-all duration-200 z-30"
      style={{ width: collapsed ? 'var(--sidebar-collapsed-w)' : 'var(--sidebar-w)' }}
    >
      {/* Logo + collapse */}
      <div className="flex items-center justify-between px-3 h-[var(--topbar-h)] border-b border-border-subtle shrink-0">
        {!collapsed && (
          <div className="flex items-center gap-2.5">
            <img src="/logo-white.png" alt="Mineblock" className="h-5 w-auto" />
          </div>
        )}
        {collapsed && (
          <img src="/logo-symbol-white.png" alt="Mineblock" className="h-4 w-auto mx-auto" />
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>
      </div>

      {/* Dashboard link */}
      <div className="px-2 pt-2 shrink-0">
        <NavLink
          to="/app/dashboard"
          className={({ isActive }) =>
            `flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors
            ${isActive ? 'bg-accent-muted text-accent-text font-semibold border border-accent/20' : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'}
            ${collapsed ? 'justify-center' : ''}`
          }
          title={collapsed ? 'Dashboard' : undefined}
        >
          <LayoutDashboard className="w-4 h-4 shrink-0" />
          {!collapsed && <span>Dashboard</span>}
        </NavLink>
      </div>

      {/* Nav groups */}
      <nav className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5">
        {navGroups.map((group) => {
          // Filter items by permission — hide items the user cannot access
          const visibleItems = group.items.filter(
            (item) => !item.permission || hasPermission(item.permission)
          );
          // Hide the entire group if no items are visible
          if (visibleItems.length === 0) return null;
          const GroupIcon = group.icon;
          const isExpanded = expandedGroups[group.label];
          const groupActive = isGroupActive(group);

          return (
            <div key={group.label}>
              <button
                onClick={() => !collapsed && toggleGroup(group.label)}
                className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs font-medium uppercase tracking-wider transition-colors cursor-pointer
                  ${groupActive ? 'text-text-primary' : 'text-text-faint hover:text-text-muted'}
                  ${collapsed ? 'justify-center' : ''}`}
                title={collapsed ? group.label : undefined}
              >
                <GroupIcon className="w-4 h-4 shrink-0" />
                {!collapsed && (
                  <>
                    <span className="flex-1 text-left">{group.label}</span>
                    <ChevronDown
                      className={`w-3 h-3 transition-transform ${isExpanded ? '' : '-rotate-90'}`}
                    />
                  </>
                )}
              </button>
              {!collapsed && isExpanded && (
                <div className="ml-3 pl-3 border-l border-border-subtle space-y-0.5 mt-0.5 mb-1">
                  {visibleItems.map((item) => {
                    const ItemIcon = item.icon;

                    if (item.children) {
                      const parentActive = isItemParentActive(item);
                      const isItemExpanded = expandedItems[item.label] ?? parentActive;
                      return (
                        <div key={item.label}>
                          <button
                            onClick={() => toggleItem(item.label)}
                            className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors cursor-pointer
                              ${parentActive ? 'bg-bg-hover text-text-primary' : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'}`}
                          >
                            <ItemIcon className="w-3.5 h-3.5 shrink-0" />
                            <span className="flex-1 text-left">{item.label}</span>
                            <ChevronDown
                              className={`w-3 h-3 transition-transform ${isItemExpanded ? '' : '-rotate-90'}`}
                            />
                          </button>
                          {isItemExpanded && (
                            <div className="ml-3 pl-3 border-l border-border-subtle space-y-0.5 mt-0.5 mb-0.5">
                              {item.children.map((child) => (
                                <NavLink
                                  key={child.to}
                                  to={child.to}
                                  end={child.to === '/app/kpi-system'}
                                  className={({ isActive }) =>
                                    `flex items-center gap-2.5 px-2.5 py-1 rounded-md text-xs transition-colors
                                    ${isActive ? 'bg-bg-hover text-text-primary' : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'}`
                                  }
                                >
                                  <span>{child.label}</span>
                                </NavLink>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    }

                    return (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        className={({ isActive }) =>
                          `flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors
                          ${isActive ? 'bg-bg-hover text-text-primary' : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'}`
                        }
                      >
                        <ItemIcon className="w-3.5 h-3.5 shrink-0" />
                        <span>{item.label}</span>
                      </NavLink>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* Settings pinned at bottom */}
      <div className="px-2 py-2 border-t border-border-subtle shrink-0">
        <NavLink
          to="/app/settings"
          className={({ isActive }) =>
            `flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors
            ${isActive ? 'bg-bg-hover text-text-primary' : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'}
            ${collapsed ? 'justify-center' : ''}`
          }
          title={collapsed ? 'Settings' : undefined}
        >
          <Settings className="w-4 h-4 shrink-0" />
          {!collapsed && <span>Settings</span>}
        </NavLink>
      </div>
    </aside>
  );
}
