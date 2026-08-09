import userRoutes from './users.js';
import departmentRoutes from './departments.js';
import auditRoutes from './audit.js';
import settingsRoutes from './settings.js';
import creativeIntelRoutes from './creativeIntel.js';
import briefAgentRoutes from './briefAgent.js';
import iterationKingRoutes from './iterationKing.js';
import creativeAnalysisRoutes from './creativeAnalysis.js';
import staticsGenerationRoutes from './staticsGeneration.js';
import productProfileRoutes from './productProfiles.js';
import adRejectionMonitorRoutes from './adRejectionMonitor.js';
import kpiSystemRoutes from './kpiSystem.js';
import adsControlCenterRoutes from './adsControlCenter.js';
import advertorialRoutes from './advertorialPipeline.js';
import adLauncherRoutes from './adLauncher.js';
import staticsTemplatesRoutes from './staticsTemplates.js';
import videoAdsLauncherRoutes from './videoAdsLauncher.js';
import teamRoutes from './team.js';
import languagesPipelineRoutes from './languagesPipeline.js';
import adsReportingRoutes from './adsReporting.js';
import brandSpyRoutes from './brandSpy.js';
import ordersRoutes from './orders.js';
import customersRoutes from './customers.js';
import abandonedRoutes from './abandonedCheckouts.js';
import checkoutAdminRoutes from './checkoutAdmin.js';
import funnelsRoutes from './funnels.js';
import pageCloneRoutes from './pageClone.js';
import aiPageGenerateRoutes from './aiPageGenerate.js';
import pageThumbnailsRoutes from './pageThumbnails.js';
import splitTestsRoutes from './splitTests.js';
import trackingAdminRoutes from './trackingAdmin.js';
import domainHubRoutes from './domainHub.js';
import funnelAnalyticsRoutes from './funnelAnalytics.js';
import aiDeveloperRoutes from './aiDeveloper.js';

const mountRoutes = (app) => {
  app.use('/api/v1/users', userRoutes);
  app.use('/api/v1/team', teamRoutes);
  app.use('/api/v1/departments', departmentRoutes);
  app.use('/api/v1/audit-logs', auditRoutes);
  app.use('/api/v1/settings', settingsRoutes);
  app.use('/api/v1/creative-intel', creativeIntelRoutes);
  app.use('/api/v1/brief-agent', briefAgentRoutes);
  app.use('/api/v1/iteration-king', iterationKingRoutes);
  app.use('/api/v1/creative-analysis', creativeAnalysisRoutes);
  app.use('/api/v1/statics-generation', staticsGenerationRoutes);
  app.use('/api/v1/product-profiles', productProfileRoutes);
  app.use('/api/v1/ad-rejection-monitor', adRejectionMonitorRoutes);
  app.use('/api/v1/kpi-system', kpiSystemRoutes);
  app.use('/api/v1/ads-control', adsControlCenterRoutes);
  app.use('/api/v1/advertorial', advertorialRoutes);
  app.use('/api/v1/ad-launcher', adLauncherRoutes);
  app.use('/api/v1/statics-templates', staticsTemplatesRoutes);
  app.use('/api/v1/video-ads-launcher', videoAdsLauncherRoutes);
  app.use('/api/v1/languages-pipeline', languagesPipelineRoutes);
  app.use('/api/v1/ads-reporting', adsReportingRoutes);
  app.use('/api/v1/brand-spy', brandSpyRoutes);
  app.use('/api/v1/orders', ordersRoutes);
  app.use('/api/v1/customers', customersRoutes);
  app.use('/api/v1/abandoned', abandonedRoutes);
  app.use('/api/v1/funnels', funnelsRoutes);
  app.use('/api/v1/page-clone', pageCloneRoutes); // clone-a-page scan + create (authed, funnels permission)
  app.use('/api/v1/ai-generate', aiPageGenerateRoutes); // Generate-with-AI page build stream (authed, funnels permission; never writes funnel_pages)
  app.use('/api/v1/page-thumbnails', pageThumbnailsRoutes); // canvas node miniatures (authed, funnels permission; fail-open 204)
  app.use('/api/v1/checkout', checkoutAdminRoutes); // authed CRM surface (public /checkout/public mounted earlier in app.js)
  app.use('/api/v1/tracking-admin', trackingAdminRoutes); // authed attribution read surface (public /track mounted earlier in app.js)
  app.use('/api/v1/split-tests', splitTestsRoutes); // authed A/B test CRUD + results (credits ledger)
  app.use('/api/v1/domain-hub', domainHubRoutes); // authed custom-domain buy/attach/manage (verify sweep starts on load)
  // Reporting only — reads through its OWN small pool (analyticsDb) with a
  // server-side statement_timeout and no circuit-breaker participation, so a
  // slow report can never starve or trip the money path's shared pool.
  app.use('/api/v1/funnel-analytics', funnelAnalyticsRoutes);
  // AI Developer — builder chat that PROPOSES block edits (read-only on
  // funnel_pages; the editor applies ops in memory) + Higgsfield job proxy.
  app.use('/api/v1/ai-developer', aiDeveloperRoutes);
};

export default mountRoutes;
