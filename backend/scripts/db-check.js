// Checks that Supabase is reachable and supabase/schema.sql has been applied.
// Usage: npm run db:check
const config = require('../src/config');
const { createDatabase } = require('../src/db');

async function main() {
  if (!config.supabase.url || !config.supabase.serviceRoleKey) {
    console.log('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set in backend/.env.');
    console.log('The backend will use the local development database.');
    process.exit(1);
  }

  const db = await createDatabase(config);
  console.log(`Checking Supabase at ${new URL(config.supabase.url).host} ...`);

  const checks = [
    ['asts_dashboard_stats', {}],
    ['asts_filter_options', {}],
    ['asts_list_registrations', { p_limit: 1 }],
    ['asts_clicked_not_registered', { p_limit: 1 }]
  ];
  let ok = true;
  for (const [fn, args] of checks) {
    try {
      await db.rpc(fn, args);
      console.log(`  OK    ${fn}`);
    } catch (err) {
      ok = false;
      console.log(`  FAIL  ${fn}: ${err.message}`);
    }
  }

  if (ok) {
    const stats = await db.rpc('asts_dashboard_stats', {});
    console.log(`\nConnected. ${stats.uniqueVisitors} visitors, ${stats.registrations} registrations so far.`);
  } else {
    console.log('\nRun backend/supabase/schema.sql in the Supabase SQL Editor, then try again.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Could not connect:', err.message);
  process.exit(1);
});
