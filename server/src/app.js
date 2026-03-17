import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';

import corsOptions from './config/cors.js';
import env from './config/env.js';
import { apiLimiter } from './middleware/rateLimiter.js';
import errorHandler from './middleware/errorHandler.js';
import logger from './utils/logger.js';

import healthRoutes from './routes/health.js';
import dashboardRoutes from './routes/dashboard.js';
import authRoutes from './routes/auth.js';
import mountRoutes from './routes/index.js';
import clickupWebhookRoutes from './routes/clickupWebhook.js';
import departmentRegistry from './departments/registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Trust proxy (Render runs behind a reverse proxy)
app.set('trust proxy', 1);

// Security headers
app.use(helmet());

// CORS
app.use(cors(corsOptions));

// Request logging
const morganFormat = env.NODE_ENV === 'production' ? 'combined' : 'dev';
app.use(morgan(morganFormat, {
  stream: { write: (message) => logger.info(message.trim()) },
}));

// Body parsing
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// Cookies
app.use(cookieParser());

// ClickUp webhook (before rate limiter — webhooks should not be throttled)
app.use('/api/v1/clickup-webhook', clickupWebhookRoutes);

// Rate limiting on all API routes
app.use('/api', apiLimiter);

// API routes
app.use('/api/health', healthRoutes);      // top-level health check
app.use('/api/v1/health', healthRoutes);   // versioned health check
app.use('/api/v1/dashboard', dashboardRoutes);
app.use('/api/v1/auth', authRoutes);
app.use('/api/auth', authRoutes);       // alias for client compatibility

// Mount CRUD routes (users, departments, audit, settings)
mountRoutes(app);


// Mount department modules
app.use('/api/v1/departments/modules', departmentRegistry.getRouter());

// Serve static files from client build in production
const clientDistPath = path.resolve(__dirname, '../../client/dist');
app.use(express.static(clientDistPath));

// SPA fallback: serve index.html for any non-API route
app.get('/{*splat}', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ success: false, error: { message: 'API route not found' } });
  }
  res.sendFile(path.join(clientDistPath, 'index.html'));
});

// Error handler (must be last)
app.use(errorHandler);

export default app;
