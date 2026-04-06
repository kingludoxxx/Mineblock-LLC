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

const mountRoutes = (app) => {
  app.use('/api/v1/users', userRoutes);
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
};

export default mountRoutes;
