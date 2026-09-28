// Wraps a database failure. The error handler logs it and returns a generic
// 500, so SQL messages and table details never reach API clients.
class DatabaseError extends Error {
  constructor(operation, cause = {}) {
    super(`Database call ${operation} failed: ${cause.message || 'unknown error'}`);
    this.name = 'DatabaseError';
    this.operation = operation;
    this.code = cause.code;
  }
}

module.exports = DatabaseError;
