const ApiError = require('../utils/ApiError');

// Runs a validator on the request body. On success, req.body is replaced with
// the cleaned, whitelisted value so controllers never see unexpected fields.
const validateBody = validator => (req, res, next) => {
  const { value, errors } = validator(req.body);
  if (errors) return next(ApiError.badRequest('Validation failed', errors));
  req.body = value;
  next();
};

module.exports = validateBody;
