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
import metaWebhookRoutes from './routes/metaWebhook.js';
import shopifyWebhookRoutes from './routes/shopifyWebhook.js';
import departmentRegistry from './departments/registry.js';
import briefPipelineRouter from './routes/briefPipeline.js';
import salesToolsRouter from './routes/salesTools.js';
import brandSpyRouter from './routes/brandSpy.js';
import funnelPublicRoutes from './routes/funnelPublic.js';
import gatewayWebhookRoutes from './routes/gatewayWebhooks.js';
import checkoutPublicRoutes from './routes/checkoutPublic.js';
import optinPublicRoutes from './routes/optinPublic.js';
import mediaRoutes from './routes/media.js';
import trackingPostbackPublicRoutes from './routes/trackingPostbackPublic.js';
import { customDomainMiddleware } from './services/domainHub/hostRouting.js';
import trackingPublicRoutes from './routes/trackingPublic.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Trust proxy (Render runs behind a reverse proxy)
app.set('trust proxy', 1);

// Security headers (disable CSP to allow Meta iframe previews + CDN images)
app.use(helmet({
  contentSecurityPolicy: false,
}));

// CORS
app.use(cors(corsOptions));

// Request logging. The checkout session id travels as ?s= on funnel pages; it
// identifies a buyer's order, so it must not be persisted in the log stream.
// Redact it (and its aliases) from the logged line — the request itself is
// untouched.
const REDACT_QS = /([?&](?:s|session|session_id)=)[^&\s"]+/gi;
const morganFormat = env.NODE_ENV === 'production' ? 'combined' : 'dev';
app.use(morgan(morganFormat, {
  stream: { write: (message) => logger.info(message.trim().replace(REDACT_QS, '$1[redacted]')) },
}));

// Capture raw body for Shopify webhook HMAC verification (must come before json parser)
app.use('/api/v1/shopify-webhook', express.json({
  limit: '50mb',
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString('utf8');
  },
}));

// Gateway (Stripe/Whop) settlement webhooks — MUST be before the global JSON
// parser: the router installs its own express.json({verify}) to capture
// req.rawBody for signature verification. Behind the global parser, rawBody
// is never set and every signed webhook fails closed (silent no-settle).
app.use('/api/v1/gateway-webhooks', gatewayWebhookRoutes);

// TRACKING-LANE HOOK: public tracking intake — unauthenticated by necessity
// (the visitor is not a user), defended inside the router (per-IP limiter,
// origin allow-list, server-side consent gate, fail-open). Mounted BEFORE the
// global 50mb JSON parser so the router's OWN 256kb body cap actually applies
// (behind the global parser it would be a no-op), and before the apiLimiter
// like the other public mounts.
app.use('/api/v1/track', trackingPublicRoutes);

// Public checkout intake — unauthenticated by necessity (the buyer is not a
// user), defended inside the router (per-IP limiter, origin allow-list,
// server-side re-pricing). Mounted BEFORE the global 50mb parser so the
// router's OWN 1mb cap applies; behind it a 2mb body was fully parsed and the
// documented cap was a no-op (unauthenticated-surface DoS). Still before the
// admin /api/v1/checkout mount so /checkout/public is not shadowed by it.
app.use('/api/v1/checkout/public', checkoutPublicRoutes);

// Public opt-in lead intake — same reasoning: its own 64kb cap only applies
// ahead of the global parser.
app.use('/api/v1/optin/public', optinPublicRoutes);

// Media library — parses its OWN body (7mb cap) so uploads can't buffer 50mb
// through the global parser; must sit ahead of it like the intakes above.
app.use('/api/v1/media', mediaRoutes);

// Inbound ad-network postbacks — PUBLIC at the root because the URL is
// hand-pasted into ad networks' postback fields. Must sit ahead of the global
// parser so the router's own 32kb cap is real (proven executable by
// tracking/s2s-integrations-e2e E11b — behind the 50mb parser the cap goes
// inert). The token in the path is the only credential; anti-probing answers
// one byte-identical {"ok":true} for every outcome.
app.use('/pb', trackingPostbackPublicRoutes);

// Body parsing
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Cookies
app.use(cookieParser());

// Webhooks (before rate limiter — webhooks should not be throttled)
app.use('/api/v1/clickup-webhook', clickupWebhookRoutes);
// Short alias used by the Frame.io OAuth callback URI registered in Adobe IMS
app.use('/api/v1/webhook', clickupWebhookRoutes);
app.use('/api/v1/meta-webhook', metaWebhookRoutes);
app.use('/api/v1/shopify-webhook', shopifyWebhookRoutes);

// (public checkout + opt-in intakes are mounted above, ahead of the global
// body parser, so their own body caps are not no-ops)

// Custom-domain host routing — rewrites a CONNECTED custom host to its funnel's
// /f/<slug> path so funnelPublic serves it unchanged (same publish gates).
// Fronts every request, so it is deliberately inert and fail-open: app hosts
// short-circuit before any DB access, implausible hosts are rejected
// syntactically (no query, no cache entry), /api + /f + assets pass through,
// and any error falls through to next(). Must sit BEFORE /f and the SPA fallback.
app.use(customDomainMiddleware());

// Public funnel pages — unauthenticated, gated by FUNNEL_PUBLIC_ENABLED at
// request time inside the router (before API routes, outside auth).
app.use('/f', funnelPublicRoutes);

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

app.use('/api/v1/brief-pipeline', briefPipelineRouter);
app.use(salesToolsRouter);

// Brand Spy proxy — forwards to brand-spy-api.onrender.com
app.use('/api/v1/brand-spy', brandSpyRouter);

// Mount department modules
app.use('/api/v1/departments/modules', departmentRegistry.getRouter());

// Serve upsell pages as static files
const upsellsPath = path.resolve(__dirname, '../../upsells');
app.use('/upsells', express.static(upsellsPath));

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
