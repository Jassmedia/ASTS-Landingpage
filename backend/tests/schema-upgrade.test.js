// Re-running supabase/schema.sql on a database made by the earlier version
// (manual lead statuses) must upgrade it cleanly and keep every registration.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SCHEMA = fs.readFileSync(path.resolve(__dirname, '../supabase/schema.sql'), 'utf8');

test('upgrades a database that still has the manual status column', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create();
  try {
    // The earlier version's registrations table and status functions
    await db.exec(`
      create table public.registrations (
        id uuid primary key default gen_random_uuid(), session_id text, submission_id text unique,
        name text not null, phone text not null, email text, city text not null, course text not null,
        status text not null default 'new' check (status in ('new','contacted','interested','registered','not_interested')),
        source text not null default 'direct', created_at timestamptz not null default now(),
        updated_at timestamptz not null default now());
      insert into public.registrations (name, phone, city, course, status) values ('Old Lead', '9876543210', 'Pune', 'Oracle EPBCS', 'contacted');
      create function public.asts_update_registration_status(p_id uuid, p_status text) returns jsonb language sql as $$ select null::jsonb $$;
      create function public.asts_list_registrations(p_from timestamptz default null, p_to timestamptz default null, p_course text default null,
        p_city text default null, p_status text default null, p_source text default null, p_limit integer default null)
        returns jsonb language sql as $$ select '[]'::jsonb $$;
      create function public.asts_dashboard_stats(p_from timestamptz default null, p_to timestamptz default null, p_course text default null,
        p_city text default null, p_status text default null, p_source text default null, p_tz text default 'UTC')
        returns jsonb language sql as $$ select '{}'::jsonb $$;
    `);

    await db.exec(SCHEMA);

    const columns = await db.query(`select column_name from information_schema.columns where table_name = 'registrations'`);
    assert.ok(!columns.rows.some(c => c.column_name === 'status'), 'status column removed');

    const leftovers = await db.query(`
      select p.oid::regprocedure::text as fn from pg_proc p
      where p.proname in ('asts_update_registration_status', 'asts_list_registrations', 'asts_dashboard_stats')`);
    assert.deepEqual(leftovers.rows.map(r => r.fn).sort(), [
      'asts_dashboard_stats(timestamp with time zone,timestamp with time zone,text,text,text,text)',
      'asts_list_registrations(timestamp with time zone,timestamp with time zone,text,text,text,integer)'
    ], 'old status functions are gone; one version of each function remains');

    const { rows } = await db.query('select public.asts_list_registrations() as result');
    assert.deepEqual(rows[0].result.map(r => r.name), ['Old Lead'], 'existing registrations are kept');

    const stats = await db.query('select public.asts_dashboard_stats() as result');
    assert.equal(stats.rows[0].result.registrations, 1);
  } finally {
    await db.close();
  }
});
