-- =====================================================================
-- ASTS Training: database schema (Supabase / PostgreSQL 15+)
--
-- How to apply: Supabase dashboard -> SQL Editor -> New query ->
-- paste this whole file -> Run. Safe to run again: it only creates what
-- is missing and replaces the functions.
--
-- The backend talks to the database only through the asts_* functions
-- below, using the service-role key (server-side only). Row Level
-- Security is on with no policies, so the public anon key can't read or
-- write anything.
--
-- The local development database (PGlite) runs this same file.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

-- One row per anonymous visitor (session). Refreshes don't add rows.
create table if not exists public.visitors (
  id          uuid        primary key default gen_random_uuid(),
  session_id  text        not null unique,
  page        text        not null default '/',
  source      text        not null default 'direct',
  device      text        not null default 'unknown',
  visited_at  timestamptz not null default now()
);

-- Every tracked action. Page views and clicks are counted from here.
create table if not exists public.events (
  id          uuid        primary key default gen_random_uuid(),
  session_id  text        not null,
  event_type  text        not null check (event_type in
                ('page_view', 'demo_button_click', 'form_started', 'registration_submitted')),
  page        text        not null default '/',
  created_at  timestamptz not null default now()
);

create index if not exists events_created_at_idx   on public.events (created_at);
create index if not exists events_session_type_idx on public.events (session_id, event_type);
-- form_started is stored at most once per session
create unique index if not exists events_form_started_once
  on public.events (session_id) where event_type = 'form_started';

