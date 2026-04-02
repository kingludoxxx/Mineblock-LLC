import { useState, createContext, useContext } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import Topbar from './Topbar';
import ErrorBoundary from '../ErrorBoundary';

const SidebarContext = createContext();
export const useSidebar = () => useContext(SidebarContext);

export default function AppLayout() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <SidebarContext.Provider value={{ collapsed, setCollapsed }}>
      <div className="h-screen bg-bg-main">
        <Sidebar />
        <div
          className="flex flex-col h-screen transition-all duration-200"
          style={{
            marginLeft: collapsed ? 'var(--sidebar-collapsed-w)' : 'var(--sidebar-w)',
          }}
        >
          <Topbar />
          <main className="flex-1 overflow-y-auto">
            <ErrorBoundary>
              <Outlet />
            </ErrorBoundary>
          </main>
        </div>
      </div>
    </SidebarContext.Provider>
  );
}
