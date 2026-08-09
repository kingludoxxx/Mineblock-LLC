// Costs lane router (NEW FILE, costs lane).
//
// The integration fence allows EXACTLY one route registration line in
// App.jsx, and this lane has two surfaces (Costs, P&L). So App.jsx mounts
// `costs/*` → this file, and the split lives here, inside the lane's own
// directory. The CostsSubnav component inside each page is the visible
// switch between the two.
import { Navigate, Route, Routes } from 'react-router-dom';
import CostsPage from './CostsPage';
import PnLPage from './PnLPage';

export default function CostsRoutes() {
  return (
    <Routes>
      <Route index element={<CostsPage />} />
      <Route path="pnl" element={<PnLPage />} />
      <Route path="*" element={<Navigate to="." replace />} />
    </Routes>
  );
}