-- Completed Book Free Demo registrations. Every row is a REGISTERED person;
-- there is no manual status. A visitor's state (CLICKED or REGISTERED) is
-- worked out automatically from events + registrations.
create table if not exists public.registrations (
  id             uuid        primary key default gen_random_uuid(),
  session_id     text,
  -- One ID per form submission, sent by the page. A double-click resends
  -- the same ID, so it can't create a second registration.
  submission_id  text        unique,
  name           text        not null,
  phone          text        not null,
  email          text,
  city           text        not null,
  course         text        not null,
  source         text        not null default 'direct',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists registrations_created_at_idx on public.registrations (created_at);
create index if not exists registrations_session_idx    on public.registrations (session_id);

-- Upgrade from the earlier version that had manual lead statuses
-- (new / contacted / interested / ...). Those are no longer used.
drop function if exists public.asts_update_registration_status(uuid, text);
drop function if exists public.asts_list_registrations(timestamptz, timestamptz, text, text, text, text, integer);
drop function if exists public.asts_dashboard_stats(timestamptz, timestamptz, text, text, text, text, text);
alter table public.registrations drop column if exists status;

alter table public.visitors      enable row level security;
alter table public.events        enable row level security;
alter table public.registrations enable row level security;

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

-- Friendly anonymous label shown instead of the raw session ID, e.g. V-7F3A2C91
create or replace function public.asts_visitor_label(p_session_id text)
returns text
language sql immutable
set search_path = public
as $$
  select 'V-' || upper(substr(md5(p_session_id), 1, 8))
$$;

-- ---------------------------------------------------------------------
-- Tracking
-- ---------------------------------------------------------------------

-- Records page_view, demo_button_click or form_started.
-- Creates the visitor row on first sight; form_started is kept once per session.
create or replace function public.asts_track_event(
  p_session_id text,
  p_event_type text,
  p_page       text default '/',
  p_source     text default 'direct',
  p_device     text default 'unknown'
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_visitor visitors;
  v_event   events;
begin
  if p_event_type not in ('page_view', 'demo_button_click', 'form_started') then
    raise exception 'Unsupported event type: %', p_event_type using errcode = '22023';
  end if;

  insert into visitors (session_id, page, source, device)
  values (p_session_id, coalesce(p_page, '/'), coalesce(p_source, 'direct'), coalesce(p_device, 'unknown'))
  on conflict (session_id) do nothing
  returning * into v_visitor;

  if p_event_type = 'form_started' then
    insert into events (session_id, event_type, page)
    values (p_session_id, p_event_type, coalesce(p_page, '/'))
    on conflict (session_id) where event_type = 'form_started' do nothing
    returning * into v_event;
  else
    insert into events (session_id, event_type, page)
    values (p_session_id, p_event_type, coalesce(p_page, '/'))
    returning * into v_event;
  end if;

  return jsonb_build_object(
    'recorded',   v_event.id is not null,
    'event',      case when v_event.id is not null then to_jsonb(v_event) end,
    'newVisitor', case when v_visitor.id is not null then to_jsonb(v_visitor) end,
    'visitor', (
      select jsonb_build_object('label', asts_visitor_label(v.session_id), 'source', v.source, 'device', v.device)
      from visitors v where v.session_id = p_session_id
    )
  );
end
$$;

-- ---------------------------------------------------------------------
-- Registrations
-- ---------------------------------------------------------------------

-- Saves a registration and its registration_submitted event together.
-- If the same submission_id was already saved, returns that row instead.
create or replace function public.asts_create_registration(
  p_submission_id text,
  p_session_id    text,
  p_name          text,
  p_phone         text,
  p_email         text,
  p_city          text,
  p_course        text,
  p_source        text default null,
  p_page          text default '/',
  p_device        text default 'unknown'
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_reg registrations;
begin
  if p_submission_id is not null then
    select * into v_reg from registrations where submission_id = p_submission_id;
    if found then
      return jsonb_build_object('created', false, 'registration', to_jsonb(v_reg));
    end if;
  end if;

  if p_session_id is not null then
    insert into visitors (session_id, page, source, device)
    values (p_session_id, coalesce(p_page, '/'), coalesce(p_source, 'direct'), coalesce(p_device, 'unknown'))
    on conflict (session_id) do nothing;
  end if;

  insert into registrations (submission_id, session_id, name, phone, email, city, course, source)
  values (
    p_submission_id, p_session_id, p_name, p_phone, p_email, p_city, p_course,
    coalesce(p_source, (select v.source from visitors v where v.session_id = p_session_id), 'direct')
  )
  on conflict (submission_id) do nothing
  returning * into v_reg;

  if v_reg.id is null then
    -- The same submission was saved a moment earlier (e.g. a double-click)
    select * into v_reg from registrations where submission_id = p_submission_id;
    return jsonb_build_object('created', false, 'registration', to_jsonb(v_reg));
  end if;

  if p_session_id is not null then
    insert into events (session_id, event_type, page)
    values (p_session_id, 'registration_submitted', coalesce(p_page, '/'));
  end if;

  return jsonb_build_object('created', true, 'registration', to_jsonb(v_reg));
end
$$;

create or replace function public.asts_list_registrations(
  p_from   timestamptz default null,
  p_to     timestamptz default null,
  p_course text        default null,
  p_city   text        default null,
  p_source text        default null,
  p_limit  integer     default null
)
returns jsonb
language sql stable
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc), '[]'::jsonb)
  from (
    select * from registrations r
    where (p_from   is null or r.created_at >= p_from)
      and (p_to     is null or r.created_at <  p_to)
      and (p_course is null or r.course = p_course)
      and (p_city   is null or lower(r.city) = lower(p_city))
      and (p_source is null or r.source = p_source)
    order by r.created_at desc
    limit p_limit
  ) r
$$;

create or replace function public.asts_get_registration(p_id uuid)
returns jsonb
language sql stable
set search_path = public
as $$
  select to_jsonb(r) from registrations r where r.id = p_id
$$;

create or replace function public.asts_delete_registration(p_id uuid)
returns boolean
language sql
set search_path = public
as $$
  with deleted as (delete from registrations where id = p_id returning 1)
  select exists (select 1 from deleted)
$$;

-- ---------------------------------------------------------------------
-- Dashboard analytics
-- ---------------------------------------------------------------------

-- All dashboard numbers for a date range.
--  * Visitor and click numbers use the date and source filters.
--  * Registration numbers also use course and city.
--  * Automatic state per person: REGISTERED if their session has ever
--    registered, otherwise CLICKED if they clicked Book Free Demo. Someone
--    who clicked and later registered is only ever REGISTERED.
create or replace function public.asts_dashboard_stats(
  p_from   timestamptz default null,
  p_to     timestamptz default null,
  p_course text        default null,
  p_city   text        default null,
  p_source text        default null,
  p_tz     text        default 'UTC'
)
returns jsonb
language sql stable
set search_path = public
as $$
  with ev as (
    select e.session_id, e.event_type, e.created_at
    from events e
    left join visitors v on v.session_id = e.session_id
    where (p_from is null or e.created_at >= p_from)
      and (p_to   is null or e.created_at <  p_to)
      and (p_source is null or coalesce(v.source, 'direct') = p_source)
  ),
  reg as (
    select r.id, r.session_id, r.created_at
    from registrations r
    where (p_from   is null or r.created_at >= p_from)
      and (p_to     is null or r.created_at <  p_to)
      and (p_course is null or r.course = p_course)
      and (p_city   is null or lower(r.city) = lower(p_city))
      and (p_source is null or r.source = p_source)
  ),
  people as (
    select ev.session_id,
           bool_or(ev.event_type = 'demo_button_click') as clicked,
           exists (select 1 from registrations r where r.session_id = ev.session_id) as registered
    from ev
    group by ev.session_id
  ),
  daily as (
    select day, sum(visitors)::int as visitors, sum(clickers)::int as clickers, sum(registrations)::int as registrations
    from (
      select (created_at at time zone p_tz)::date as day,
             count(distinct session_id) as visitors,
             count(distinct session_id) filter (where event_type = 'demo_button_click') as clickers,
             0 as registrations
      from ev group by 1
      union all
      select (created_at at time zone p_tz)::date, 0, 0, count(*)
      from reg group by 1
    ) x
    group by day
  )
  select jsonb_build_object(
    'uniqueVisitors',     (select count(distinct session_id) from ev),
    'pageViews',          (select count(*) from ev where event_type = 'page_view'),
    'uniqueDemoClickers', (select count(distinct session_id) from ev where event_type = 'demo_button_click'),
    'totalDemoClicks',    (select count(*) from ev where event_type = 'demo_button_click'),
    'formStarts',         (select count(distinct session_id) from ev where event_type = 'form_started'),
    'registrations',      (select count(*) from reg),
    'registeredPeople',   (select count(distinct coalesce(session_id, id::text)) from reg),
    'people', (
      select jsonb_build_object(
        'registered', count(*) filter (where registered),
        'clicked',    count(*) filter (where clicked and not registered),
        'visited',    count(*) filter (where not clicked and not registered))
      from people
    ),
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object(
        'date', day, 'visitors', visitors, 'clickers', clickers, 'registrations', registrations) order by day)
      from daily
    ), '[]'::jsonb)
  )
