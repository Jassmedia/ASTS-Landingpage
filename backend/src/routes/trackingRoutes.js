const express = require('express');
const { createTrackingController } = require('../controllers/trackingController');
const validateBody = require('../middleware/validateBody');
const { validateTrackEvent } = require('../utils/validation');

// navigator.sendBeacon sends "no-cors" requests from the landing page's
// origin. Helmet's default Cross-Origin-Resource-Policy (same-origin) makes
// the browser reject those responses with a console error, so this public
// endpoint allows cross-origin reads. The response contains no data.
const allowCrossOriginBeacon = (req, res, next) => {
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
};

function createTrackingRouter({ trackingService, limiter }) {
  const router = express.Router();
  const controller = createTrackingController(trackingService);
  router.post('/', allowCrossOriginBeacon, limiter, validateBody(validateTrackEvent), controller.track);
  return router;
}

module.exports = { createTrackingRouter };
