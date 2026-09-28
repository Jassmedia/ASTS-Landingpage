const express = require('express');
const { createRegistrationController } = require('../controllers/registrationController');
const { REGISTRATION_NOT_FOUND } = require('../services/registrationService');
const validateBody = require('../middleware/validateBody');
const validateQuery = require('../middleware/validateQuery');
const validateId = require('../middleware/validateId');
const { validateRegistration, validateReportQuery } = require('../utils/validation');

/**
 * POST is public (the registration form). Reading and deleting registrations
 * involves personal data, so those require the admin key. There is no status
 * update: a visitor's state (CLICKED / REGISTERED) is automatic.
 */
function createRegistrationRouter({ registrationService, requireAdmin, limiter }) {
  const router = express.Router();
  const controller = createRegistrationController(registrationService);

  router.param('id', validateId(REGISTRATION_NOT_FOUND));

  router
    .route('/')
    .post(limiter, validateBody(validateRegistration), controller.create)
    // Optional filters: ?from=&to=&course=&city=&source=
    .get(requireAdmin, validateQuery(validateReportQuery), controller.list);

  router
    .route('/:id')
    .get(requireAdmin, controller.getById)
    .delete(requireAdmin, controller.remove);

  return router;
}

module.exports = { createRegistrationRouter };