$$;

-- People who clicked Book Free Demo in the range but have never registered
create or replace function public.asts_clicked_not_registered(
  p_from   timestamptz default null,
  p_to     timestamptz default null,
  p_source text        default null,
  p_limit  integer     default 500
)
returns jsonb
language sql stable
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.last_clicked_at desc), '[]'::jsonb)
  from (
    select asts_visitor_label(e.session_id)  as visitor,
           min(e.created_at)                 as first_clicked_at,
           max(e.created_at)                 as last_clicked_at,
           count(*)::int                     as clicks,
           coalesce(v.source, 'direct')      as source,
           coalesce(v.device, 'unknown')     as device
    from events e
    left join visitors v on v.session_id = e.session_id
    where e.event_type = 'demo_button_click'
      and (p_from is null or e.created_at >= p_from)
      and (p_to   is null or e.created_at <  p_to)
      and (p_source is null or coalesce(v.source, 'direct') = p_source)
      and not exists (select 1 from registrations r where r.session_id = e.session_id)
    group by e.session_id, v.source, v.device
    order by max(e.created_at) desc
    limit p_limit
  ) x
$$;

-- Values for the dashboard's filter dropdowns
create or replace function public.asts_filter_options()
returns jsonb
language sql stable
set search_path = public
as $$
  select jsonb_build_object(
    'courses', coalesce((select jsonb_agg(c order by c) from (select distinct course c from registrations) a), '[]'::jsonb),
    'cities',  coalesce((select jsonb_agg(c order by c) from (select distinct initcap(city) c from registrations) b), '[]'::jsonb),
    'sources', coalesce((select jsonb_agg(s order by s) from (
                 select source s from visitors union select source from registrations) c), '[]'::jsonb)
  )
$$;

-- ---------------------------------------------------------------------
-- Exports for the Google Sheets full sync
-- ---------------------------------------------------------------------

create or replace function public.asts_export_visitors(p_limit integer default 50000)
returns jsonb
language sql stable
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.visited_at), '[]'::jsonb)
  from (
    select visited_at, asts_visitor_label(session_id) as visitor, page, source, device
    from visitors order by visited_at limit p_limit
  ) x
$$;

-- Everything except page views: clicks, form starts and submissions
create or replace function public.asts_export_events(p_limit integer default 50000)
returns jsonb
language sql stable
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at), '[]'::jsonb)
  from (
    select e.created_at, asts_visitor_label(e.session_id) as visitor, e.event_type, e.page,
           coalesce(v.source, 'direct') as source, coalesce(v.device, 'unknown') as device
    from events e
    left join visitors v on v.session_id = e.session_id
    where e.event_type <> 'page_view'
    order by e.created_at limit p_limit
  ) x
$$;

-- ---------------------------------------------------------------------
-- Permissions: only the server (service_role) may call these functions
-- ---------------------------------------------------------------------
do $$
declare
  fn text;
  r  text;
begin
  for fn in
    select p.oid::regprocedure::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'asts\_%'
  loop
    execute format('revoke all on function %s from public', fn);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on function %s from %I', fn, r);
      end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', fn);
    end if;
  end loop;

  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.visitors, public.events, public.registrations from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on public.visitors, public.events, public.registrations to service_role;
  end if;
end
$$;

-- Tell Supabase's API to pick up the new functions right away
notify pgrst, 'reload schema';
