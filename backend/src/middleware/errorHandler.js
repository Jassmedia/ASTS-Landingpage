const ApiError = require('../utils/ApiError');

// Errors raised by express.json() while reading the request body
const BODY_ERRORS = {
  'entity.parse.failed': [400, 'Invalid JSON in request body'],
  'entity.too.large': [413, 'Request body is too large']
};

// Central error handler: every error ends up here and gets a consistent
// { success: false, message } shape. Unexpected errors are logged on the
// server but clients only ever see a generic message.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err instanceof ApiError) {
    const body = { success: false, message: err.message };
    if (err.errors) body.errors = err.errors;
    return res.status(err.statusCode).json(body);
  }

  if (BODY_ERRORS[err.type]) {
    const [status, message] = BODY_ERRORS[err.type];
    return res.status(status).json({ success: false, message });
  }

  // Other client errors from Express/body-parser (e.g. unsupported charset)
  if (err.expose && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ success: false, message: 'Invalid request' });
  }

  console.error('[error]', req.method, req.originalUrl, err);
  res.status(500).json({ success: false, message: 'Internal server error' });
}

module.exports = errorHandler;
