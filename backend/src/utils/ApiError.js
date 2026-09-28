// An error that is safe to show to API clients. Anything else that is thrown
// becomes a generic 500 response, so internal details never leak.
class ApiError extends Error {
  constructor(statusCode, message, errors) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.errors = errors;
  }

  static badRequest(message, errors) {
    return new ApiError(400, message, errors);
  }

  static notFound(message = 'Resource not found') {
    return new ApiError(404, message);
  }
}

module.exports = ApiError;
