// Harness entry for the real-browser checks (scripts/browser-check-sidebar-switcher.mjs — W6/W6b/W6c/W8a —
// and scripts/browser-check-home-permissions.mjs — W8b).
//
// It mounts the REAL shell — AppLayout, which renders the REAL Sidebar (and therefore the REAL
// StoreSwitcher) and the REAL Topbar — with the REAL hooks reading a REAL HTTP /api/v1/store-config and
// /api/v1/brand that the check serves. Nothing about the switcher, the brand or the permission gate is
// stubbed here: the only fakes are the identity and the router (MemoryRouter at /app/dashboard).
//
// Query string, read once at mount (the checks navigate, they do not mutate):
//   ?view=dashboard   render the REAL pages/Dashboard in the shell instead of a placeholder body
//   ?perms=none       the identity holds ONLY dashboard:access — no kpi-system:access. This is the
//                     hub's just-in-time user landing on a brand-new store (W8b).
//   (default)         the identity holds the wildcard, so every menu row and every page renders.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import AppLayout from '../src/components/layout/AppLayout';
import Dashboard from '../src/pages/Dashboard';
import { AuthContext } from '../src/context/AuthContext';
import '../src/index.css';

const params = new URLSearchParams(window.location.search);

// The shapes usePermissions reads (hooks/usePermissions.js): roles[].permissions, a JSONB object.
const ROLE_ALL = { id: 'r1', name: 'Harness - Everything', permissions: { '*': ['*'] } };
// Exactly what migration 133 maps a hub OWNER onto: the store's full-access role, which carries the page
// keys migration 031 seeds and does NOT carry kpi-system (that one is SuperAdmin's, deliberately).
const ROLE_NO_KPI = { id: 'r2', name: 'Team - Full Access', permissions: { dashboard: ['access'], orders: ['access'], statics: ['access'] } };

const role = params.get('perms') === 'none' ? ROLE_NO_KPI : ROLE_ALL;
const user = { id: 'u1', email: 'harness@example.test', firstName: 'H', lastName: 'A', roles: [role] };
const body = params.get('view') === 'dashboard' ? <Dashboard /> : <div style={{ padding: 24 }}>dashboard body</div>;

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthContext.Provider value={{ user, isLoading: false, login: () => {}, logout: () => {}, refreshToken: () => null, fetchMe: () => null }}>
      <MemoryRouter initialEntries={['/app/dashboard']}>
        <Routes>
          <Route path="/app" element={<AppLayout />}>
            <Route path="dashboard" element={body} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>
  </StrictMode>,
);
