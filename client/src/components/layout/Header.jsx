import { useContext } from 'react';
import { useLocation, Link } from 'react-router-dom';
import { Sun, Moon, LogOut } from 'lucide-react';
import { ThemeContext } from '../../context/ThemeContext';
import { useAuth } from '../../hooks/useAuth';
import Badge from '../shared/Badge';

const routeNames = {
  dashboard: 'Dashboard',
  users: 'Users',
  departments: 'Departments',
  audit: 'Audit Logs',
  settings: 'Settings',
};

export default function Header() {
  const { theme, toggleTheme } = useContext(ThemeContext);
  const { user, logout } = useAuth();
  const location = useLocation();

  const pathParts = location.pathname.split('/').filter(Boolean);
  const breadcrumbs = pathParts.map((part, i) => ({
    label: routeNames[part] || part,
    path: '/' + pathParts.slice(0, i + 1).join('/'),
  }));

  return (
    <header className="h-16 bg-slate-800 border-b border-slate-700 flex items-center justify-between px-6">
      <nav className="flex items-center gap-2 text-sm">
        <Link to="/dashboard" className="text-slate-400 hover:text-white transition-colors">
          Home
        </Link>
        {breadcrumbs.map((crumb) => (
          <span key={crumb.path} className="flex items-center gap-2">
            <span className="text-slate-600">/</span>
            <Link to={crumb.path} className="text-slate-300 hover:text-white transition-colors">
              {crumb.label}
            </Link>
          </span>
        ))}
      </nav>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-3">
          <span className="text-sm text-slate-300">
            {user?.firstName} {user?.lastName}
          </span>
          {user?.roles?.map((role) => (
            <Badge key={role} role={role} />
          ))}
        </div>
        <button
          onClick={toggleTheme}
          className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition-colors cursor-pointer"
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        >
          {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>
        <button
          onClick={logout}
          className="p-2 rounded-lg text-slate-400 hover:text-red-400 hover:bg-slate-700 transition-colors cursor-pointer"
          title="Logout"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}
