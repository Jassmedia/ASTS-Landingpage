const express = require('express');
const { getHealth } = require('../controllers/healthController');
const { createRegistrationRouter } = require('./registrationRoutes');
const { createTrackingRouter } = require('./trackingRoutes');
const { createAdminRouter } = require('./adminRoutes');

// Everything mounted here is served under /api
function createApiRouter({ services, requireAdmin, limiters }) {
  const router = express.Router();
  router.get('/health', getHealth);
  router.use('/track', createTrackingRouter({ trackingService: services.tracking, limiter: limiters.track }));
  router.use('/registrations', createRegistrationRouter({
    registrationService: services.registrations,
    requireAdmin,
    limiter: limiters.registrations
  }));
  router.use('/admin', createAdminRouter({ services, requireAdmin }));
  return router;
}

module.exports = { createApiRouter };
