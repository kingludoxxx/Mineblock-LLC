import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import ProtectedRoute from './components/auth/ProtectedRoute';
import AppLayout from './components/layout/AppLayout';

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
import MagicWriterPage from './pages/production/MagicWriter';
import MagicAdsPage from './pages/production/MagicAdsPage';
import IterationKingPage from './pages/production/IterationKingPage';
import ImagesPage from './pages/production/ImagesPage';
import VideoPage from './pages/production/VideoPage';
import AudioPage from './pages/production/AudioPage';
import StaticsGenerationPage from './pages/production/StaticsGenerationPage';

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
          <Route path="meta" element={<MetaPage />} />
          <Route path="google" element={<GooglePage />} />
          <Route path="youtube" element={<YouTubePage />} />
          <Route path="tiktok-ads" element={<TikTokAdsPage />} />
          <Route path="tiktok-shop" element={<TikTokShopPage />} />
          <Route path="tiktok-organic" element={<TikTokOrganicPage />} />
          <Route path="brands" element={<BrandsPage />} />
          <Route path="brands/:id" element={<BrandDetailPage />} />
          <Route path="following" element={<FollowingPage />} />
          <Route path="saved" element={<SavedPage />} />
          <Route path="creative-intelligence" element={<CreativeIntelligencePage />} />

          {/* Lab */}
          <Route path="avatars" element={<AvatarsPage />} />
          <Route path="mechanisms" element={<MechanismsPage />} />
          <Route path="offers" element={<OffersPage />} />
          <Route path="products" element={<ProductsPage />} />
          <Route path="funnels" element={<FunnelsPage />} />

          {/* Production */}
          <Route path="brief-agent" element={<BriefAgentPage />} />
          <Route path="magic-writer" element={<MagicWriterPage />} />
          <Route path="magic-ads" element={<MagicAdsPage />} />
          <Route path="iteration-king" element={<IterationKingPage />} />
          <Route path="images" element={<ImagesPage />} />
          <Route path="video" element={<VideoPage />} />
          <Route path="audio" element={<AudioPage />} />
          <Route path="statics-generation" element={<StaticsGenerationPage />} />

          {/* Performance */}
          <Route path="creative-analysis" element={<CreativeAnalysisPage />} />
          <Route path="kpi-system" element={<KpiDashboard />} />
          <Route path="kpi-system/cost-sheet" element={<SupplierCostSheet />} />
          <Route path="kpi-system/fees" element={<FeeBreakdown />} />
          <Route path="attribution" element={<AttributionPage />} />
          <Route path="live" element={<LivePage />} />
          <Route path="ltv" element={<LtvPage />} />
          <Route path="roas" element={<RoasPage />} />
          <Route path="ads-control-center" element={<AdsControlCenter />} />

          {/* Library */}
          <Route path="team-hub" element={<TeamHubPage />} />
          <Route path="assets" element={<AssetsPage />} />
          <Route path="todo" element={<TodoPage />} />

          {/* Ops (admin) */}
          <Route path="support" element={<SupportPage />} />
          <Route path="api-runs" element={<ApiRunsPage />} />
          <Route path="ops-dashboard" element={<OpsDashboardPage />} />
          <Route path="scrape-runs" element={<ScrapeRunsPage />} />
          <Route path="status" element={<StatusPage />} />
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
