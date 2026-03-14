import userRoutes from './users.js';
import departmentRoutes from './departments.js';
import auditRoutes from './audit.js';
import settingsRoutes from './settings.js';

const mountRoutes = (app) => {
  app.use('/api/v1/users', userRoutes);
  app.use('/api/v1/departments', departmentRoutes);
  app.use('/api/v1/audit-logs', auditRoutes);
  app.use('/api/v1/settings', settingsRoutes);
};

export default mountRoutes;
