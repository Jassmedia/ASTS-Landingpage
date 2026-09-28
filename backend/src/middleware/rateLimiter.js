const { rateLimit } = require('express-rate-limit');

// Per-IP limit for public endpoints (tracking and registration) so bots
// can't flood the database. Pass enabled=false to turn it off (tests).
function createRateLimiter({ windowMs, limit, enabled = true }) {
  if (!enabled) return (req, res, next) => next();
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => {
      res.status(429).json({ success: false, message: 'Too many requests. Please try again in a few minutes.' });
    }
  });
}

module.exports = { createRateLimiter };
