const ApiError = require('../utils/ApiError');

const notFound = (req, res, next) => next(ApiError.notFound('Route not found'));

module.exports = notFound;
