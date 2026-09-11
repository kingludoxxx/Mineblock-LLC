// Harness entry for the W6 real-browser check (scripts/browser-check-sidebar-switcher.mjs).
//
// It mounts the REAL shell — AppLayout, which renders the REAL Sidebar (and therefore the REAL StoreSwitcher)
// and the REAL Topbar — with the REAL hook reading a REAL HTTP /api/v1/store-config that the check serves.
// Nothing about the switcher is stubbed here: the only fakes are the identity (an in-memory user with every
// permission, so the whole menu renders) and the router (MemoryRouter at /app/dashboard).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import AppLayout from '../src/components/layout/AppLayout';
import { AuthContext } from '../src/context/AuthContext';
import '../src/index.css';

const user = { id: 'u1', email: 'harness@example.test', firstName: 'H', lastName: 'A', roles: [{ id: 'r1', name: 'Admin', permissions: { '*': ['*'] } }] };

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthContext.Provider value={{ user, isLoading: false, login: () => {}, logout: () => {}, refreshToken: () => null, fetchMe: () => null }}>
      <MemoryRouter initialEntries={['/app/dashboard']}>
        <Routes>
          <Route path="/app" element={<AppLayout />}>
            <Route path="dashboard" element={<div style={{ padding: 24 }}>dashboard body</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>
  </StrictMode>,
);
