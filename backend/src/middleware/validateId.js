const ApiError = require('../utils/ApiError');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// IDs are UUIDs. Rejecting malformed ones here means a database repository
// later never receives an ID it can't parse (Postgres would throw on it).
const validateId = message => (req, res, next, id) => {
  if (!UUID_PATTERN.test(id)) return next(ApiError.notFound(message));
  next();
};

module.exports = validateId;
