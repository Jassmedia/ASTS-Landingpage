const fs = require('fs');
const path = require('path');
const DatabaseError = require('../utils/DatabaseError');

const SCHEMA_PATH = path.resolve(__dirname, '../../supabase/schema.sql');
const SAFE_NAME = /^[a-z_][a-z0-9_]*$/;

/**
 * LOCAL DEVELOPMENT DATABASE: a real PostgreSQL engine (PGlite) running
 * inside Node, with no install or account needed. It runs the same
 * supabase/schema.sql as Supabase, so behaviour matches production.
 *
 * Data lives in memory and is lost when the backend restarts.
 * Used only when Supabase isn't configured, and never in production.
 */
async function createLocalDatabase() {
  let PGlite;
  try {
    ({ PGlite } = await import('@electric-sql/pglite'));
  } catch {
    throw new Error('Local database needs dev dependencies. Run "npm install" in the backend folder, or set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }

  const db = await PGlite.create();
  // Match Supabase, which runs in UTC
  await db.exec(`set timezone = 'UTC';`);
  await db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));

  return {
    kind: 'local',

    // Same contract as supabase.rpc(): call a function with named arguments
    async rpc(fn, args = {}) {
      const names = Object.keys(args).filter(name => args[name] !== undefined);
      if (![fn, ...names].every(name => SAFE_NAME.test(name))) {
        throw new DatabaseError(fn, { message: 'Invalid function or argument name' });
      }
      const placeholders = names.map((name, i) => `${name} => $${i + 1}`).join(', ');
      try {
        const { rows } = await db.query(`select public.${fn}(${placeholders}) as result`, names.map(n => args[n]));
        return rows[0].result;
      } catch (err) {
        throw new DatabaseError(fn, err);
      }
    },

    close: () => db.close()
  };
}

module.exports = { createLocalDatabase };
