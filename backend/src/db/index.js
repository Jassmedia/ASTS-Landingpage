const { createSupabaseDatabase } = require('./supabaseDatabase');
const { createLocalDatabase } = require('./localDatabase');

/**
 * Picks the database:
 *  - Supabase when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set
 *  - otherwise the local in-memory PostgreSQL (development only)
 *
 * Both expose the same { kind, rpc(fn, args), close() } interface, so the
 * repositories don't know or care which one is in use.
 */
async function createDatabase(config) {
  const { url, serviceRoleKey } = config.supabase;

  if (url || serviceRoleKey) {
    if (!url || !serviceRoleKey) {
      throw new Error('Set both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or leave both empty to use the local database.');
    }
    return createSupabaseDatabase({ url, serviceRoleKey });
  }

  if (config.env === 'production') {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in production.');
  }
  return createLocalDatabase();
}

module.exports = { createDatabase };
