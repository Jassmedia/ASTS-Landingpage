const express = require('express');
const { createAdminController } = require('../controllers/adminController');
const validateQuery = require('../middleware/validateQuery');
const { validateReportQuery } = require('../utils/validation');

// Everything under /api/admin requires the admin key
function createAdminRouter({ services, requireAdmin }) {
  const router = express.Router();
  const controller = createAdminController(services);
  const filters = validateQuery(validateReportQuery);

  router.use(requireAdmin);
  router.get('/session', controller.getSession);
  // ?from=&to=&tz=&course=&city=&status=&source=
  router.get('/dashboard', filters, controller.getDashboard);
  // ?from=&to=&source=
  router.get('/clicked-not-registered', filters, controller.getClickedNotRegistered);
  router.get('/sheets', controller.getSheetsStatus);
  router.post('/sheets/sync', controller.syncSheets);

  return router;
}

module.exports = { createAdminRouter };
