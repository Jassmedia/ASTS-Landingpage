const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const defaultConfig = require('./config');
const { createApiRouter } = require('./routes');
const { createRequireAdmin } = require('./middleware/requireAdmin');
const { createRateLimiter } = require('./middleware/rateLimiter');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');

const DASHBOARD_DIR = path.resolve(__dirname, '../public/dashboard');

/**
 * Builds the Express app from ready-made services (see src/services).
 * @param {object} options
 * @param {object} options.services    from buildServices()
 * @param {object} [options.config]    defaults to src/config
 * @param {boolean} [options.rateLimit] set false in tests
 */
function createApp({ services, config = defaultConfig, rateLimit = true }) {
  const app = express();
  app.set('trust proxy', config.trustProxy);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        // Plain http://localhost would break if the browser upgraded requests to https
        upgradeInsecureRequests: config.env === 'production' ? [] : null
      }
    }
  }));
  app.use(cors({
    origin: config.corsOrigins,
    methods: ['GET', 'POST', 'PATCH', 'DELETE']
  }));
  // The landing page sends JSON without a Content-Type header (so the
  // browser sends text/plain and skips a CORS pre-check). Parse both as JSON.
  app.use(express.json({ limit: config.bodyLimit, type: ['application/json', 'text/plain'] }));

  const limiters = {
    track: createRateLimiter({ windowMs: 60 * 1000, limit: config.rateLimit.trackPerMinute, enabled: rateLimit }),
    registrations: createRateLimiter({ windowMs: 10 * 60 * 1000, limit: config.rateLimit.registrationsPer10Min, enabled: rateLimit })
  };
  const requireAdmin = createRequireAdmin({ adminApiKey: config.adminApiKey, env: config.env });

  app.use('/api', createApiRouter({ services, requireAdmin, limiters }));

  // Admin dashboard (static page; its data comes from /api/admin with the admin key)
  app.use('/dashboard', express.static(DASHBOARD_DIR));
  app.get('/', (req, res) => res.redirect('/dashboard/'));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
