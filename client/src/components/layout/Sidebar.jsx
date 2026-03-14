import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  Building2,
  ScrollText,
  Settings,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { usePermissions } from '../../hooks/usePermissions';

const navItems = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard', permission: 'dashboard' },
  { to: '/users', icon: Users, label: 'Users', permission: 'users' },
  { to: '/departments', icon: Building2, label: 'Departments', permission: 'departments' },
  { to: '/audit', icon: ScrollText, label: 'Audit Logs', permission: 'audit' },
  { to: '/settings', icon: Settings, label: 'Settings', permission: 'settings' },
];

export default function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const { hasPermission } = usePermissions();

  const filteredItems = navItems.filter((item) => hasPermission(item.permission));

  return (
    <aside
      className={`bg-slate-950 border-r border-slate-800 flex flex-col transition-all duration-300
        ${collapsed ? 'w-16' : 'w-64'}`}
    >
      <div className="flex items-center justify-between p-4 border-b border-slate-800 min-h-[64px]">
        {!collapsed && (
          <span className="text-lg font-bold text-white whitespace-nowrap">Mineblock LLC</span>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>
      </div>
      <nav className="flex-1 p-3 space-y-1">
        {filteredItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors
              ${
                isActive
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800'
              }
              ${collapsed ? 'justify-center' : ''}`
            }
            title={collapsed ? item.label : undefined}
          >
            <item.icon className="w-5 h-5 shrink-0" />
            {!collapsed && <span>{item.label}</span>}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
