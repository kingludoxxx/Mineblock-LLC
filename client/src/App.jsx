import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import ProtectedRoute from './components/auth/ProtectedRoute';
import PageGate from './components/auth/PageGate';
import AppLayout from './components/layout/AppLayout';
import ErrorBoundary from './components/ErrorBoundary';

// Auth pages
import Login from './pages/Login';
import Signup from './pages/Signup';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import VerifyEmail from './pages/VerifyEmail';

// App pages
import Dashboard from './pages/Dashboard';
import Settings from './pages/Settings';
import NotFound from './pages/NotFound';
import SupplierPublicSheet from './pages/public/SupplierPublicSheet';

// Intel
import MetaPage from './pages/intel/MetaPage';
import GooglePage from './pages/intel/GooglePage';
import YouTubePage from './pages/intel/YouTubePage';
import TikTokAdsPage from './pages/intel/TikTokAdsPage';
import TikTokShopPage from './pages/intel/TikTokShopPage';
import TikTokOrganicPage from './pages/intel/TikTokOrganicPage';
import BrandsPage from './pages/intel/BrandsPage';
import BrandDetailPage from './pages/intel/BrandDetailPage';
import FollowingPage from './pages/intel/FollowingPage';
import SavedPage from './pages/intel/SavedPage';
import CreativeIntelligencePage from './pages/intel/CreativeIntelligencePage';

// Lab
import AvatarsPage from './pages/lab/AvatarsPage';
import MechanismsPage from './pages/lab/MechanismsPage';
import OffersPage from './pages/lab/OffersPage';
import ProductsPage from './pages/lab/ProductsPage';
import FunnelsPage from './pages/lab/FunnelsPage';

// Production
import BriefAgentPage from './pages/production/BriefAgentPage';
import MagicAdsPage from './pages/production/MagicAdsPage';
import IterationKingPage from './pages/production/IterationKingPage';
import ImagesPage from './pages/production/ImagesPage';
import VideoPage from './pages/production/VideoPage';
import AudioPage from './pages/production/AudioPage';
import StaticsGenerationPage from './pages/production/StaticsGenerationPage';
import BriefPipeline from './pages/production/BriefPipeline';
import AdsLauncherPage from './pages/production/AdsLauncherPage';

// Performance
import AttributionPage from './pages/performance/AttributionPage';
import LivePage from './pages/performance/LivePage';
import LtvPage from './pages/performance/LtvPage';
import RoasPage from './pages/performance/RoasPage';
import CreativeAnalysisPage from './pages/performance/CreativeAnalysisPage';
import KpiSystem from './pages/performance/KpiSystem';
import KpiDashboard from './pages/performance/KpiDashboard';
import SupplierCostSheet from './pages/performance/SupplierCostSheet';
import FeeBreakdown from './pages/performance/FeeBreakdown';
import AdsControlCenter from './pages/performance/AdsControlCenter';

// Library
import TeamHubPage from './pages/library/TeamHubPage';
import AssetsPage from './pages/library/AssetsPage';
import TodoPage from './pages/library/TodoPage';

// Team
import TeamManagement from './pages/TeamManagement';

