const crypto = require('crypto');
const ApiError = require('../utils/ApiError');

const sha256 = value => crypto.createHash('sha256').update(value).digest();

/**
 * Protects admin endpoints (dashboard data, registration list/update/delete).
 * Clients send:  Authorization: Bearer <ADMIN_API_KEY>
 *
 * With no ADMIN_API_KEY set, admin endpoints stay open in development (so
 * local testing is easy) and are refused in production.
 */
function createRequireAdmin({ adminApiKey, env }) {
  const expected = adminApiKey ? sha256(adminApiKey) : null;

  return function requireAdmin(req, res, next) {
    if (!expected) {
      if (env === 'production') return next(new ApiError(503, 'Admin access is not configured'));
      return next();
    }
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    // Compare hashes so the check takes the same time whatever the input
    if (token && crypto.timingSafeEqual(sha256(token), expected)) return next();
    next(new ApiError(401, 'Unauthorized'));
  };
}

module.exports = { createRequireAdmin };
