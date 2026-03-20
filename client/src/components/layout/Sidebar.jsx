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
  PenTool,
  Wand2,
  Crown,
  Image,
  Layers,
  Video,
  Music,
  Sparkles,
  // Performance icons
  Target,
  Activity,
  Clock,
  DollarSign,
  // Library icons
  UsersRound,
  Archive,
  CheckSquare,
  // Ops icons
  Headphones,
  Zap,
  Monitor,
  Bug,
  Signal,
  Brain,
} from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';

const navGroups = [
  {
    label: 'Intelligence',
    icon: Brain,
    items: [
      { to: '/app/creative-intelligence', icon: Brain, label: 'Creative Intel' },
    ],
  },
  {
    label: 'Production',
    icon: Factory,
    items: [
      { to: '/app/brief-agent', icon: Sparkles, label: 'Brief Agent' },
      { to: '/app/magic-writer', icon: PenTool, label: 'Magic Writer' },
      { to: '/app/magic-ads', icon: Wand2, label: 'Magic Ads' },
      { to: '/app/iteration-king', icon: Crown, label: 'Iteration King' },
      { to: '/app/images', icon: Image, label: 'Images' },
      { to: '/app/statics-generation', icon: Layers, label: 'Statics Generation' },
    ],
  },
  {
    label: 'Library',
    icon: FolderOpen,
    items: [
      { to: '/app/team-hub', icon: UsersRound, label: 'Team Hub' },
      { to: '/app/assets', icon: Archive, label: 'Assets' },
      { to: '/app/todo', icon: CheckSquare, label: 'To Do' },
    ],
  },
  {
    label: 'Performance',
    icon: BarChart3,
    items: [
      { to: '/app/creative-analysis', icon: BarChart3, label: 'Creative Analysis' },
    ],
  },
  {
    label: 'Ops',
    icon: Wrench,
    adminOnly: true,
    items: [
      { to: '/app/support', icon: Headphones, label: 'Support' },
      { to: '/app/api-runs', icon: Zap, label: 'API Runs' },
      { to: '/app/ops-dashboard', icon: Monitor, label: 'Dashboard' },
      { to: '/app/scrape-runs', icon: Bug, label: 'Scrape Runs' },
      { to: '/app/status', icon: Signal, label: 'Status' },
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
  const { user } = useAuth();
  const location = useLocation();

  const isAdmin =
    user?.roles?.includes('SuperAdmin') || user?.roles?.includes('Admin');

  const toggleGroup = (label) => {
    setExpandedGroups((prev) => ({ ...prev, [label]: !prev[label] }));
  };

  const isGroupActive = (group) => {
    return group.items.some((item) => location.pathname.startsWith(item.to));
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
            <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center text-white font-bold text-sm">
              M
            </div>
            <span className="text-sm font-semibold text-text-primary truncate">Mineblock</span>
          </div>
        )}
        {collapsed && (
          <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center text-white font-bold text-sm mx-auto">
            M
          </div>
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
            ${isActive ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'}
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
          if (group.adminOnly && !isAdmin) return null;
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
                  {group.items.map((item) => {
                    const ItemIcon = item.icon;
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
