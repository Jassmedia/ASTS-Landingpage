const crypto = require('crypto');

// Friendly anonymous label shown instead of the raw session ID, e.g. V-7F3A2C91.
// Same formula as asts_visitor_label() in supabase/schema.sql.
function visitorLabel(sessionId) {
  const hash = crypto.createHash('md5').update(String(sessionId)).digest('hex');
  return `V-${hash.slice(0, 8).toUpperCase()}`;
}

module.exports = { visitorLabel };
