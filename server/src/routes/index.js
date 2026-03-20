import userRoutes from './users.js';
import departmentRoutes from './departments.js';
import auditRoutes from './audit.js';
import settingsRoutes from './settings.js';
import magicWriterRoutes from './magicWriter.js';
import creativeIntelRoutes from './creativeIntel.js';
import briefAgentRoutes from './briefAgent.js';
import iterationKingRoutes from './iterationKing.js';
import creativeAnalysisRoutes from './creativeAnalysis.js';
import staticsGenerationRoutes from './staticsGeneration.js';
import productProfileRoutes from './productProfiles.js';

const mountRoutes = (app) => {
  app.use('/api/v1/users', userRoutes);
  app.use('/api/v1/departments', departmentRoutes);
  app.use('/api/v1/audit-logs', auditRoutes);
  app.use('/api/v1/settings', settingsRoutes);
  app.use('/api/v1/magic-writer', magicWriterRoutes);
  app.use('/api/v1/creative-intel', creativeIntelRoutes);
  app.use('/api/v1/brief-agent', briefAgentRoutes);
  app.use('/api/v1/iteration-king', iterationKingRoutes);
  app.use('/api/v1/creative-analysis', creativeAnalysisRoutes);
  app.use('/api/v1/statics-generation', staticsGenerationRoutes);
  app.use('/api/v1/product-profiles', productProfileRoutes);
};

export default mountRoutes;
