const { createClient } = require('@supabase/supabase-js');
const DatabaseError = require('../utils/DatabaseError');

// Connects with the service-role key. This key bypasses Row Level Security,
// so it must only ever live on the server (never in the landing page).
function createSupabaseDatabase({ url, serviceRoleKey }) {
  const client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });

  return {
    kind: 'supabase',

    async rpc(fn, args = {}) {
      const { data, error } = await client.rpc(fn, args);
      if (error) throw new DatabaseError(fn, error);
      return data;
    },

    async close() {}
  };
}

module.exports = { createSupabaseDatabase };
