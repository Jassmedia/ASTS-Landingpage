const ApiError = require('../utils/ApiError');

// Validates req.query and stores the cleaned filters in res.locals.query
// (in Express 5 req.query is read-only).
const validateQuery = validator => (req, res, next) => {
  const { value, errors } = validator(req.query);
  if (errors) return next(ApiError.badRequest('Validation failed', errors));
  res.locals.query = value;
  next();
};

module.exports = validateQuery;
