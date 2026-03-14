import userRoutes from './users.js';
import departmentRoutes from './departments.js';
import auditRoutes from './audit.js';
import settingsRoutes from './settings.js';
import magicWriterRoutes from './magicWriter.js';
import creativeIntelRoutes from './creativeIntel.js';

const mountRoutes = (app) => {
  app.use('/api/v1/users', userRoutes);
  app.use('/api/v1/departments', departmentRoutes);
  app.use('/api/v1/audit-logs', auditRoutes);
  app.use('/api/v1/settings', settingsRoutes);
  app.use('/api/v1/magic-writer', magicWriterRoutes);
  app.use('/api/v1/creative-intel', creativeIntelRoutes);
};

export default mountRoutes;