// Ops
import SupportPage from './pages/ops/SupportPage';
import ApiRunsPage from './pages/ops/ApiRunsPage';
import OpsDashboardPage from './pages/ops/OpsDashboardPage';
import ScrapeRunsPage from './pages/ops/ScrapeRunsPage';
import StatusPage from './pages/ops/StatusPage';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public auth routes */}
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/verify-email" element={<VerifyEmail />} />

        {/* Protected app routes */}
        <Route
          path="/app"
          element={
            <ProtectedRoute>
              <AppLayout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Navigate to="dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="settings" element={<Settings />} />

          {/* Intel */}
          <Route path="meta" element={<PageGate permission="meta-ads:access"><MetaPage /></PageGate>} />
          <Route path="google" element={<PageGate permission="google-ads:access"><GooglePage /></PageGate>} />
          <Route path="youtube" element={<PageGate permission="youtube-ads:access"><YouTubePage /></PageGate>} />
          <Route path="tiktok-ads" element={<PageGate permission="tiktok-ads:access"><TikTokAdsPage /></PageGate>} />
          <Route path="tiktok-shop" element={<PageGate permission="tiktok-shop:access"><TikTokShopPage /></PageGate>} />
          <Route path="tiktok-organic" element={<PageGate permission="tiktok-organic:access"><TikTokOrganicPage /></PageGate>} />
          <Route path="brands" element={<PageGate permission="brands:access"><BrandsPage /></PageGate>} />
          <Route path="brands/:id" element={<PageGate permission="brands:access"><BrandDetailPage /></PageGate>} />
          <Route path="following" element={<PageGate permission="following:access"><FollowingPage /></PageGate>} />
          <Route path="saved" element={<PageGate permission="saved:access"><SavedPage /></PageGate>} />
          <Route path="creative-intelligence" element={<PageGate permission="creative-intelligence:access"><CreativeIntelligencePage /></PageGate>} />

          {/* Lab */}
          <Route path="avatars" element={<PageGate permission="avatars:access"><AvatarsPage /></PageGate>} />
          <Route path="mechanisms" element={<PageGate permission="mechanisms:access"><MechanismsPage /></PageGate>} />
          <Route path="offers" element={<PageGate permission="offers:access"><OffersPage /></PageGate>} />
          <Route path="products" element={<PageGate permission="products:access"><ProductsPage /></PageGate>} />
          <Route path="funnels" element={<PageGate permission="funnels:access"><FunnelsPage /></PageGate>} />

          {/* Production */}
          <Route path="brief-agent" element={<PageGate permission="brief-agent:access"><BriefAgentPage /></PageGate>} />
          <Route path="magic-ads" element={<PageGate permission="magic-ads:access"><MagicAdsPage /></PageGate>} />
          <Route path="iteration-king" element={<PageGate permission="iteration-king:access"><IterationKingPage /></PageGate>} />
          <Route path="images" element={<PageGate permission="images:access"><ImagesPage /></PageGate>} />
          <Route path="video" element={<PageGate permission="video:access"><VideoPage /></PageGate>} />
          <Route path="audio" element={<PageGate permission="audio:access"><AudioPage /></PageGate>} />
          <Route path="statics-generation" element={<PageGate permission="statics-generation:access"><StaticsGenerationPage /></PageGate>} />
          <Route path="brief-pipeline" element={<PageGate permission="brief-pipeline:access"><BriefPipeline /></PageGate>} />
          <Route path="ads-launcher" element={<PageGate permission="ads-launcher:access"><AdsLauncherPage /></PageGate>} />

          {/* Performance */}
          <Route path="creative-analysis" element={<PageGate permission="creative-analysis:access"><CreativeAnalysisPage /></PageGate>} />
          <Route path="kpi-system" element={<PageGate permission="kpi-system:access"><KpiDashboard /></PageGate>} />
          <Route path="kpi-system/cost-sheet" element={<PageGate permission="kpi-system:access"><SupplierCostSheet /></PageGate>} />
          <Route path="kpi-system/fees" element={<PageGate permission="kpi-system:access"><FeeBreakdown /></PageGate>} />
          <Route path="attribution" element={<PageGate permission="attribution:access"><AttributionPage /></PageGate>} />
          <Route path="live" element={<PageGate permission="live-metrics:access"><LivePage /></PageGate>} />
          <Route path="ltv" element={<PageGate permission="ltv:access"><LtvPage /></PageGate>} />
          <Route path="roas" element={<PageGate permission="roas:access"><RoasPage /></PageGate>} />
          <Route path="ads-control-center" element={<PageGate permission="ads-control-center:access"><AdsControlCenter /></PageGate>} />

          {/* Library */}
          <Route path="team-hub" element={<PageGate permission="team-hub:access"><TeamHubPage /></PageGate>} />
          <Route path="assets" element={<PageGate permission="assets:access"><AssetsPage /></PageGate>} />
          <Route path="todo" element={<PageGate permission="todo:access"><TodoPage /></PageGate>} />

          {/* Team */}
          <Route path="team" element={<PageGate permission="team:manage"><TeamManagement /></PageGate>} />

          {/* Ops (admin) */}
          <Route path="support" element={<PageGate permission="support:access"><SupportPage /></PageGate>} />
          <Route path="api-runs" element={<PageGate permission="api-runs:access"><ApiRunsPage /></PageGate>} />
          <Route path="ops-dashboard" element={<PageGate permission="ops-dashboard:access"><OpsDashboardPage /></PageGate>} />
          <Route path="scrape-runs" element={<PageGate permission="scrape-runs:access"><ScrapeRunsPage /></PageGate>} />
          <Route path="status" element={<PageGate permission="status:access"><StatusPage /></PageGate>} />
        </Route>

        {/* Public supplier route (token-based auth via query param) */}
        <Route path="/supplier/cost-sheet" element={<SupplierPublicSheet />} />

        {/* Redirects */}
        <Route path="/" element={<Navigate to="/app/dashboard" replace />} />
        <Route path="/dashboard" element={<Navigate to="/app/dashboard" replace />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}
