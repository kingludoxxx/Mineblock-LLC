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
import pageVersionsRoutes from './pageVersions.js';
import pageLibraryRoutes from './pageLibrary.js';
import shopifyVariantsRoutes from './shopifyVariants.js';
import aiPageGenerateRoutes from './aiPageGenerate.js';
import pageThumbnailsRoutes from './pageThumbnails.js';
import splitTestsRoutes from './splitTests.js';
import trackingAdminRoutes from './trackingAdmin.js';
import domainHubRoutes from './domainHub.js';
import funnelAnalyticsRoutes from './funnelAnalytics.js';
import aiDeveloperRoutes from './aiDeveloper.js';
import aiMediaRoutes from './aiMedia.js';
import integrationsRoutes from './integrations.js';
import liveViewRoutes from './liveView.js';
import funnelTransferRoutes from './funnelTransfer.js';
import funnelCostsRoutes from './funnelCosts.js';
import healthAlertsRoutes from './healthAlerts.js';
import funnelMetricsRoutes from './funnelMetrics.js';
import funnelAttributionRoutes from './funnelAttribution.js';
import funnelTrackingExtrasRoutes from './funnelTrackingExtras.js';
import funnelCommerceRoutes from './funnelCommerce.js';

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
  // Funnel tracking EXTRAS — mounted on the SAME base as funnelsRoutes and
  // BEFORE it, so /funnels/:id/tracking/health|custom are served without
  // entering the funnels router. Its auth chain is per-route (not router.use),
  // so every other /funnels/* path falls straight through at zero cost.
  app.use('/api/v1/funnels', funnelTrackingExtrasRoutes);
  app.use('/api/v1/funnels', funnelsRoutes);
  app.use('/api/v1/page-clone', pageCloneRoutes); // clone-a-page scan + create (authed, funnels permission)
  app.use('/api/v1/page-versions', pageVersionsRoutes); // builder page snapshots + restore (authed, funnels permission; owns lb_page_versions)
  app.use('/api/v1/page-library', pageLibraryRoutes); // saved reusable page snapshots + clone-into-any-funnel (authed, funnels permission; owns funnel_page_library, clones always land DRAFT)
  app.use('/api/v1/shopify-variants', shopifyVariantsRoutes); // builder product/variant typeahead (authed, funnels permission; read-only Shopify Admin proxy, writes nothing)
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
  // AI Media dialog — Higgsfield image generation whose finished assets are
  // RE-HOSTED into lb_media, so the library stays the single source of truth
  // (authed, funnels permission; owns lb_ai_media_jobs, never writes pages).
  app.use('/api/v1/ai-media', aiMediaRoutes);
  app.use('/api/v1/integrations', integrationsRoutes); // KLAVIYO LANE: marketing-integration config (authed, funnels permission; masked reads)
  app.use('/api/v1/live', liveViewRoutes); // LIVE-VIEW LANE: single additive mount (SSE + snapshot, isolated analytics pool)
  // Funnel export/import — portable JSON envelope (authed, funnels permission;
  // import always lands a DRAFT with no domain, in one transaction).
  app.use('/api/v1/funnel-transfer', funnelTransferRoutes);
  app.use('/api/v1/funnel-costs', funnelCostsRoutes); // COGS / per-funnel P&L (authed, funnels permission; on-read engine, append-only rates)
  app.use('/api/v1/health-alerts', healthAlertsRoutes); // PLATFORM: operational alert feed + ack (authed, audit:read; 5-min sweep starts on load, HEALTH_ALERTS_SWEEP_DISABLED=1 off)
  // METRICS ENGINE — the one query API + presets + dashboard composite (authed,
  // funnels permission; read-only, isolated analytics pool, REPORT_TZ buckets).
  app.use('/api/v1/funnel-metrics', funnelMetricsRoutes);
  app.use('/api/v1/funnel-attribution', funnelAttributionRoutes); // ATTRIBUTION LANE: last-touch marketing breakdowns, ROAS, click ledger (authed, funnels permission; isolated analytics pool, read-only, Europe/Madrid days)
  // Settings → Commerce: Shopify catalog snapshot, Shopify↔Whop product map,
  // read-only Shopify shipping zones (authed, funnels permission; additive —
  // prices are DISPLAY data, the checkout re-prices server-side).
  app.use('/api/v1/funnel-commerce', funnelCommerceRoutes);
  // MEDIA LIBRARY routes are mounted in app.js, AHEAD of the global body
  // parser, so the router's own 7mb cap is real (see app.js media mount).
};

export default mountRoutes;
